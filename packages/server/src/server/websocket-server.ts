import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { hostname } from "node:os";
import type { Logger } from "pino";
import { WSInboundMessageSchema, type SessionInboundMessage } from "@getpaseo/protocol/messages";
import { CreateOptionsSchema } from "@mikoagents/execution-protocol";
import { isHostnameAllowed } from "./hostnames.js";
import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  isBearerTokenValidAsync,
} from "./auth.js";
import type { PaseoDaemonConfig } from "./bootstrap.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceRecoveryService } from "./session/workspace-recovery/workspace-recovery-service.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import type { ProviderExecution } from "./miko/provider-execution.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "./messages.js";
import { buildStoredAgentPayload } from "./agent/agent-projections.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { projectTimelineRows } from "./agent/timeline-projection.js";
import { checkoutFromPersistedWorkspacePlacement } from "./workspace-registry-model.js";
import { getPidLockInfo } from "./pid-lock.js";
import { loadConfig } from "./config.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  DEFAULT_CLIENT_RESTART_RPC_REASON,
} from "./lifecycle-reasons.js";

export interface WebSocketLike {
  readyState: number;
  bufferedAmount?: number;
  send(
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ): void | Promise<void>;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  once(event: "close" | "error", listener: (...args: unknown[]) => void): void;
}
interface NativeContext {
  clientId: string;
  execution: ProviderExecution;
  respond(type: string, payload: Record<string, unknown>): void;
  observe(): void;
  setTimelineIds(ids: string[]): void;
}
interface Options {
  httpServer: Server;
  config: PaseoDaemonConfig;
  serverId: string;
  version: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providers: ProviderSnapshotManager;
  workspaceRegistry: WorkspaceRegistry;
  recovery: WorkspaceRecoveryService;
  hubRelationships: HubRelationshipManagement;
  providerExecution(ownerId: string): ProviderExecution;
  logger: Logger;
}

