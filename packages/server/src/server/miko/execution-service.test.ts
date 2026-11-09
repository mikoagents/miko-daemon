import { diagnoseExecutionBackend } from "./diagnostic.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { ExecutionService } from "./execution-service.js";
import { PaseoBackend } from "./paseo-backend.js";
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
class TestNativeSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  constructor(private readonly receive: (value: unknown) => void) {
    super();
  }
  send(data: string | Uint8Array | ArrayBuffer): void {
    this.receive(JSON.parse(String(data)));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}
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
class NativeService {
  readonly requests: Record<string, unknown>[] = [];
  creates = 0;
  sends = 0;
  unknownSubmit = false;
  readonly snapshots = new Map<string, unknown>();
  capabilities = true;
  attach(socket: WebSocketLike) {
    socket.on("message", (raw) => {
      const request = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(String(raw))).message;
      this.requests.push(request);
      const type = request["type"],
        requestId = request["requestId"];
      let result: Record<string, unknown> = { requestId };
      if (type === "create_agent_request") {
        this.creates++;
        result["agent"] = { id: "native-agent", workspaceId: "native-workspace", status: "idle" };
      }
      if (type === "get_providers_snapshot_request") {
        result["entries"] = [
          { provider: "codex", status: "ready", supportsExactMcpPreapproval: true },
        ];
        result["generatedAt"] = new Date().toISOString();
      }
      if (type === "fetch_agent_request")
        result["agent"] = { id: "native-agent", workspaceId: "native-workspace", status: "idle" };
      if (type === "send_agent_message_request") {
        this.sends++;
        if (this.unknownSubmit) {
          socket.close();
          return;
        }
      }
      void socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: type === "create_agent_request" ? "status" : "response",
            payload: result,
          },
        }),
      );
    });
    void socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            features: { hubAgentRpc: this.capabilities, agentRequestReceipts: this.capabilities },
          },
        },
      }),
    );
  }
}
async function fixture(permissions: readonly string[] = ["hub.execute"]) {
  const home = await mkdtemp(join(tmpdir(), "miko-service-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const native = new NativeService();
  function connect(daemonId = "registered-hub") {
    const socket = new HubSocket();
    const peer = new TestNativeSocket((value) => backend.receive(value));
    const backend = new PaseoBackend((frame) => peer.emit("message", frame));
    peer.on("close", () => {
      backend.close();
      socket.close(1012);
    });
    native.attach(peer);
    const service = new ExecutionService({
      socket,
      home,
      daemonId,
      permissions,
      localBackend: backend,
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
test("execution service preserves backend settings and sends prompt bytes unchanged", async () => {
  const f = await fixture(),
    { socket } = f.connect();
  const created = await socket.request("create", { key: "session", options }),
    agent = AgentSnapshotSchema.parse(created.result);
  const text = "  User prompt\n".repeat(200);
  await socket.request("submit", { agentId: agent.id, messageId: "execution", text });
  expect(agent).toMatchObject({
    backend: "local",
    provider: options.provider,
    nativeAgentId: "native-agent",
  });
  expect(f.native.requests.find((r) => r["type"] === "create_agent_request")).toMatchObject({
    config: {
      provider: options.provider,
      modeId: options.mode,
      providerOptions: options.providerOptions,
      toolPolicy: options.toolPolicy,
    },
    env: options.env,
  });
  expect(f.native.requests.find((r) => r["type"] === "send_agent_message_request")?.["text"]).toBe(
    text,
  );
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
  expect(f.native.creates).toBe(1);
  expect(f.native.sends).toBe(1);
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
  // Simulate the crash window after the backend accepted work but before its acknowledgement.
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
  expect(f.native.sends).toBe(1);
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
  expect(f.native.creates).toBe(1);
});
test("existing Paseo service owns execution through an authenticated native adapter", async () => {
  const f = await fixture(),
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address === "string") throw new Error("invalid address");
  let authorization: unknown;
  const clientIds: string[] = [];
  server.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    socket.once("message", (raw) => {
      clientIds.push(z.object({ clientId: z.string() }).parse(JSON.parse(raw.toString())).clientId);
      f.native.attach(socket as unknown as WebSocketLike);
    });
  });
  await writeFile(
    join(f.home, "miko-backends.json"),
    JSON.stringify({
      existing: { type: "paseo", url: `ws://127.0.0.1:${address.port}`, token: "service-token" },
    }),
    { mode: 0o600 },
  );
  const { socket } = f.connect(),
    created = await socket.request("create", {
      key: "session",
      options: { ...options, backend: "existing" },
    });
  expect(AgentSnapshotSchema.parse(created.result)).toMatchObject({
    backend: "existing",
    nativeAgentId: "native-agent",
  });
  expect(authorization).toBe("Bearer service-token");
  const second = f.connect("other-hub");
  await second.socket.request("create", {
    key: "second-session",
    options: { ...options, backend: "existing" },
  });
  expect(clientIds).toEqual(["miko:registered-hub:existing", "miko:other-hub:existing"]);
  expect(f.native.creates).toBe(2);
  expect(JSON.stringify(socket.messages)).not.toContain("service-token");
  expect((await diagnoseExecutionBackend(f.home, "existing")).entries).toMatchObject([
    { provider: "codex", status: "ready", supportsExactMcpPreapproval: true },
  ]);
  expect(f.native.creates).toBe(2);
  expect(clientIds[2]).toMatch(/^miko:diagnostic:/);
});
test("reusing a request key across backends fails and missing capabilities never fall back to local", async () => {
  const f = await fixture(),
    { socket } = f.connect();
  await socket.request("create", { key: "session", options });
  expect(
    (
      await socket.request("create", {
        key: "session",
        options: { ...options, backend: "missing" },
      })
    ).error?.code,
  ).toBe("request_key_conflict");
  expect(
    (await socket.request("create", { key: "other", options: { ...options, backend: "missing" } }))
      .error?.code,
  ).toBe("backend_not_found");
  expect(f.native.creates).toBe(1);
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
  expect(
    f.native.requests.filter((request) => request["type"] === "cancel_agent_request"),
  ).toHaveLength(1);
  expect(
    (await socket.request("cleanup", { ...input, workspaceId: "unrelated" })).error?.code,
  ).toBe("session_binding_mismatch");
  await socket.request("cleanup", input);
  await socket.request("cleanup", input);
  expect(
    f.native.requests.filter((request) => request["type"] === "archive_workspace_request"),
  ).toHaveLength(1);
});
