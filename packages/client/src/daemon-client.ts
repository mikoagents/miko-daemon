import { ProviderSnapshotUpdates } from "./provider-snapshots/index.js";

import type { SessionEventSubscription } from "@getpaseo/protocol/messages";

import { ConnectionSubscriptions, DEFAULT_CLIENT_CAPABILITIES } from "./connection/index.js";

import type { z } from "zod";

import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";

import {
  parseServerInfoStatusPayload,
  RestartRequestedStatusPayloadSchema,
  SessionInboundMessageSchema,
  ShutdownRequestedStatusPayloadSchema,
  type ServerInfoStatusPayload,
} from "@getpaseo/protocol/messages";

import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";

import type {
  AgentStreamEventPayload,
  DaemonConfigReloadResponse,
  DaemonGetStatusResponse,
  FetchAgentTimelineResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListProviderModelsResponseMessage,
  ProviderDiagnosticResponseMessage,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";

import { isRelayClientWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";

import { asUint8Array } from "@getpaseo/protocol/binary-frames/index";

import {
  createWebSocketTransportFactory,
  decodeMessageData,
  defaultWebSocketFactory,
  describeTransportClose,
  describeTransportError,
  type DaemonTransport,
  type DaemonTransportFactory,
  type WebSocketFactory,
} from "./daemon-client-transport.js";

import { DaemonClientRuntimeMetrics } from "./daemon-client-runtime-metrics.js";

import {
  normalizeListProviderModelsPayload,
  normalizeProviderSnapshotUpdateMessage,
  normalizeProvidersSnapshotPayload,
} from "./compat/normalize-provider-models.js";

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const consoleLogger: Logger = {
  debug: () => {},
  info: (obj, msg) => console.log(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

const perfNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

function normalizePassword(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length > 0 ? value : null;
}

function extractCorrelatedResponseIdentity(input: unknown): CorrelatedResponseIdentity | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const envelope = input as { type?: unknown; message?: unknown };
  if (envelope.type !== "session" || !envelope.message || typeof envelope.message !== "object") {
    return null;
  }

  const message = envelope.message as { type?: unknown; payload?: unknown };
  if (
    typeof message.type !== "string" ||
    !(
      message.type === "rpc_error" ||
      message.type.endsWith("_response") ||
      message.type.endsWith(".response") ||
      message.type.endsWith("/response")
    )
  ) {
    return null;
  }
  if (!message.payload || typeof message.payload !== "object") {
    return null;
  }

  const payload = message.payload as { requestId?: unknown };
  if (typeof payload.requestId !== "string") {
    return null;
  }

  return {
    requestId: payload.requestId,
    responseType: message.type,
  };
}

export type {
  DaemonTransport,
  DaemonTransportFactory,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client-transport.js";

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export type DaemonEvent =
  | {
      type: "agent_update";
      agentId: string;
      payload: Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
    }
  | {
      type: "workspace_update";
      workspaceId: string;
      payload: Extract<SessionOutboundMessage, { type: "workspace_update" }>["payload"];
    }
  | {
      type: "project.update";
      payload: Extract<SessionOutboundMessage, { type: "project.update" }>["payload"];
    }
  | {
      type: "workspace_setup_progress";
      workspaceId: string;
      payload: Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }>["payload"];
    }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEventPayload;
      timestamp: string;
      seq?: number;
      epoch?: string;
    }
  | { type: "status"; payload: { status: string } & Record<string, unknown> }
  | { type: "agent_deleted"; agentId: string }
  | {
      type: "agent_permission_request";
      agentId: string;
      request: AgentPermissionRequest;
    }
  | {
      type: "agent_permission_resolved";
      agentId: string;
      requestId: string;
      resolution: AgentPermissionResponse;
    }
  | {
      type: "providers_snapshot_update";
      payload: Extract<SessionOutboundMessage, { type: "providers_snapshot_update" }>["payload"];
    }
  | { type: "error"; message: string };

export type DaemonEventHandler = (event: DaemonEvent) => void;

export interface DaemonClientConfig {
  /** Deliver compact bodies/hash references to a caller-owned snapshot cache.
   * The default keeps public SDK snapshot entries expanded. */
  providerSnapshots?: "wire";
  url: string;
  clientId: string;
  clientType?: "mobile" | "browser" | "cli" | "mcp" | "hub";
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  transportFactory?: DaemonTransportFactory;
  webSocketFactory?: WebSocketFactory;
  logger?: Logger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
  trace?: DaemonClientTrace;
  capabilities?: Partial<Record<ClientCapability, unknown>>;
}

export interface DaemonClientTrace {
  isEnabled(): boolean;
  beginSection(name: string, args?: Record<string, string>): void;
  endSection(): void;
}

type ListProviderModelsPayload = ListProviderModelsResponseMessage["payload"];

type GetProvidersSnapshotPayload = GetProvidersSnapshotResponseMessage["payload"];

type ProviderDiagnosticPayload = ProviderDiagnosticResponseMessage["payload"];

type DaemonStatusPayload = DaemonGetStatusResponse["payload"];

export type FetchAgentTimelinePayload = FetchAgentTimelineResponseMessage["payload"];

export type FetchAgentTimelineDirection = FetchAgentTimelinePayload["direction"];

export type FetchAgentTimelineProjection = FetchAgentTimelinePayload["projection"];

export type FetchAgentTimelineCursor = NonNullable<FetchAgentTimelinePayload["startCursor"]>;

export interface FetchAgentTimelineOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  mergeWindow?: boolean;
  requestId?: string;
  timeout?: number;
}

type RestartRequestedStatusPayload = z.infer<typeof RestartRequestedStatusPayloadSchema>;

type ShutdownRequestedStatusPayload = z.infer<typeof ShutdownRequestedStatusPayloadSchema>;

export interface ShutdownServerOptions {
  requestId?: string;
  timeout?: number;
}

export interface DaemonStatusOptions {
  requestId?: string;
  timeout?: number;
}

interface Waiter<T> {
  predicate: (msg: SessionOutboundMessage) => T | null;
  resolve(value: T): void;
  reject(error: Error): void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  requestId?: string;
}

interface WaitHandle<T> {
  promise: Promise<T>;
  cancel: (error: Error) => void;
}

interface WaitOptions {
  skipQueue?: boolean;
  requestId?: string;
}

interface CorrelatedResponseIdentity {
  requestId: string;
  responseType?: string;
}

type RpcWaitResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: DaemonRpcError };

type GetDaemonConfigResponse = Extract<
  SessionOutboundMessage,
  { type: "get_daemon_config_response" }
>;

type SetDaemonConfigResponse = Extract<
  SessionOutboundMessage,
  { type: "set_daemon_config_response" }
>;

type CorrelatedResponseMessage =
  | Extract<SessionOutboundMessage, { payload: { requestId: string } }>
  | GetDaemonConfigResponse
  | SetDaemonConfigResponse;

