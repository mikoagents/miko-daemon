import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import pino from "pino";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";

// Exercises the real composition and inherited manager/storage, with only provider IO replaced.
test("headless runtime preserves keyed creation, exact prompts, native timeline reads and archived-session recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "miko-local-runtime-"));
  const prompts: AgentPromptInput[] = [];
  const config = {
    listen: "127.0.0.1:0",
    paseoHome: home,
    corsAllowedOrigins: [],
    agentStoragePath: join(home, "agents"),
    agentClients: {
      codex: createTestAgentClient("codex", { onStartTurn: (prompt) => prompts.push(prompt) }),
    },
  };
  let daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let client: DaemonClient | undefined;
  const connect = async () => {
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("TCP listener required");
    const socket = new WebSocket(`ws://127.0.0.1:${target.port}/ws`);
    const ready = new Promise<void>((resolve) => socket.once("message", () => resolve()));
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: "test-owner",
          clientType: "cli",
          protocolVersion: 1,
        }),
      ),
    );
    await ready;
    const request = (type: string, fields: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          socket.off("message", onMessage);
          reject(new Error("Native test request timed out"));
        }, 10_000);
        const onMessage = (raw: Buffer) => {
          const frame = z
            .object({ message: z.object({ payload: z.record(z.string(), z.unknown()) }) })
            .parse(JSON.parse(raw.toString()));
          if (frame.message.payload["requestId"] !== requestId) return;
          clearTimeout(timer);
          socket.off("message", onMessage);
          if (frame.message.payload["error"])
            reject(new Error(String(frame.message.payload["error"])));
          else resolve(frame.message.payload);
        };
        socket.on("message", onMessage);
        socket.send(JSON.stringify({ type: "session", message: { type, requestId, ...fields } }));
      });
    const snapshot = z.object({
      id: z.string(),
      workspaceId: z.string(),
      status: z.string(),
      archivedAt: z.unknown().optional(),
    });
    return {
      create: async (key: string) =>
        snapshot.parse(
          (
            await request("create_agent_request", {
              idempotencyKey: key,
              config: { provider: "codex", cwd: home, toolPolicy: { preapproved: [] } },
              env: {},
            })
          )["agent"],
        ),
      list: async () =>
        z
          .object({ entries: z.array(z.object({ agent: z.object({ id: z.string() }) })) })
          .parse(await request("fetch_agents_request", { scope: "active" })).entries,
      get: async (id: string) =>
        snapshot.parse((await request("fetch_agent_request", { agentId: id }))["agent"]),
      send: async (id: string, messageId: string, text: string) => {
        await request("send_agent_message_request", { agentId: id, messageId, text });
      },
      archive: async (workspaceId: string) => {
        await request("archive_workspace_request", { workspaceId });
      },
      restore: async (workspaceId: string) =>
        (await request("workspace.recovery.restore.request", { workspaceId }))["accepted"],
      close: () => socket.close(),
    };
  };
  try {
    await daemon.start();
    connection = await connect();
    const first = await connection.create("stable");
    expect((await connection.create("stable")).id).toBe(first.id);
    expect(daemon.agentManager.listAgents()).toHaveLength(1);
    const prompt = "  Author prompt\nNo injected context.  ";
    await connection.send(first.id, "message-1", prompt);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toBe(prompt);
    await connection.send(first.id, "message-1", prompt);
    expect(prompts).toHaveLength(1);
    await expect.poll(async () => (await connection!.get(first.id)).status).toBe("idle");
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("TCP listener required");
    client = new DaemonClient({
      url: `ws://127.0.0.1:${target.port}/ws`,
      clientId: "timeline-operator",
      reconnect: { enabled: false },
      webSocketFactory: (url, socketOptions) =>
        new WebSocket(url, socketOptions?.protocols, { headers: socketOptions?.headers }),
    });
    await client.connect();
    const timeline = await client.fetchAgentTimeline(first.id, {
      projection: "canonical",
      direction: "tail",
      limit: 200,
    });
    expect(
      timeline.entries.some(
        (entry) => entry.item.type === "user_message" && entry.item.text === prompt,
      ),
    ).toBe(true);
    const listed = await client.fetchAgents({ filter: { includeArchived: true } });
    expect(listed.entries.some((entry) => entry.agent.id === first.id)).toBe(true);
    expect((await client.fetchAgent(first.id.slice(0, 8)))?.agent.id).toBe(first.id);
    await client.close();
    client = undefined;
    await connection.archive(first.workspaceId);
    expect((await connection.get(first.id)).archivedAt).toBeTruthy();
    expect(await connection.restore(first.workspaceId)).toBe(true);
    expect((await connection.get(first.id)).archivedAt).toBeNull();
    connection.close();
    connection = undefined;
    await daemon.stop();
    daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    await daemon.start();
    connection = await connect();
    expect((await connection.create("stable")).id).toBe(first.id);
    expect((await connection.list()).some((entry) => entry.agent.id === first.id)).toBe(true);
    await connection.send(first.id, "message-1", prompt);
    expect(prompts).toHaveLength(1);
  } finally {
    await client?.close();
    connection?.close();
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("revocation during creation closes the admitted provider session and removes persisted authority", async () => {
  const { ProviderExecution } = await import("./provider-execution.js");
  const { AgentManager } = await import("../agent/agent-manager.js");
  const { AgentStorage } = await import("../agent/agent-storage.js");
  const { buildProviderRegistry } = await import("../agent/provider-registry.js");
  const { AgentRequests } = await import("../agent/requests/index.js");
  const { createAgentCommand } = await import("../agent/create-agent/create.js");
  const { FileBackedWorkspaceRegistry } = await import("../workspace-registry.js");
  const { createProviderSnapshotManagerStub } = await import("../test-utils/session-stubs.js");
  const home = await mkdtemp(join(tmpdir(), "miko-authority-"));
  const logger = pino({ level: "silent" });
  let closed = 0;
  const storage = new AgentStorage(join(home, "agents"), logger);
  await storage.initialize();
  const manager = new AgentManager({
    registry: storage,
    providerDefinitions: buildProviderRegistry(logger),
    clients: {
      codex: createTestAgentClient("codex", {
        closeSession: async () => {
          closed++;
        },
      }),
    },
    logger,
  });
  let entered!: () => void;
  let proceed!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const execution = new ProviderExecution({
    ownerId: "hub-owner",
    requests: new AgentRequests(join(home, "requests")),
    agentManager: manager,
    agentStorage: storage,
    workspaceRegistry: new FileBackedWorkspaceRegistry(join(home, "workspaces.json"), logger),
    providers: createProviderSnapshotManagerStub().manager,
    createAgent: async (input) => {
      entered();
      await gate;
      return createAgentCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          ensureWorkspaceForCreate: async () => "owned-workspace",
        },
        input,
      );
    },
    cleanupFailedCreate: async () => {
      throw new Error("Unexpected worktree");
    },
    restoreWorkspace: async () => false,
    archiveWorkspace: async () => {},
    logger,
  });
  try {
    const result = execution.create("pending", {
      provider: "codex",
      cwd: home,
      env: {},
      toolPolicy: { preapproved: [] },
    });
    await started;
    execution.setAuthority(false);
    proceed();
    await expect(result).rejects.toThrow("execution_not_allowed");
    expect(manager.listAgents()).toHaveLength(0);
    expect(await storage.list()).toHaveLength(0);
    expect(closed).toBe(1);
    execution.setAuthority(true);
    const historyAgent = await execution.create("history-only", {
      provider: "codex",
      cwd: home,
      env: {},
      toolPolicy: { preapproved: [] },
    });
    await manager.closeAgent(historyAgent.id);
    await storage.flush();
    const historyRecord = await storage.get(historyAgent.id);
    if (!historyRecord) throw new Error("Missing stored history agent");
    await storage.upsert({ ...historyRecord, persistence: null });
    await expect(
      execution.timeline(historyAgent.id, { direction: "tail", limit: 100 }),
    ).rejects.toThrow("session_history_unavailable");
    expect(manager.listAgents()).toHaveLength(0);
  } finally {
    proceed();
    manager.prepareForShutdown();
    await manager.flushForShutdown();
    await storage.flush();
    await rm(home, { recursive: true, force: true });
  }
});
