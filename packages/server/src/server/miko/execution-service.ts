import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  EXECUTION_PROTOCOL_VERSION as version,
  RequestSchema,
  HelloSchema,
  CreateOptionsSchema,
  ValidationSchema,
  TimelineOptionsSchema,
  type ExecutionRequest,
  type AgentSnapshot,
} from "@mikoagents/execution-protocol";
import { writePrivateFileAtomicSync } from "../private-files.js";
import type { WebSocketLike } from "../websocket-server.js";
import type { ExecutionRuntime } from "./provider-execution.js";
import { digest, RequestJournal } from "./journal.js";

const BindingSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  provider: z.string(),
  nativeAgentId: z.string(),
  nativeWorkspaceId: z.string(),
});
type Binding = z.infer<typeof BindingSchema>;
const IdentitySchema = z.object({ agentId: z.string() });
const ProviderOptionsSchema = z.object({
  cwd: z.string().optional(),
  providers: z.array(z.string()).optional(),
});

export class ExecutionService {
  private readonly journal: RequestJournal;
  private readonly watchers = new Map<string, () => void>();
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private ready = false;
  private readonly directory: string;
  constructor(
    private readonly options: {
      socket: WebSocketLike;
      home: string;
      daemonId: string;
      permissions: readonly string[];
      execution: ExecutionRuntime;
    },
  ) {
    options.execution.setAuthority?.(options.permissions.includes("hub.execute"));
    this.directory = join(options.home, "miko", digest(options.daemonId));
    this.journal = new RequestJournal(join(this.directory, "requests"));
    options.socket.on("message", (data) => {
      const request = this.receive(data);
      this.pending.add(request);
      void request
        .catch(() => options.socket.close(4400, "invalid execution request"))
        .finally(() => this.pending.delete(request));
    });
    options.socket.on("close", () => this.close());
  }
  updatePermissions(permissions: readonly string[]): void {
    this.options.permissions = permissions;
    this.options.execution.setAuthority?.(permissions.includes("hub.execute"));
    if (!permissions.includes("hub.execute")) {
      for (const unsubscribe of this.watchers.values()) unsubscribe();
      this.watchers.clear();
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
  async retireAuthority(): Promise<void> {
    this.options.permissions = [];
    this.options.execution.setAuthority?.(false);
    await Promise.allSettled(this.pending);
  }
  private send(message: unknown): void {
    if (!this.closed) void this.options.socket.send(JSON.stringify(message));
  }
  private async receive(raw: unknown): Promise<void> {
    const value: unknown = JSON.parse(String(raw));
    if (!this.ready) {
      HelloSchema.parse(value);
      this.ready = true;
      this.send({ type: "miko.ready", version, permissions: this.options.permissions });
      return;
    }
    const parsed = RequestSchema.safeParse(value);
    if (!parsed.success) {
      const invalid = z.object({ version: z.literal(version), requestId: z.string() }).parse(value);
      this.send({
        type: "miko.response",
        version,
        requestId: invalid.requestId,
        error: { code: "operation_unsupported", message: "operation_unsupported" },
      });
      return;
    }
    const request = parsed.data;
    try {
      if (!this.options.permissions.includes("hub.execute"))
        throw new Error("execution_not_allowed");
      const result = await this.dispatch(request);
      this.send({ type: "miko.response", version, requestId: request.requestId, result });
    } catch (error) {
      // Provider errors can contain endpoint headers or task input. Expose only stable codes.
      const message =
        error instanceof Error && KNOWN_ERRORS.has(error.message)
          ? error.message
          : "execution_request_failed";
      this.send({
        type: "miko.response",
        version,
        requestId: request.requestId,
        error: { code: message, message },
      });
    }
  }
  private async binding(id: string): Promise<Binding> {
    let stored: string;
    try {
      stored = await readFile(join(this.directory, "sessions", `${digest(id)}.json`), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error("session_not_found", { cause: error });
      throw error;
    }
    return BindingSchema.strict().parse(JSON.parse(stored));
  }
  private snapshot(
    binding: Binding,
    native: { status: AgentSnapshot["status"]; archivedAt?: unknown },
  ): AgentSnapshot {
    return {
      id: binding.id,
      workspaceId: binding.workspaceId,
      provider: binding.provider,
      nativeAgentId: binding.nativeAgentId,
      status: native.status,
      ...(native.archivedAt === undefined ? {} : { archivedAt: native.archivedAt }),
    };
  }
  private async dispatch(request: ExecutionRequest): Promise<unknown> {
    const input = request.input;
    if (request.operation === "receipt")
      return this.journal.receipt(z.object({ key: z.string() }).parse(input).key);
    if (["providers", "refresh", "validate"].includes(request.operation)) {
      const options = ProviderOptionsSchema.parse(input);
      if (request.operation === "providers") return this.options.execution.providers(options);
      if (request.operation === "refresh") {
        await this.options.execution.refresh(options);
        return null;
      }
      return this.options.execution.validate(ValidationSchema.parse(input));
    }
    if (request.operation === "create") {
      const { key, options } = z
        .object({ key: z.string().min(1), options: CreateOptionsSchema })
        .parse(input);
      return this.journal.execute(
        `create:${key}`,
        options,
        async () => {
          const native = await this.options.execution.create(
            `${this.options.daemonId}:${key}`,
            options,
          );
          const id = digest(["agent", key]),
            workspaceId = digest(["workspace", key]);
          const binding: Binding = {
            id,
            workspaceId,
            provider: options.provider,
            nativeAgentId: native.id,
            nativeWorkspaceId: native.workspaceId,
          };
          writePrivateFileAtomicSync(
            join(this.directory, "sessions", `${digest(id)}.json`),
            JSON.stringify(binding),
          );
          return this.snapshot(binding, native);
        },
        true,
      );
    }
    if (request.operation === "restore") {
      const { workspaceId, agentId } = z
          .object({ workspaceId: z.string(), agentId: z.string() })
          .parse(input),
        binding = await this.binding(agentId);
      if (binding.workspaceId !== workspaceId) throw new Error("session_binding_mismatch");
      return this.journal.execute(
        `restore:${z.object({ key: z.string() }).parse(input).key}`,
        input,
        async () => this.options.execution.restore(binding.nativeWorkspaceId),
      );
    }
    const { agentId } = IdentitySchema.parse(input),
      binding = await this.binding(agentId);
    if (request.operation === "get")
      return this.snapshot(binding, await this.options.execution.get(binding.nativeAgentId));
    if (request.operation === "submit") {
      const { messageId, text } = z
        .object({ messageId: z.string(), text: z.string() })
        .parse(input);
      return this.journal.execute(`submit:${agentId}:${messageId}`, input, async () => {
        await this.options.execution.send(binding.nativeAgentId, messageId, text);
        return null;
      });
    }
    if (request.operation === "cancel" || request.operation === "cleanup") {
      if (z.object({ workspaceId: z.string() }).parse(input).workspaceId !== binding.workspaceId)
        throw new Error("session_binding_mismatch");
      return this.journal.execute(
        `${request.operation}:${z.object({ key: z.string() }).parse(input).key}`,
        input,
        async () => {
          await this.options.execution.control(
            binding.nativeAgentId,
            binding.nativeWorkspaceId,
            request.operation === "cancel" ? "interrupt" : "archive",
          );
          return null;
        },
      );
    }
    if (request.operation === "timeline") {
      const { agentId: _agentId, ...options } = request.input;
      return this.options.execution.timeline(
        binding.nativeAgentId,
        TimelineOptionsSchema.parse(options),
      );
    }
    if (request.operation === "unwatch") {
      this.watchers.get(agentId)?.();
      this.watchers.delete(agentId);
      return null;
    }
    if (request.operation === "watch") {
      this.watchers.get(agentId)?.();
      const unsubscribe = await this.options.execution.watch(binding.nativeAgentId, (event) => {
        const translated =
          event.type === "agent_stream"
            ? { ...event, agentId }
            : { ...event, agent: this.snapshot(binding, event.agent) };
        if (this.options.permissions.includes("hub.execute"))
          this.send({ type: "miko.event", version, event: translated });
      });
      if (this.closed || !this.options.permissions.includes("hub.execute")) unsubscribe();
      else this.watchers.set(agentId, unsubscribe);
      return null;
    }
    throw new Error("operation_unsupported");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.watchers.values()) unsubscribe();
    this.watchers.clear();
  }
}

const KNOWN_ERRORS = new Set([
  "execution_not_allowed",
  "request_key_conflict",
  "request_outcome_unknown",
  "session_binding_mismatch",
  "session_not_found",
  "operation_unsupported",
]);