type CorrelatedResponseType = CorrelatedResponseMessage["type"];

type CorrelatedResponsePayload<TType extends CorrelatedResponseType> = Extract<
  CorrelatedResponseMessage,
  { type: TType }
>["payload"];

class DaemonRpcError extends Error {
  readonly requestId: string;
  readonly requestType?: string;
  readonly code?: string;

  constructor(params: { requestId: string; error: string; requestType?: string; code?: string }) {
    const parts = [params.error];
    if (params.requestType) parts.push(`requestType=${params.requestType}`);
    if (params.code) parts.push(`code=${params.code}`);
    super(parts.join(" "));
    this.name = "DaemonRpcError";
    this.requestId = params.requestId;
    this.requestType = params.requestType;
    this.code = params.code;
  }
}

class DaemonProtocolError extends Error {
  readonly requestId: string;
  readonly responseType?: string;
  readonly code = "invalid_response";

  constructor(identity: CorrelatedResponseIdentity) {
    const responseLabel = identity.responseType ?? "unknown response";
    super(`Response validation failed for ${responseLabel}`);
    this.name = "DaemonProtocolError";
    this.requestId = identity.requestId;
    this.responseType = identity.responseType;
  }
}

class PingTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Ping timed out (${timeoutMs}ms)`);
    this.name = "PingTimeoutError";
  }
}

function toTimeoutError(error: unknown, label: string, timeoutMs: number): Error {
  if (error instanceof PingTimeoutError) {
    return new Error(`${label} timed out (${timeoutMs}ms)`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1500;

const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

const DEFAULT_SESSION_RPC_TIMEOUT_MS = 60_000;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const DEFAULT_LIVENESS_TIMEOUT_MS = 5000;

const LIVENESS_HEARTBEAT_INTERVAL_MS = 10_000;

const LIVENESS_HEARTBEAT_TIMEOUT_MS = 15_000;

const LIVENESS_FAILURE_RECONNECT_THRESHOLD = 2;

const DEFAULT_SEND_QUEUE_TIMEOUT_MS = DEFAULT_SESSION_RPC_TIMEOUT_MS;

function normalizeClientId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getTransportFrameSize(frame: string | Uint8Array | ArrayBuffer): number {
  if (typeof frame === "string") {
    return frame.length;
  }
  return frame.byteLength;
}

function describeInboundTransportFrame(
  frame: unknown,
  rawBytes: Uint8Array | null,
): Record<string, string> {
  if (typeof frame === "string") {
    return { kind: "text", size: String(frame.length) };
  }
  if (rawBytes) {
    return { kind: "binary", size: String(rawBytes.byteLength) };
  }
  return { kind: "unknown", size: "0" };
}

function hashForLog(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `h_${Math.abs(hash).toString(16)}`;
}

function toReasonCode(reason: string | null | undefined): string | null {
  if (!reason) {
    return null;
  }
  const normalized = reason.toLowerCase();
  if (normalized.includes("timed out")) {
    return "connect_timeout";
  }
  if (normalized.includes("disposed")) {
    return "disposed";
  }
  if (normalized.includes("client closed")) {
    return "client_closed";
  }
  if (normalized.includes("transport")) {
    return "transport_error";
  }
  if (normalized.includes("failed to connect")) {
    return "connect_failed";
  }
  return "unknown";
}

interface PendingSend {
  message: SessionInboundMessage;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface PingProbe {
  promise: Promise<number>;
  resolve: (value: number) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  startedAt: number;
  // Whether a timeout on this ping should be recorded as a liveness failure. Only the
  // heartbeat sets this; a latency measurement never drives teardown, even when a
  // heartbeat tick shares (dedupes onto) an in-flight measurement ping.
  drivesLivenessFailure: boolean;
}

export interface FetchAgentResult {
  agent: import("@getpaseo/protocol/messages").AgentSnapshotPayload;
  project: import("@getpaseo/protocol/messages").ProjectPlacementPayload | null;
}
export class DaemonClient {
  private readonly providerSnapshotUpdates = new ProviderSnapshotUpdates({
    fetch: (cwd) => this.requestProvidersSnapshot({ cwd }),
    emit: (message) => this.deliverSessionMessage(message),
    failed: (error) => this.logger.error({ err: error }, "Failed to resolve provider snapshot"),
  });

  private readonly subscriptions = new ConnectionSubscriptions({
    timelines: (agentIds) => (this.isConnected ? this.sendTimelineSubscription(agentIds) : null),
    events: (events) => this.sendEventSubscription(events),
    failed: (error) =>
      this.logger.error({ err: error }, "Failed to update connection subscriptions"),
  });

  private transport: DaemonTransport | null = null;

  private transportCleanup: Array<() => void> = [];

  private rawMessageListeners: Set<(message: SessionOutboundMessage) => void> = new Set();

  private messageHandlers: Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  > = new Map();

  private eventListeners: Set<DaemonEventHandler> = new Set();

  private waiters: Set<Waiter<unknown>> = new Set();

  private connectionListeners: Set<(status: ConnectionState) => void> = new Set();

  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private connectTimeout: ReturnType<typeof setTimeout> | null = null;

  private pendingGenericTransportErrorTimeout: ReturnType<typeof setTimeout> | null = null;

  private reconnectAttempt = 0;

  private shouldReconnect = true;

  private connectPromise: Promise<void> | null = null;

  private connectResolve: (() => void) | null = null;

  private connectReject: ((error: Error) => void) | null = null;

  private lastErrorValue: string | null = null;

  private connectionState: ConnectionState = { status: "idle" };

  private logger: Logger;

  private pendingSendQueue: PendingSend[] = [];

  private readonly logConnectionPath: "direct" | "relay";

  private readonly logServerId: string | null;

  private readonly logClientIdHash: string;

  private readonly logGeneration: number | null;

  private lastServerInfoMessage: ServerInfoStatusPayload | null = null;

  private runtimeMetricsInterval: ReturnType<typeof setInterval> | null = null;

  private runtimeMetrics: DaemonClientRuntimeMetrics | null = null;

  private pingProbe: PingProbe | null = null;

  private livenessHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  private lastLivenessRttMs: number | null = null;

  private consecutiveLivenessFailures = 0;

  constructor(private config: DaemonClientConfig) {
    this.logger = config.logger ?? consoleLogger;
    this.logConnectionPath = isRelayClientWebSocketUrl(this.config.url) ? "relay" : "direct";
    let parsedUrlForLog: URL | null = null;
    try {
      parsedUrlForLog = new URL(this.config.url);
    } catch {
      parsedUrlForLog = null;
    }
    const parsedServerIdForLog = normalizeClientId(parsedUrlForLog?.searchParams.get("serverId"));
    this.logServerId = parsedServerIdForLog ?? parsedUrlForLog?.host ?? null;
    const resolvedClientId = normalizeClientId(this.config.clientId);
    if (!resolvedClientId) {
      throw new Error("Daemon client requires a non-empty clientId");
    }
    this.config.clientId = resolvedClientId;
    this.logClientIdHash = hashForLog(resolvedClientId);
    this.logGeneration =
      typeof this.config.runtimeGeneration === "number" &&
      Number.isFinite(this.config.runtimeGeneration)
        ? this.config.runtimeGeneration
        : null;
    const runtimeMetricsIntervalMs =
      typeof config.runtimeMetricsIntervalMs === "number" && config.runtimeMetricsIntervalMs > 0
        ? config.runtimeMetricsIntervalMs
        : 0;
    if (runtimeMetricsIntervalMs > 0) {
      const runtimeMetricsWindowMs =
        typeof config.runtimeMetricsWindowMs === "number" && config.runtimeMetricsWindowMs > 0
          ? Math.max(config.runtimeMetricsWindowMs, runtimeMetricsIntervalMs)
          : undefined;
      this.runtimeMetrics = new DaemonClientRuntimeMetrics(
        this.logger,
        {
          connectionPath: this.logConnectionPath,
          serverId: this.logServerId,
          getConnectionStatus: () => this.connectionState.status,
        },
        runtimeMetricsWindowMs ? { windowMs: runtimeMetricsWindowMs } : undefined,
      );
      this.runtimeMetricsInterval = setInterval(() => {
        this.runtimeMetrics?.flush();
      }, runtimeMetricsIntervalMs);
    }
  }

  async connect(): Promise<void> {
    if (this.connectionState.status === "disposed") {
      throw new Error("Daemon client is disposed");
    }
    if (this.connectionState.status === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.shouldReconnect = true;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.attemptConnect();
    });

    return this.connectPromise;
  }

  private attemptConnect(): void {
    if (this.connectionState.status === "disposed") {
      this.rejectConnect(new Error("Daemon client is disposed"));
      return;
    }
    if (!this.shouldReconnect) {
      this.rejectConnect(new Error("Daemon client is closed"));
      return;
    }

    if (this.connectionState.status === "connecting") {
      return;
    }

    const headers: Record<string, string> = {};
    const password = normalizePassword(this.config.password);
    if (password) {
      headers.Authorization = `Bearer ${password}`;
    } else if (this.config.authHeader) {
      headers.Authorization = this.config.authHeader;
    }
    const protocols = password ? [`paseo.bearer.${password}`] : undefined;

    try {
      // Reconnect can overlap with browser close/error delivery ordering.
      // Always dispose previous transport before constructing the next one.
      this.disposeTransport();
      const baseTransportFactory =
        this.config.transportFactory ??
        createWebSocketTransportFactory(this.config.webSocketFactory ?? defaultWebSocketFactory);
      if (this.config.e2ee?.enabled)
        throw new Error("Relay E2EE is not included in Miko; use a direct ws/wss backend");
      const transportFactory = baseTransportFactory;
      const transportUrl = this.resolveTransportUrlForAttempt();
      const transport = transportFactory({
        url: transportUrl,
        headers,
        ...(protocols ? { protocols } : {}),
      });
      this.transport = transport;
      this.lastServerInfoMessage = null;

      this.updateConnectionState(
        {
          status: "connecting",
          attempt: this.reconnectAttempt,
        },
        { event: "CONNECT_REQUEST" },
      );
      this.resetConnectTimeout();
      const timeoutMs = Math.max(1, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      this.connectTimeout = setTimeout(() => {
        if (this.connectionState.status !== "connecting") {
          return;
        }
        this.lastErrorValue = "Connection timed out";
        this.disposeTransport(1001, "Connection timed out");
        this.scheduleReconnect({
          reason: "Connection timed out",
          event: "CONNECT_TIMEOUT",
          reasonCode: "connect_timeout",
        });
      }, timeoutMs);

      this.transportCleanup = [
        transport.onOpen(() => {
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          this.lastErrorValue = null;
          this.sendHelloMessage();
        }),
        transport.onClose((event) => {
          this.resetConnectTimeout();
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          const reason = describeTransportClose(event);
          if (reason) {
            this.lastErrorValue = reason;
          }
          this.scheduleReconnect({
            reason,
            event: "TRANSPORT_CLOSE",
            reasonCode: "transport_closed",
          });
        }),
        transport.onError((event) => {
          this.resetConnectTimeout();
          const reason = describeTransportError(event);
          const isGeneric = reason === "Transport error";
          // Browser WebSocket.onerror often provides no useful details and is followed
          // by a close event (often with code 1006). Prefer surfacing the close details
          // instead of immediately disconnecting with a generic "Transport error".
          if (isGeneric) {
            this.lastErrorValue ??= reason;
            if (!this.pendingGenericTransportErrorTimeout) {
              this.pendingGenericTransportErrorTimeout = setTimeout(() => {
                this.pendingGenericTransportErrorTimeout = null;
                if (
                  this.connectionState.status === "connected" ||
                  this.connectionState.status === "connecting"
                ) {
                  this.lastErrorValue = reason;
                  this.scheduleReconnect({
                    reason,
                    event: "TRANSPORT_ERROR",
                    reasonCode: "transport_error",
                  });
                }
              }, 250);
            }
            return;
          }

          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout);
            this.pendingGenericTransportErrorTimeout = null;
          }
          this.lastErrorValue = reason;
          this.scheduleReconnect({
            reason,
            event: "TRANSPORT_ERROR",
            reasonCode: "transport_error",
          });
        }),
        transport.onMessage((data) => this.handleTransportMessage(data)),
      ];
    } catch (error) {
      this.resetConnectTimeout();
      const message = error instanceof Error ? error.message : "Failed to connect";
      this.lastErrorValue = message;
      this.scheduleReconnect({
        reason: message,
        event: "CONNECT_FAILED",
        reasonCode: "connect_failed",
      });
      this.rejectConnect(error instanceof Error ? error : new Error(message));
    }
  }

  private resolveConnect(): void {
    if (this.connectResolve) {
      this.connectResolve();
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private rejectConnect(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  async close(): Promise<void> {
    if (this.connectionState.status === "disposed") {
      return;
    }
    this.shouldReconnect = false;
    this.subscriptions.close();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.resetConnectTimeout();
    this.disposeTransport(1000, "Client closed");
    this.providerSnapshotUpdates.clear();
    this.clearWaiters(new Error("Daemon client closed"));
    this.rejectPendingSendQueue(new Error("Daemon client closed"));
    this.rejectPingProbe(new Error("Daemon client closed"));

    this.lastServerInfoMessage = null;
    if (this.runtimeMetricsInterval) {
      clearInterval(this.runtimeMetricsInterval);
      this.runtimeMetricsInterval = null;
      this.runtimeMetrics?.flush({ final: true });
      this.runtimeMetrics = null;
    }
    this.updateConnectionState(
      { status: "disposed" },
      { event: "DISPOSE", reason: "Client closed", reasonCode: "disposed" },
    );
  }

  ensureConnected(): void {
    if (this.connectionState.status === "disposed") {
      return;
    }
    if (!this.shouldReconnect) {
      this.shouldReconnect = true;
    }
    if (
      this.connectionState.status === "connected" ||
      this.connectionState.status === "connecting"
    ) {
      return;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.connectPromise) {
      this.attemptConnect();
      return;
    }
    void this.connect();
  }

  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  get isConnected(): boolean {
    return this.connectionState.status === "connected";
  }

  get isConnecting(): boolean {
    return this.connectionState.status === "connecting";
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  subscribe(handler: DaemonEventHandler): () => void {
    this.eventListeners.add(handler);
    this.updateEventSubscriptions();
    return () => {
      this.eventListeners.delete(handler);
      this.updateEventSubscriptions();
    };
  }

  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.rawMessageListeners.add(handler);
    return () => {
      this.rawMessageListeners.delete(handler);
    };
  }

  on<TType extends SessionOutboundMessage["type"]>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void;

  on(handler: DaemonEventHandler): () => void;

  on(
    arg1: SessionOutboundMessage["type"] | DaemonEventHandler,
    arg2?: (message: SessionOutboundMessage) => void,
  ): () => void {
    if (typeof arg1 === "function") {
      return this.subscribe(arg1);
    }

    const type = arg1;
    const handler = arg2!;

    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    this.updateEventSubscriptions();

    return () => {
      const handlers = this.messageHandlers.get(type);
      if (!handlers) {
        return;
      }
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(type);
      }
      this.updateEventSubscriptions();
    };
  }

  private beginTraceSection(name: string, args?: Record<string, string>): boolean {
    const trace = this.config.trace;
    if (!trace?.isEnabled()) {
      return false;
    }
    trace.beginSection(name, args);
    return true;
  }

  private endTraceSection(isOpen: boolean): void {
    if (isOpen) {
      this.config.trace?.endSection();
    }
  }

  private traceInstant(name: string, args?: Record<string, string>): void {
    const isOpen = this.beginTraceSection(name, args);
    this.endTraceSection(isOpen);
  }

  private sendJsonMessage(envelopeType: string, messageType: string, message: unknown): void {
    this.traceInstant("paseo.ws.message.outbound", {
      envelopeType,
      messageType,
    });
    this.sendTransportFrame(JSON.stringify(message));
  }

  private sendTransportFrame(frame: string | Uint8Array | ArrayBuffer): void {
    if (!this.transport) {
      throw new Error("Transport not connected");
    }
    const isOpen = this.beginTraceSection("paseo.ws.frame.outbound", {
      kind: typeof frame === "string" ? "text" : "binary",
      size: String(getTransportFrameSize(frame)),
    });
    try {
      this.transport.send(frame);
    } finally {
      this.endTraceSection(isOpen);
    }
  }

  private sendSessionMessageOrThrow(message: SessionInboundMessage): Promise<void> {
    const status = this.connectionState.status;

    // If connected, send immediately
    if (this.transport && status === "connected") {
      const payload = SessionInboundMessageSchema.parse(message);
      this.sendJsonMessage("session", payload.type, { type: "session", message: payload });
      return Promise.resolve();
    }

    // If connecting, queue the message to be sent once connected
    if (status === "connecting") {
      return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          // Remove from queue
          const idx = this.pendingSendQueue.findIndex((p) => p.resolve === resolve);
          if (idx !== -1) {
            this.pendingSendQueue.splice(idx, 1);
          }
          reject(new Error(`Timed out waiting for connection to send message`));
        }, DEFAULT_SEND_QUEUE_TIMEOUT_MS);

        this.pendingSendQueue.push({ message, resolve, reject, timeoutHandle });
      });
    }

    // Not connected and not connecting - fail immediately
    return Promise.reject(new Error(`Transport not connected (status: ${status})`));
  }

  private flushPendingSendQueue(): void {
    const queue = this.pendingSendQueue;
    this.pendingSendQueue = [];

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle);
      try {
        if (this.transport && this.connectionState.status === "connected") {
          const payload = SessionInboundMessageSchema.parse(pending.message);
          this.sendJsonMessage("session", payload.type, { type: "session", message: payload });
          pending.resolve();
        } else {
          pending.reject(new Error("Connection lost before message could be sent"));
        }
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private rejectPendingSendQueue(error: Error): void {
    const queue = this.pendingSendQueue;
    this.pendingSendQueue = [];

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
    }
  }

  private async sendRequest<T>(params: {
    requestId: string;
    message: SessionInboundMessage;
    timeout?: number;
    select: (msg: SessionOutboundMessage) => T | null;
    options?: { skipQueue?: boolean };
  }): Promise<T> {
    const timeout = params.timeout ?? DEFAULT_SESSION_RPC_TIMEOUT_MS;
    const { promise, cancel } = this.waitForWithCancel<RpcWaitResult<T>>(
      (msg) => {
        if (msg.type === "rpc_error" && msg.payload.requestId === params.requestId) {
          return {
            kind: "error",
            error: new DaemonRpcError({
              requestId: msg.payload.requestId,
              error: msg.payload.error,
              requestType: msg.payload.requestType,
              code: msg.payload.code,
            }),
          };
        }
        const value = params.select(msg);
        if (value === null) {
          return null;
        }
        return { kind: "ok", value };
      },
      timeout,
      { ...params.options, requestId: params.requestId },
    );

    try {
      await this.sendSessionMessageOrThrow(params.message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      cancel(err);
      void promise.catch(() => undefined);
      throw err;
    }

    const result = await promise;
    if (result.kind === "error") {
      throw result.error;
    }
    return result.value;
  }

  private async sendCorrelatedRequest<
    TResponseType extends CorrelatedResponseType,
    TResult = CorrelatedResponsePayload<TResponseType>,
  >(params: {
    requestId: string;
    message: SessionInboundMessage;
    timeout?: number;
    responseType: TResponseType;
    options?: { skipQueue?: boolean };
    selectPayload?: (payload: CorrelatedResponsePayload<TResponseType>) => TResult | null;
  }): Promise<TResult> {
    return this.sendRequest({
      requestId: params.requestId,
      message: params.message,
      timeout: params.timeout,
      options: params.options,
      select: (msg) => {
        const correlated = msg as CorrelatedResponseMessage;
        if (correlated.type !== params.responseType) {
          return null;
        }
        const payload = correlated.payload as unknown as CorrelatedResponsePayload<TResponseType>;
        if (payload.requestId !== params.requestId) {
          return null;
        }
        if (!params.selectPayload) {
          return payload as TResult;
        }
        return params.selectPayload(payload);
      },
    });
  }

  private sendCorrelatedSessionRequest<
    TResponseType extends CorrelatedResponseType,
    TResult = CorrelatedResponsePayload<TResponseType>,
  >(params: {
    requestId?: string;
    message: { type: SessionInboundMessage["type"] } & Record<string, unknown>;
    responseType: TResponseType;
    timeout?: number;
    selectPayload?: (payload: CorrelatedResponsePayload<TResponseType>) => TResult | null;
  }): Promise<TResult> {
    const resolvedRequestId = this.createRequestId(params.requestId);
    const message = SessionInboundMessageSchema.parse({
      ...params.message,
      requestId: resolvedRequestId,
    });
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: params.responseType,
      timeout: params.timeout,
      options: { skipQueue: true },
      ...(params.selectPayload ? { selectPayload: params.selectPayload } : {}),
    });
  }

  private sendNamespacedCorrelatedSessionRequest<
    TResponseType extends CorrelatedResponseType,
    TResult = CorrelatedResponsePayload<TResponseType>,
  >(params: {
    requestId?: string;
    message: { type: Extract<SessionInboundMessage["type"], `${string}.request`> } & Record<
      string,
      unknown
    >;
    timeout?: number;
    selectPayload?: (payload: CorrelatedResponsePayload<TResponseType>) => TResult | null;
  }): Promise<TResult> {
    const responseType = params.message.type.replace(/\.request$/, ".response") as TResponseType;
    return this.sendCorrelatedSessionRequest({
      ...params,
      responseType,
    });
  }

  private async livenessPing(params?: { timeoutMs?: number }): Promise<number> {
    const timeoutMs = Math.max(1, params?.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS);
    try {
      const rttMs = await this.sendPingAwaitRtt({ timeoutMs, drivesLivenessFailure: true });
      this.lastLivenessRttMs = rttMs;
      return rttMs;
    } catch (error) {
      throw toTimeoutError(error, "Liveness check", timeoutMs);
    }
  }

  private sendPingAwaitRtt(params: {
    timeoutMs: number;
    drivesLivenessFailure: boolean;
  }): Promise<number> {
    if (this.connectionState.status !== "connected" || !this.transport) {
      return Promise.reject(
        new Error(`Transport not connected (status: ${this.connectionState.status})`),
      );
    }

    if (this.pingProbe) {
      return this.pingProbe.promise;
    }

    const startedAt = perfNow();
    const timeoutMs = params.timeoutMs;
    let resolveProbe: ((value: number) => void) | null = null;
    let rejectProbe: ((error: Error) => void) | null = null;
    const promise = new Promise<number>((resolve, reject) => {
      resolveProbe = resolve;
      rejectProbe = reject;
    });
    const probe: PingProbe = {
      promise,
      resolve: (value) => resolveProbe?.(value),
      reject: (error) => rejectProbe?.(error),
      timeoutHandle: setTimeout(() => {
        if (this.pingProbe !== probe) {
          return;
        }
        this.pingProbe = null;
        const error = new PingTimeoutError(timeoutMs);
        probe.reject(error);
        if (probe.drivesLivenessFailure) {
          this.recordLivenessFailure(toTimeoutError(error, "Liveness check", timeoutMs));
        }
      }, timeoutMs),
      startedAt,
      drivesLivenessFailure: params.drivesLivenessFailure,
    };
    this.pingProbe = probe;

    try {
      this.sendJsonMessage("ping", "ping", { type: "ping" });
    } catch (error) {
      this.clearPingProbe();
      const sendError = error instanceof Error ? error : new Error(String(error));
      if (probe.drivesLivenessFailure) {
        this.recordLivenessFailure(sendError);
      }
      return Promise.reject(sendError);
    }

    return promise;
  }

  private startLivenessHeartbeat(): void {
    this.stopLivenessHeartbeat();
    this.lastLivenessRttMs = null;
    this.scheduleNextLivenessHeartbeat();
  }

  private stopLivenessHeartbeat(): void {
    if (!this.livenessHeartbeatTimer) {
      return;
    }
    clearTimeout(this.livenessHeartbeatTimer);
    this.livenessHeartbeatTimer = null;
  }

  private scheduleNextLivenessHeartbeat(): void {
    if (this.connectionState.status !== "connected" || this.livenessHeartbeatTimer) {
      return;
    }
    this.livenessHeartbeatTimer = setTimeout(() => {
      this.livenessHeartbeatTimer = null;
      this.livenessPing({ timeoutMs: LIVENESS_HEARTBEAT_TIMEOUT_MS })
        .catch(() => {})
        .finally(() => {
          this.scheduleNextLivenessHeartbeat();
        });
    }, LIVENESS_HEARTBEAT_INTERVAL_MS);
  }

  async fetchAgent(
    agentId: string,
    options: { requestId?: string; timeout?: number } = {},
  ): Promise<FetchAgentResult | null> {
    const result = await this.sendCorrelatedSessionRequest({
      requestId: options.requestId,
      message: { type: "fetch_agent_request", agentId },
      responseType: "fetch_agent_response",
      timeout: options.timeout,
    });
    if (result.error) throw new Error(result.error);
    return result.agent ? { agent: result.agent, project: result.project ?? null } : null;
  }
  async fetchAgentTimeline(
    agentId: string,
    options: FetchAgentTimelineOptions = {},
  ): Promise<FetchAgentTimelinePayload> {
    const resolvedRequestId = this.createRequestId(options.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "fetch_agent_timeline_request",
      agentId,
      requestId: resolvedRequestId,
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(options.projection ? { projection: options.projection } : {}),
      ...(options.mergeWindow === true ? { mergeWindow: true } : {}),
    });

    const payload = await this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: options.timeout,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "fetch_agent_timeline_response") {
          return null;
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null;
        }
        return msg.payload;
      },
    });

    if (payload.error) {
      throw new Error(payload.error);
    }

    return payload;
  }

  private updateEventSubscriptions(): void {
    const events: SessionEventSubscription[] = [
      "project.update",
      "providers_snapshot_update",
      "agent_attention_required",
      "agent_permission_request",
      "agent_permission_resolved",
    ];
    if (this.eventListeners.size === 0 && !this.messageHandlers.has("providers_snapshot_update")) {
      this.providerSnapshotUpdates.clear();
    }
    this.subscriptions.setEvents(
      events.filter(
        (type) => this.eventListeners.size > 0 || (this.messageHandlers.get(type)?.size ?? 0) > 0,
      ),
    );
  }

  private async sendEventSubscription(events: SessionEventSubscription[]): Promise<void> {
    if (this.connectionState.status !== "connected") return;
    // COMPAT(explicitEventSubscriptions): added in v0.8.0, remove legacy broadcast handling after 2027-03-08.
    if (
      !this.lastServerInfoMessage?.features?.explicitEventSubscriptions ||
      this.config.capabilities?.[CLIENT_CAPS.explicitEventSubscriptions] === false
    )
      return;
    await this.sendCorrelatedSessionRequest({
      message: { type: "session.events.set_subscription.request", events },
      responseType: "session.events.set_subscription.response",
    });
  }

  private async sendTimelineSubscription(agentIds: string[]): Promise<void> {
    if (this.connectionState.status !== "connected") return;
    // COMPAT(selectiveAgentTimeline): added in v0.1.106. Old daemons keep their
    // legacy global stream and do not understand this RPC. Remove after
    // 2027-01-12 once the supported daemon floor is >= v0.1.106.
    if (!this.lastServerInfoMessage?.features?.selectiveAgentTimeline) {
      return;
    }

    const requestId = this.createRequestId();
    const normalizedAgentIds = [...new Set(agentIds)].sort();
    const message = SessionInboundMessageSchema.parse({
      type: "agent.timeline.set_subscription.request",
      agentIds: normalizedAgentIds,
      requestId,
    });

    await this.sendRequest({
      requestId,
      message,
      options: { skipQueue: true },
      select: (response) => {
        if (response.type !== "agent.timeline.set_subscription.response") {
          return null;
        }
        return response.payload.requestId === requestId ? response.payload : null;
      },
    });
  }

  async restartServer(reason?: string, requestId?: string): Promise<RestartRequestedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "restart_server_request",
      ...(reason && reason.trim().length > 0 ? { reason } : {}),
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const restarted = RestartRequestedStatusPayloadSchema.safeParse(msg.payload);
        if (!restarted.success) {
          return null;
        }
        if (restarted.data.requestId !== resolvedRequestId) {
          return null;
        }
        return restarted.data;
      },
    });
  }

  async shutdownServer(options?: ShutdownServerOptions): Promise<ShutdownRequestedStatusPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId);
    const message = SessionInboundMessageSchema.parse({
      type: "shutdown_server_request",
      requestId: resolvedRequestId,
    });
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: options?.timeout,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== "status") {
          return null;
        }
        const shutdown = ShutdownRequestedStatusPayloadSchema.safeParse(msg.payload);
        if (!shutdown.success) {
          return null;
        }
        if (shutdown.data.requestId !== resolvedRequestId) {
          return null;
        }
        return shutdown.data;
      },
    });
  }

  async listProviderModels(
    provider: AgentProvider,
    options?: { cwd?: string; requestId?: string },
  ): Promise<ListProviderModelsPayload> {
    const payload = await this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: "list_provider_models_request",
        provider,
        cwd: options?.cwd,
      },
      responseType: "list_provider_models_response",
      // Provider SDK cold starts (especially model discovery) can exceed 60s.
      timeout: 90000,
    });
    return normalizeListProviderModelsPayload(payload);
  }

  async getProvidersSnapshot(options?: {
    cwd?: string;
    ifNoneMatch?: string;
    requestId?: string;
  }): Promise<GetProvidersSnapshotPayload> {
    const payload = await this.requestProvidersSnapshot(options);
    return normalizeProvidersSnapshotPayload(payload, this.config.providerSnapshots !== "wire");
  }

  private requestProvidersSnapshot(options?: {
    cwd?: string;
    ifNoneMatch?: string;
    requestId?: string;
  }): Promise<GetProvidersSnapshotPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: "get_providers_snapshot_request",
        cwd: options?.cwd,
        ifNoneMatch: options?.ifNoneMatch,
      },
      responseType: "get_providers_snapshot_response",
    });
  }

  async getDaemonStatus(options?: DaemonStatusOptions): Promise<DaemonStatusPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: "daemon.get_status.request",
      },
      responseType: "daemon.get_status.response",
      timeout: options?.timeout,
    });
  }

  async reloadDaemonConfig(requestId?: string): Promise<DaemonConfigReloadResponse["payload"]> {
    this.requireDaemonConfigReloadSupport();
    return this.sendNamespacedCorrelatedSessionRequest({
      requestId,
      message: { type: "daemon.config.reload.request" },
    });
  }

  async connectHub(
    hubUrl: string,
    token: string,
    permissions: readonly string[] = [],
    requestId?: string,
  ) {
    this.requireHubRelationshipSupport();
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: { type: "hub.management.daemon.connect.request", hubUrl, token, permissions },
      responseType: "hub.management.daemon.connect.response",
    });
  }

  async updateHubPermissions(
    input: { grant?: readonly string[]; revoke?: readonly string[] },
    requestId?: string,
  ) {
    this.requireHubRelationshipSupport();
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: "hub.management.daemon.permissions.update.request",
        grant: input.grant ?? [],
        revoke: input.revoke ?? [],
      },
      responseType: "hub.management.daemon.permissions.update.response",
    });
  }

  async getHubStatus(requestId?: string) {
    this.requireHubRelationshipSupport();
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: { type: "hub.management.daemon.get_status.request" },
      responseType: "hub.management.daemon.get_status.response",
    });
  }

  async disconnectHub(force = false, requestId?: string) {
    this.requireHubRelationshipSupport();
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: { type: "hub.management.daemon.disconnect.request", force },
      responseType: "hub.management.daemon.disconnect.response",
    });
  }

  async getProviderDiagnostic(
    provider: AgentProvider,
    options?: { requestId?: string },
  ): Promise<ProviderDiagnosticPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: "provider_diagnostic_request",
        provider,
      },
      responseType: "provider_diagnostic_response",
      timeout: 180000,
    });
  }

  private createRequestId(requestId?: string): string {
    return requestId ?? crypto.randomUUID();
  }

  getLastServerInfoMessage(): ServerInfoStatusPayload | null {
    return this.lastServerInfoMessage;
  }

  private requireHubRelationshipSupport(): void {
    // COMPAT(hubRelationship): added in v0.1.X, drop the gate when floor >= v0.1.X.
    if (this.lastServerInfoMessage?.features?.hubRelationship !== true) {
      throw new Error("Update the host to use Hub relationship management.");
    }
  }

  private requireDaemonConfigReloadSupport(): void {
    // COMPAT(daemonConfigReload): added in v0.4.0, remove gate after 2027-02-14.
    if (this.lastServerInfoMessage?.features?.daemonConfigReload !== true) {
      throw new Error("Update the host to reload daemon configuration.");
    }
  }

  private resolveTransportUrlForAttempt(): string {
    return this.config.url;
  }

  private sendHelloMessage(): void {
    if (!this.transport) {
      this.scheduleReconnect({
        reason: "Transport unavailable before hello",
        event: "HELLO_TRANSPORT_MISSING",
        reasonCode: "transport_error",
      });
      return;
    }

    try {
      this.sendJsonMessage("hello", "hello", {
        type: "hello",
        clientId: this.config.clientId,
        clientType: this.config.clientType ?? "cli",
        protocolVersion: 1,
        capabilities: {
          ...DEFAULT_CLIENT_CAPABILITIES,
          ...this.config.capabilities,
        },
        ...(this.config.appVersion ? { appVersion: this.config.appVersion } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send hello message";
      this.lastErrorValue = message;
      this.scheduleReconnect({
        reason: message,
        event: "HELLO_SEND_FAILED",
        reasonCode: "transport_error",
      });
    }
  }

  private disposeTransport(code = 1001, reason = "Reconnecting"): void {
    this.providerSnapshotUpdates.pause();
    this.stopLivenessHeartbeat();
    this.cleanupTransport();
    if (this.transport) {
      try {
        this.transport.close(code, reason);
      } catch {
        // no-op
      }
      this.transport = null;
    }
  }

  private cleanupTransport(): void {
    this.resetConnectTimeout();
    if (this.pendingGenericTransportErrorTimeout) {
      clearTimeout(this.pendingGenericTransportErrorTimeout);
      this.pendingGenericTransportErrorTimeout = null;
    }
    for (const cleanup of this.transportCleanup) {
      try {
        cleanup();
      } catch {
        // no-op
      }
    }
    this.transportCleanup = [];
  }

  private resetConnectTimeout(): void {
    if (!this.connectTimeout) {
      return;
    }
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  private handleTransportMessage(data: unknown): void {
    const rawData =
      data && typeof data === "object" && "data" in data ? (data as { data: unknown }).data : data;

    if (
      typeof Blob !== "undefined" &&
      rawData instanceof Blob &&
      typeof rawData.arrayBuffer === "function"
    ) {
      void rawData
        .arrayBuffer()
        .then((buffer) => {
          this.handleTransportMessage(buffer);
          return;
        })
        .catch(() => {
          // Ignore failed blob decoding and allow reconnect logic to recover.
        });
      return;
    }

    const rawBytes = asUint8Array(rawData);
    const isOpen = this.beginTraceSection(
      "paseo.ws.frame.inbound",
      describeInboundTransportFrame(rawData, rawBytes),
    );
    try {
      const payload = decodeMessageData(rawData);
      if (!payload) {
        return;
      }
      this.handleJsonPayload(payload, rawBytes?.byteLength);
    } finally {
      this.endTraceSection(isOpen);
    }
  }

  private handleJsonPayload(payload: string, rawBytesLength: number | undefined): void {
    const bytes = rawBytesLength ?? payload.length;
    const startMs = perfNow();
    let parsedJson: unknown;
    const parseTraceOpen = this.beginTraceSection("paseo.ws.json.parse", {
      size: String(bytes),
    });
    try {
      parsedJson = JSON.parse(payload);
    } catch {
      return;
    } finally {
      this.endTraceSection(parseTraceOpen);
    }

    const parsed = validateWSOutboundMessage(parsedJson);
    if (!parsed.success) {
      const responseIdentity = extractCorrelatedResponseIdentity(parsedJson);
      const envelopeType =
        parsedJson != null &&
        typeof parsedJson === "object" &&
        "type" in parsedJson &&
        typeof parsedJson.type === "string"
          ? parsedJson.type
          : "unknown";
      const msgType = responseIdentity?.responseType ?? envelopeType;
      this.logger.warn({ msgType, error: parsed.error.message }, "Message validation failed");
      if (responseIdentity) {
        this.rejectWaitersForRequestId(
          responseIdentity.requestId,
          new DaemonProtocolError(responseIdentity),
        );
      }
      return;
    }

    this.consecutiveLivenessFailures = 0;

    if (parsed.data.type === "pong") {
      this.traceInstant("paseo.ws.message.inbound", {
        envelopeType: "pong",
        messageType: "pong",
      });
      this.resolvePingProbe();
      this.runtimeMetrics?.recordMessage("pong", bytes, perfNow() - startMs);
      return;
    }

    this.traceInstant("paseo.ws.message.inbound", {
      envelopeType: "session",
      messageType: parsed.data.message.type,
    });
    this.handleSessionMessage(parsed.data.message);
    const msgType = parsed.data.message.type;
    this.runtimeMetrics?.recordMessage(msgType, bytes, perfNow() - startMs);
    if (parsed.data.message.type === "agent_stream") {
      this.runtimeMetrics?.recordAgentStream(parsed.data.message.payload);
    }
  }

  private updateConnectionState(
    next: ConnectionState,
    metadata?: { event: string; reason?: string; reasonCode?: string },
  ): void {
    const previous = this.connectionState;
    this.connectionState = next;
    const reasonFromNext =
      next.status === "disconnected" && typeof next.reason === "string" ? next.reason : null;
    const reason = metadata?.reason ?? reasonFromNext;
    const reasonCode = metadata?.reasonCode ?? toReasonCode(reason);
    this.logger.debug(
      {
        serverId: this.logServerId,
        clientIdHash: this.logClientIdHash,
        from: previous.status,
        to: next.status,
        event: metadata?.event ?? "STATE_UPDATE",
        connectionPath: this.logConnectionPath,
        generation: this.logGeneration,
        reasonCode,
        reason,
      },
      "DaemonClientTransition",
    );
    for (const listener of this.connectionListeners) {
      try {
        listener(next);
      } catch {
        // no-op
      }
    }
  }

  private scheduleReconnect(input?: {
    reason?: string;
    event?: string;
    reasonCode?: string;
  }): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    const wasDisposed = this.connectionState.status === "disposed";
    const reason = input?.reason;

    if (typeof reason === "string" && reason.trim().length > 0) {
      this.lastErrorValue = reason.trim();
    }

    this.providerSnapshotUpdates.pause();

    // Clear all pending waiters and queued sends since the connection was lost
    // and responses from the previous connection will never arrive.
    this.clearWaiters(new Error(reason ?? "Connection lost"));
    this.rejectPendingSendQueue(new Error(reason ?? "Connection lost"));
    this.rejectPingProbe(new Error(reason ?? "Connection lost"));
    this.lastServerInfoMessage = null;

    if (wasDisposed) {
      this.rejectConnect(new Error(reason ?? "Daemon client is disposed"));
      return;
    }
    this.emitDisconnectedStateForReconnect(reason, input);
    if (!this.shouldReconnect || this.config.reconnect?.enabled === false) {
      this.rejectConnect(new Error(reason ?? "Transport disconnected before connect"));
      return;
    }

    this.armReconnectTimer();
  }

  private emitDisconnectedStateForReconnect(
    reason: string | undefined,
    input: { reason?: string; event?: string; reasonCode?: string } | undefined,
  ): void {
    this.updateConnectionState(
      {
        status: "disconnected",
        ...(reason ? { reason } : {}),
      },
      {
        event: input?.event ?? "TRANSPORT_CLOSE",
        ...(reason ? { reason } : {}),
        ...(input?.reasonCode ? { reasonCode: input.reasonCode } : {}),
      },
    );
  }

  private armReconnectTimer(): void {
    const attempt = this.reconnectAttempt;
    const baseDelay = this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const maxDelay = this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    this.reconnectAttempt = attempt + 1;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.shouldReconnect) {
        return;
      }
      this.attemptConnect();
    }, delay);
  }

  private resolvePingProbe(): void {
    const probe = this.pingProbe;
    if (!probe) {
      return;
    }
    this.pingProbe = null;
    clearTimeout(probe.timeoutHandle);
    probe.resolve(perfNow() - probe.startedAt);
  }

  private clearPingProbe(): void {
    const probe = this.pingProbe;
    if (!probe) {
      return;
    }
    this.pingProbe = null;
    clearTimeout(probe.timeoutHandle);
  }

  private rejectPingProbe(error: Error): void {
    const probe = this.pingProbe;
    if (!probe) {
      return;
    }
    this.pingProbe = null;
    clearTimeout(probe.timeoutHandle);
    probe.reject(error);
  }

  private recordLivenessFailure(error: Error): void {
    this.consecutiveLivenessFailures += 1;
    if (this.consecutiveLivenessFailures < LIVENESS_FAILURE_RECONNECT_THRESHOLD) {
      return;
    }
    this.consecutiveLivenessFailures = 0;
    this.lastErrorValue = error.message;
    this.disposeTransport(1001, "Liveness check timed out");
    this.scheduleReconnect({
      reason: error.message,
      event: "LIVENESS_TIMEOUT",
      reasonCode: "liveness_timeout",
    });
  }

  private handleSessionMessage(msg: SessionOutboundMessage): void {
    if (
      msg.type === "providers_snapshot_update" &&
      this.config.providerSnapshots !== "wire" &&
      msg.payload.snapshotHash &&
      !msg.payload.compactSnapshot
    ) {
      if (this.messageHandlers.has(msg.type) || this.eventListeners.size > 0) {
        this.providerSnapshotUpdates.receive(msg);
      }
      return;
    }
    this.deliverSessionMessage(msg);
  }

  private deliverSessionMessage(msg: SessionOutboundMessage): void {
    const consumerMessage = normalizeProviderSnapshotUpdateMessage(
      msg,
      this.config.providerSnapshots !== "wire",
    );

    if (consumerMessage.type === "status") {
      const serverInfo = parseServerInfoStatusPayload(consumerMessage.payload);
      if (serverInfo) {
        this.lastServerInfoMessage = serverInfo;
        if (this.connectionState.status === "connecting") {
          this.resetConnectTimeout();
          this.reconnectAttempt = 0;
          this.updateConnectionState({ status: "connected" }, { event: "HELLO_SERVER_INFO" });
          this.startLivenessHeartbeat();
          this.subscriptions.restore();
          this.providerSnapshotUpdates.resume();

          this.flushPendingSendQueue();
          this.resolveConnect();
        }
      }
    }

    if (this.rawMessageListeners.size > 0) {
      for (const handler of this.rawMessageListeners) {
        try {
          handler(consumerMessage);
        } catch {
          // no-op
        }
      }
    }

    const handlers = this.messageHandlers.get(consumerMessage.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(consumerMessage);
        } catch {
          // no-op
        }
      }
    }

    const event = this.toEvent(consumerMessage);
    if (event) {
      for (const handler of this.eventListeners) {
        handler(event);
      }
    }

    this.resolveWaiters(consumerMessage);
  }

  private resolveWaiters(msg: SessionOutboundMessage): void {
    for (const waiter of Array.from(this.waiters)) {
      const result = waiter.predicate(msg);
      if (result !== null) {
        this.waiters.delete(waiter);
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
        waiter.resolve(result);
      }
    }
  }

  private rejectWaitersForRequestId(requestId: string, error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.requestId !== requestId) {
        continue;
      }
      this.waiters.delete(waiter);
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.reject(error);
    }
  }

  private clearWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private toEvent(msg: SessionOutboundMessage): DaemonEvent | null {
    switch (msg.type) {
      case "agent_update":
        return {
          type: "agent_update",
          agentId: msg.payload.kind === "upsert" ? msg.payload.agent.id : msg.payload.agentId,
          payload: msg.payload,
        };
      case "workspace_update":
        return {
          type: "workspace_update",
          workspaceId: msg.payload.kind === "upsert" ? msg.payload.workspace.id : msg.payload.id,
          payload: msg.payload,
        };
      case "project.update":
        return { type: "project.update", payload: msg.payload };
      case "workspace_setup_progress":
        return {
          type: "workspace_setup_progress",
          workspaceId: msg.payload.workspaceId,
          payload: msg.payload,
        };
      case "agent_stream":
        return {
          type: "agent_stream",
          agentId: msg.payload.agentId,
          event: msg.payload.event,
          timestamp: msg.payload.timestamp,
          ...(typeof msg.payload.seq === "number" ? { seq: msg.payload.seq } : {}),
          ...(typeof msg.payload.epoch === "string" ? { epoch: msg.payload.epoch } : {}),
        };
      case "status":
        return { type: "status", payload: msg.payload };
      case "agent_deleted":
        return { type: "agent_deleted", agentId: msg.payload.agentId };
      case "agent_permission_request":
        return {
          type: "agent_permission_request",
          agentId: msg.payload.agentId,
          request: msg.payload.request,
        };
      case "agent_permission_resolved":
        return {
          type: "agent_permission_resolved",
          agentId: msg.payload.agentId,
          requestId: msg.payload.requestId,
          resolution: msg.payload.resolution,
        };
      case "providers_snapshot_update":
        return {
          type: "providers_snapshot_update",
          payload: msg.payload,
        };
      default:
        return null;
    }
  }

  private waitForWithCancel<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    options?: WaitOptions,
  ): WaitHandle<T> {
    // Capture stack trace at call site, not inside setTimeout
    const timeoutError = new Error(`Timeout waiting for message (${timeout}ms)`);

    let waiter: Waiter<T> | null = null;
    let settled = false;
    let rejectFn: ((error: Error) => void) | null = null;

    const promise = new Promise<T>((resolve, reject) => {
      const wrappedResolve = (value: T) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      rejectFn = wrappedReject;

      const timeoutHandle =
        timeout > 0
          ? setTimeout(() => {
              if (waiter) {
                this.waiters.delete(waiter);
              }
              wrappedReject(timeoutError);
            }, timeout)
          : null;

      waiter = {
        predicate,
        resolve: wrappedResolve,
        reject: wrappedReject,
        timeoutHandle,
        requestId: options?.requestId,
      };
      this.waiters.add(waiter);
    });

    const cancel = (error: Error) => {
      if (settled) {
        return;
      }

      if (waiter) {
        this.waiters.delete(waiter);
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
      }

      if (rejectFn) {
        rejectFn(error);
        return;
      }

      // Extremely unlikely: cancel called before the Promise executor ran.
      queueMicrotask(() => {
        if (!settled && rejectFn) {
          rejectFn(error);
        }
      });
    };

    return { promise, cancel };
  }
  getLastLivenessRttMs(): number | null {
    return this.lastLivenessRttMs;
  }
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  measureLatency(params?: { timeoutMs?: number }): Promise<number> {
    const timeoutMs = Math.max(1, params?.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS);
    return this.sendPingAwaitRtt({ timeoutMs, drivesLivenessFailure: false }).catch((error) => {
      throw toTimeoutError(error, "Latency measurement", timeoutMs);
    });
  }
}
