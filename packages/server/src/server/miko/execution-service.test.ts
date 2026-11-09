import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { ExecutionService } from "./execution-service.js";
import type { ExecutionRuntime, ProviderExecutionEvent } from "./provider-execution.js";
import type { CreateOptions } from "@mikoagents/execution-protocol";
import type { WebSocketLike } from "../websocket-server.js";
import {
  RequestSchema,
  ResponseSchema,
  EXECUTION_PROTOCOL_VERSION as version,
  AgentSnapshotSchema,
} from "@mikoagents/execution-protocol";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
class HubSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  readonly messages: unknown[] = [];
  send(data: unknown): void {
    const value: unknown = JSON.parse(String(data));
    this.messages.push(value);
    this.emit("sent", value);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.emit("close", code);
  }
  async request(
    operation: ReturnType<typeof RequestSchema.parse>["operation"],
    input: Record<string, unknown>,
    requestId = crypto.randomUUID(),
  ) {
    const response = new Promise<z.infer<typeof ResponseSchema>>((resolve) => {
      const listener = (value: unknown) => {
        const parsed = ResponseSchema.safeParse(value);
        if (parsed.success && parsed.data.requestId === requestId) {
          this.off("sent", listener);
          resolve(parsed.data);
        }
      };
      this.on("sent", listener);
    });
    this.emit(
      "message",
      JSON.stringify({ type: "miko.request", version, operation, input, requestId }),
    );
    return response;
  }
}
class TestExecution implements ExecutionRuntime {
  readonly creates: CreateOptions[] = [];
  readonly prompts: string[] = [];
  readonly controls: string[] = [];
  unknownSubmit = false;
  onUnknownSubmit: () => void = () => {};
  async providers() {
    return {
      entries: [{ provider: "codex", status: "ready" as const, supportsExactMcpPreapproval: true }],
      generatedAt: new Date().toISOString(),
    };
  }
  readonly timelineIds: string[] = [];
  async timeline(id: string) {
    this.timelineIds.push(id);
    return {
      epoch: "epoch",
      rows: [
        {
          seq: 1,
          timestamp: "2026-11-09T10:00:00Z",
          item: { type: "assistant_message", text: "Retained transcript" },
        },
      ],
      hasOlder: false,
      hasNewer: false,
      reset: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      agent: {
        nativeAgentId: id,
        provider: "codex/custom",
        providerSessionId: "provider-session",
        cwd: "/repo",
        status: "idle" as const,
        model: "native-model",
      },
    };
  }
  async refresh() {}
  async validate() {
    return { valid: true };
  }
  async create(_key: string, options: CreateOptions) {
    this.creates.push(options);
    return this.get();
  }
  async get() {
    return { id: "native-agent", workspaceId: "native-workspace", status: "idle" as const };
  }
  async send(_id: string, _messageId: string, text: string) {
    this.prompts.push(text);
    if (this.unknownSubmit) {
      this.onUnknownSubmit();
      throw new Error("request_outcome_unknown");
    }
  }
  async restore() {
    return true;
  }
  async control(_id: string, _workspace: string, action: string) {
    this.controls.push(action);
  }
  async watch(_id: string, _listener: (event: ProviderExecutionEvent) => void) {
    return () => {};
  }
}
async function fixture(permissions: readonly string[] = ["hub.execute"]) {
  const home = await mkdtemp(join(tmpdir(), "miko-service-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const native = new TestExecution();
  function connect(daemonId = "registered-hub") {
    const socket = new HubSocket();
    native.onUnknownSubmit = () => socket.close(1012);
    const service = new ExecutionService({
      socket,
      home,
      daemonId,
      permissions,
      execution: native,
    });
    cleanups.push(async () => socket.close());
    socket.emit("message", JSON.stringify({ type: "miko.hello", version }));
    return { socket, service };
  }
  return { home, native, connect };
}
const options = {
  provider: "codex/custom",
  mode: "default",
  cwd: "/repo",
  env: { TASK: "explicit" },
  providerOptions: { sandbox_mode: "read-only" },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
};
test("execution service preserves provider settings and sends prompt bytes unchanged", async () => {
  const f = await fixture(),
    { socket } = f.connect();
  const created = await socket.request("create", { key: "session", options }),
    agent = AgentSnapshotSchema.parse(created.result);
  const text = "  User prompt\n".repeat(200);
  await socket.request("submit", { agentId: agent.id, messageId: "execution", text });
  expect(agent).toMatchObject({
    provider: options.provider,
    nativeAgentId: "native-agent",
  });
  expect(f.native.creates).toEqual([options]);
  expect(f.native.prompts).toEqual([text]);
});
test("receipts survive reconnect and daemon restart; replay never creates or submits twice", async () => {
  const f = await fixture();
  let { socket } = f.connect();
  const created = await socket.request("create", { key: "session", options }),
    agent = AgentSnapshotSchema.parse(created.result);
  await socket.request("submit", { agentId: agent.id, messageId: "execution", text: "exact" });
  socket.close();
  socket = f.connect().socket;
  expect((await socket.request("create", { key: "session", options })).result).toEqual(
    created.result,
  );
  await socket.request("submit", { agentId: agent.id, messageId: "execution", text: "exact" });
  expect(f.native.creates).toHaveLength(1);
  expect(f.native.prompts).toHaveLength(1);
  expect(
    (
      await socket.request("submit", {
        agentId: agent.id,
        messageId: "execution",
        text: "different",
      })
    ).error?.code,
  ).toBe("request_key_conflict");
});
test("an uncertain submission is retained and never replayed after restart", async () => {
  const f = await fixture();
  let { socket } = f.connect();
  const agent = AgentSnapshotSchema.parse(
    (await socket.request("create", { key: "session", options })).result,
  );
  // Simulate the crash window after the runtime accepted work but before its acknowledgement.
  f.native.unknownSubmit = true;
  void socket.request("submit", { agentId: agent.id, messageId: "execution", text: "exact" });
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket = f.connect().socket;
  const receipt = await socket.request("receipt", { key: `submit:${agent.id}:execution` });
  expect(receipt.result).toMatchObject({ state: "pending" });
  expect(
    (await socket.request("submit", { agentId: agent.id, messageId: "execution", text: "exact" }))
      .error?.code,
  ).toBe("request_outcome_unknown");
  expect(f.native.prompts).toHaveLength(1);
});
test("connection authority alone never permits execution, including after revocation", async () => {
  const f = await fixture([]),
    { socket, service } = f.connect();
  expect((await socket.request("create", { key: "session", options })).error?.code).toBe(
    "execution_not_allowed",
  );
  service.updatePermissions(["hub.execute"]);
  await socket.request("create", { key: "session", options });
  service.updatePermissions([]);
  expect((await socket.request("create", { key: "session", options })).error?.code).toBe(
    "execution_not_allowed",
  );
  expect(f.native.creates).toHaveLength(1);
});
test("removed backend selectors are rejected before provider execution", async () => {
  const f = await fixture(),
    { socket } = f.connect();
  for (const backend of ["local", "existing"])
    expect(
      (await socket.request("create", { key: "session", options: { ...options, backend } })).error
        ?.code,
    ).toBe("operation_unsupported");
  expect(f.native.creates).toHaveLength(0);
});
test("cancellation and cleanup persist stable execution keys and reject mismatched workspace references", async () => {
  const f = await fixture();
  let { socket } = f.connect();
  const agent = AgentSnapshotSchema.parse(
    (await socket.request("create", { key: "session", options })).result,
  );
  const input = { agentId: agent.id, workspaceId: agent.workspaceId, key: "execution" };
  await socket.request("cancel", input);
  socket.close();
  socket = f.connect().socket;
  await socket.request("cancel", input);
  expect(f.native.controls).toEqual(["interrupt"]);
  expect(
    (await socket.request("cleanup", { ...input, workspaceId: "unrelated" })).error?.code,
  ).toBe("session_binding_mismatch");
  await socket.request("cleanup", input);
  await socket.request("cleanup", input);
  expect(f.native.controls).toEqual(["interrupt", "archive"]);
});

test("timeline reads survive reconnect and enforce public session ownership and execution permission", async () => {
  const f = await fixture();
  let { socket, service } = f.connect();
  const agent = AgentSnapshotSchema.parse(
    (await socket.request("create", { key: "session", options })).result,
  );
  socket.close();
  ({ socket, service } = f.connect());
  const result = await socket.request("timeline", {
    agentId: agent.id,
    direction: "after",
    cursor: { epoch: "epoch", seq: 0 },
    limit: 100,
  });
  expect(result.error).toBeUndefined();
  expect(result.result).toMatchObject({
    rows: [{ item: { text: "Retained transcript" } }],
    agent: { nativeAgentId: "native-agent", providerSessionId: "provider-session" },
  });
  expect(f.native.timelineIds).toEqual(["native-agent"]);
  const other = f.connect("other-hub");
  expect((await other.socket.request("timeline", { agentId: agent.id })).error?.code).toBe(
    "session_not_found",
  );
  service.updatePermissions([]);
  expect((await socket.request("timeline", { agentId: agent.id })).error?.code).toBe(
    "execution_not_allowed",
  );
  expect(f.native.timelineIds).toHaveLength(1);
});