/** Direct native control/diagnostic endpoint; product UI, voice and relay have no runtime here. */
export class ExecutionWebSocketServer {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    handleProtocols: (protocols) =>
      [...protocols].find((value) => value.startsWith("paseo.bearer.")) ?? false,
  });
  constructor(private readonly options: Options) {
    options.httpServer.on("upgrade", (request, socket, head) => {
      void (async () => {
        const origin = request.headers.origin;
        if (
          new URL(request.url ?? "/", "http://localhost").pathname !== "/ws" ||
          !isHostnameAllowed(request.headers.host, options.config.hostnames) ||
          (origin && !options.config.corsAllowedOrigins.includes(origin))
        ) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        const token =
          extractHttpBearerToken(request.headers.authorization) ??
          extractWsBearerToken(extractWsBearerProtocol(request.headers["sec-websocket-protocol"]));
        if (!(await isBearerTokenValidAsync({ password: options.config.auth?.password, token }))) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(ws));
      })().catch(() => socket.destroy());
    });
  }
  async close(): Promise<void> {
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
    await Promise.allSettled(this.pending);
  }
  private attach(socket: WebSocket) {
    const { agentManager, logger } = this.options;
    let clientId: string | undefined;
    let execution: ProviderExecution;
    let observing = false;
    let timelineIds = new Set<string>();
    const send = (type: string, payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "session", message: { type, payload } }));
    };
    const handshake = setTimeout(() => socket.close(4400, "hello required"), 15_000);
    const detach = agentManager.subscribe((event) => {
      if (!clientId) return;
      if (observing && event.type === "agent_state")
        send("agent_update", { kind: "upsert", agent: serializeAgentSnapshot(event.agent) });
      if (event.type === "agent_stream" && timelineIds.has(event.agentId)) {
        const stream = serializeAgentStreamEvent(event.event);
        if (stream)
          send("agent_stream", {
            agentId: event.agentId,
            event: stream,
            timestamp: event.timestamp ?? new Date().toISOString(),
            seq: event.seq,
            epoch: event.epoch,
          });
      }
    });
    socket.once("close", () => {
      clearTimeout(handshake);
      detach();
    });
    socket.on("error", () => socket.close());
    socket.on("message", (raw) => {
      const operation = (async () => {
        const frame = WSInboundMessageSchema.parse(JSON.parse(raw.toString()));
        if (frame.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (frame.type === "hello") {
          if (clientId) throw new Error("duplicate hello");
          clearTimeout(handshake);
          clientId = frame.clientId;
          execution = this.options.providerExecution(`native:${clientId}`);
          send("status", {
            status: "server_info",
            serverId: this.options.serverId,
            hostname: hostname(),
            version: this.options.version,
            features: {
              hubAgentRpc: true,
              agentRequestReceipts: true,
              providersSnapshot: true,
              providersSnapshotCwd: true,
              daemonStatusRpc: true,
              daemonConfigReload: true,
              hubRelationship: true,
              selectiveAgentTimeline: true,
            },
          });
          return;
        }
        if (frame.type !== "session" || !clientId) throw new Error("hello required");
        const msg = frame.message;
        const respond = (type: string, payload: Record<string, unknown>) =>
          send(type, { requestId: "requestId" in msg ? msg.requestId : undefined, ...payload });
        try {
          const context: NativeContext = {
            clientId,
            execution,
            respond,
            observe: () => {
              observing = true;
            },
            setTimelineIds: (ids) => {
              timelineIds = new Set(ids);
            },
          };
          if (await this.providerRequest(msg, context)) return;
          if (await this.daemonRequest(msg, context)) return;
          if (await this.hubRequest(msg, context)) return;
          if (await this.executionRequest(msg, context)) return;
          if (await this.workspaceRequest(msg, context)) return;
          if (await this.observationRequest(msg, context)) return;
          this.unsupported(msg, respond);
        } catch (error) {
          // Local management may contain credentials; never include request payloads in logs.
          logger.debug({ requestType: msg.type }, "Native control request rejected");
          respond("rpc_error", {
            requestType: msg.type,
            code: "handler_error",
            error: error instanceof Error ? error.message : "Request rejected",
          });
        }
      })();
      this.pending.add(operation);
      void operation
        .catch(() => socket.close(4400, "invalid native message"))
        .finally(() => this.pending.delete(operation));
    });
  }
  private async providerRequest(
    msg: SessionInboundMessage,
    context: NativeContext,
  ): Promise<boolean> {
    const { providers } = this.options;
    const { execution, respond } = context;
    switch (msg.type) {
      case "get_providers_snapshot_request":
        respond("get_providers_snapshot_response", await execution.providers(msg));
        return true;
      case "refresh_providers_snapshot_request":
        await execution.refresh(msg);
        respond("refresh_providers_snapshot_response", { acknowledged: true });
        return true;
      case "list_provider_models_request":
        respond("list_provider_models_response", {
          provider: msg.provider,
          models: await providers.listModels({
            provider: msg.provider,
            cwd: msg.cwd,
            wait: true,
          }),
          error: null,
          fetchedAt: new Date().toISOString(),
        });
        return true;
      case "provider_diagnostic_request":
        respond("provider_diagnostic_response", {
          ...(await providers.getProviderDiagnostic(msg.provider)),
        });
        return true;
      case "hub.execution.agent.validate.request": {
        const issues = await providers.validateAgentConfiguration(msg);
        respond("hub.execution.agent.validate.response", {
          valid: issues.length === 0,
          issues,
        });
        return true;
      }
      default:
        return false;
    }
  }

  private async daemonRequest(
    msg: SessionInboundMessage,
    context: NativeContext,
  ): Promise<boolean> {
    const { config, agentManager } = this.options;
    const { clientId, respond } = context;
    switch (msg.type) {
      case "daemon.get_status.request":
        respond("daemon.get_status.response", {
          serverId: this.options.serverId,
          version: this.options.version,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: (await getPidLockInfo(config.paseoHome))?.startedAt ?? null,
          listen: config.listen,
          relay: null,
          providers: await agentManager.listProviderAvailability(),
        });
        return true;
      case "daemon.config.reload.request": {
        const next = loadConfig(config.paseoHome);
        const keys = Object.keys(next) as Array<keyof PaseoDaemonConfig>;
        respond("daemon.config.reload.response", {
          appliedPaths: [],
          restartRequiredPaths: keys.filter(
            (key) => JSON.stringify(next[key]) !== JSON.stringify(config[key]),
          ),
          overrideControlledPaths: [],
        });
        return true;
      }
      case "shutdown_server_request":
      case "restart_server_request": {
        const shutdown = msg.type === "shutdown_server_request";
        const reason =
          msg.type === "restart_server_request"
            ? msg.reason?.trim() || DEFAULT_CLIENT_RESTART_RPC_REASON
            : CLIENT_SHUTDOWN_RPC_REASON;
        respond("status", {
          status: shutdown ? "shutdown_requested" : "restart_requested",
          clientId,
        });
        config.onLifecycleIntent?.({
          type: shutdown ? "shutdown" : "restart",
          clientId,
          requestId: msg.requestId,
          reason,
        });
        return true;
      }
      default:
        return false;
    }
  }

  private async hubRequest(msg: SessionInboundMessage, context: NativeContext): Promise<boolean> {
    const { respond } = context;
    switch (msg.type) {
      case "hub.management.daemon.connect.request":
        respond("hub.management.daemon.connect.response", {
          status: await this.options.hubRelationships.connect(msg),
        });
        return true;
      case "hub.management.daemon.get_status.request":
        respond("hub.management.daemon.get_status.response", {
          status: this.options.hubRelationships.status(),
        });
        return true;
      case "hub.management.daemon.disconnect.request":
        respond(
          "hub.management.daemon.disconnect.response",
          await this.options.hubRelationships.disconnect({ force: msg.force ?? false }),
        );
        return true;
      case "hub.management.daemon.permissions.update.request":
        respond("hub.management.daemon.permissions.update.response", {
          status: await this.options.hubRelationships.updatePermissions(msg),
        });
        return true;
      default:
        return false;
    }
  }

  private async executionRequest(
    msg: SessionInboundMessage,
    context: NativeContext,
  ): Promise<boolean> {
    const { execution, respond } = context;
    switch (msg.type) {
      case "create_agent_request": {
        if (!msg.idempotencyKey || msg.initialPrompt !== undefined)
          throw new Error("Native execution requires keyed create and separate submit");
        const agent = await execution.create(
          msg.idempotencyKey,
          CreateOptionsSchema.parse({
            provider: msg.config.provider,
            title: msg.config.title,
            model: msg.config.model,
            thinkingOptionId: msg.config.thinkingOptionId,
            providerOptions: msg.config.providerOptions,
            mcpServers: msg.config.mcpServers,
            toolPolicy: msg.config.toolPolicy,
            cwd: msg.config.cwd,
            mode: msg.config.modeId,
            env: msg.env,
            worktree: msg.worktree,
            background: true,
          }),
        );
        respond("status", {
          status: "agent_created",
          agentId: agent.id,
          agent: await this.agentPayload(agent.id),
        });
        return true;
      }
      case "fetch_agent_request":
        respond("fetch_agent_response", {
          agent: await this.agentPayload(msg.agentId),
          error: null,
        });
        return true;
      case "send_agent_message_request": {
        if (!msg.messageId || msg.images?.length || msg.attachments?.length)
          throw new Error("Native execution requires a message ID and text submit");
        await execution.send(msg.agentId, msg.messageId, msg.text);
        respond("send_agent_message_response", {
          agentId: msg.agentId,
          accepted: true,
          error: null,
        });
        return true;
      }
      case "cancel_agent_request": {
        const agent = await execution.get(msg.agentId);
        await execution.control(msg.agentId, agent.workspaceId, "interrupt");
        respond("status", { status: "agent_cancelled", agentId: msg.agentId });
        return true;
      }
      default:
        return false;
    }
  }

  private async workspaceRequest(
    msg: SessionInboundMessage,
    context: NativeContext,
  ): Promise<boolean> {
    const { agentStorage } = this.options;
    const { execution, clientId, respond } = context;
    switch (msg.type) {
      case "archive_workspace_request": {
        const records = await agentStorage.listByWorkspace(msg.workspaceId);
        const owned = records.find(
          (record) =>
            record.owner?.kind === "daemon" && record.owner.daemonId === `native:${clientId}`,
        );
        if (!owned) throw new Error("session_not_found");
        await execution.control(owned.id, msg.workspaceId, "archive");
        respond("archive_workspace_response", {
          workspaceId: msg.workspaceId,
          archivedAgentIds: records.map((record) => record.id),
          archivedWorkspaceIds: [msg.workspaceId],
          archivedAt: new Date().toISOString(),
          error: null,
        });
        return true;
      }
      case "workspace.recovery.inspect.request":
        respond("workspace.recovery.inspect.response", {
          state: await this.options.recovery.inspect(msg.workspaceId),
        });
        return true;
      case "workspace.recovery.restore.request": {
        await execution.restore(msg.workspaceId);
        respond("workspace.recovery.restore.response", {
          workspaceId: msg.workspaceId,
          accepted: true,
          error: null,
        });
        return true;
      }
      case "workspace.title.set.request": {
        const workspace = await this.options.workspaceRegistry.get(msg.workspaceId);
        if (!workspace) throw new Error("workspace_not_found");
        await this.options.workspaceRegistry.upsert({ ...workspace, title: msg.title });
        respond("workspace.title.set.response", {
          workspaceId: msg.workspaceId,
          title: msg.title,
          accepted: true,
          error: null,
        });
        return true;
      }
      default:
        return false;
    }
  }

  private async listAgents(msg: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>) {
    const { agentStorage } = this.options;
    const records = await agentStorage.list();
    const entries = [];
    for (const record of records) {
      const agent = await this.agentPayload(record.id);
      if (!agent || (!msg.filter?.includeArchived && agent.archivedAt)) continue;
      if (msg.filter?.statuses && !msg.filter.statuses.includes(agent.status)) continue;
      if (
        msg.filter?.thinkingOptionId !== undefined &&
        agent.effectiveThinkingOptionId !== msg.filter.thinkingOptionId
      )
        continue;
      if (
        Object.entries(msg.filter?.labels ?? {}).some(([key, value]) => agent.labels[key] !== value)
      )
        continue;
      const workspace = agent.workspaceId
        ? await this.options.workspaceRegistry.get(agent.workspaceId)
        : undefined;
      if (!workspace) continue;
      if (msg.scope === "active" && (agent.archivedAt || workspace.archivedAt)) continue;
      entries.push({
        agent,
        project: {
          projectKey: workspace.projectId,
          projectName: workspace.displayName,
          workspaceName: workspace.title,
          checkout: checkoutFromPersistedWorkspacePlacement({ workspace }),
        },
      });
    }
    return entries;
  }

  private async observationRequest(
    msg: SessionInboundMessage,
    context: NativeContext,
  ): Promise<boolean> {
    const { agentManager, agentStorage, logger } = this.options;
    const { respond } = context;
    switch (msg.type) {
      case "fetch_agents_request": {
        context.observe();
        respond("fetch_agents_response", {
          entries: await this.listAgents(msg),
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        });
        return true;
      }
      case "session.events.set_subscription.request":
        respond("session.events.set_subscription.response", { events: msg.events });
        return true;
      case "agent.timeline.set_subscription.request":
        context.setTimelineIds(msg.agentIds);
        respond("agent.timeline.set_subscription.response", { agentIds: msg.agentIds });
        return true;
      case "fetch_agent_timeline_request": {
        if (
          !agentManager.getAgent(msg.agentId) &&
          !(await agentStorage.get(msg.agentId))?.persistence
        )
          throw new Error("session_history_unavailable");
        await ensureAgentLoaded(msg.agentId, { agentManager, agentStorage, logger });
        const result = agentManager.fetchTimeline(msg.agentId, msg);
        const entries = projectTimelineRows({
          rows: result.rows,
          mode: msg.projection ?? "projected",
        });
        const first = result.rows[0],
          last = result.rows.at(-1);
        respond("fetch_agent_timeline_response", {
          ...result,
          agentId: msg.agentId,
          agent: await this.agentPayload(msg.agentId),
          projection: msg.projection ?? "projected",
          error: null,
          startCursor: first ? { epoch: result.epoch, seq: first.seq } : null,
          endCursor: last ? { epoch: result.epoch, seq: last.seq } : null,
          entries: entries.map((entry) =>
            Object.assign({}, entry, {
              provider: agentManager.getAgent(msg.agentId)?.provider,
            }),
          ),
        });
        return true;
      }
      default:
        return false;
    }
  }
  private unsupported(
    msg: SessionInboundMessage,
    respond: (type: string, payload: Record<string, unknown>) => void,
  ) {
    respond("rpc_error", {
      requestType: msg.type,
      code: "operation_unsupported",
      error: "This operation is not included in the Miko execution daemon",
    });
  }
  private async agentPayload(id: string) {
    const live = this.options.agentManager.getAgent(id);
    if (live) return serializeAgentSnapshot(live);
    let record = await this.options.agentStorage.get(id);
    if (!record) {
      const matches = (await this.options.agentStorage.list()).filter((candidate) =>
        candidate.id.startsWith(id),
      );
      record = matches.length === 1 ? (matches[0] ?? null) : null;
    }
    return record
      ? buildStoredAgentPayload(record, this.options.agentManager.getRegisteredProviderIds())
      : null;
  }
}
