import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import pino from "pino";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { openBackend } from "./backends.js";
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
  let connection: Awaited<ReturnType<typeof openBackend>> | undefined;
  let client: DaemonClient | undefined;
  const connect = async () => {
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("TCP listener required");
    return openBackend({
      id: "native",
      clientId: "test-owner",
      config: { native: { type: "paseo", url: `ws://127.0.0.1:${target.port}/ws`, token: "test" } },
      onClose() {},
    });
  };
  try {
    await daemon.start();
    connection = await connect();
    const options = {
      backend: "local",
      provider: "codex",
      cwd: home,
      env: {},
      toolPolicy: { preapproved: [] },
    };
    const first = await connection.backend.create("stable", options);
    expect((await connection.backend.create("stable", options)).id).toBe(first.id);
    expect(daemon.agentManager.listAgents()).toHaveLength(1);
    const unwatch = await connection.backend.watch(first.id, () => {});
    const prompt = "  Author prompt\nNo injected context.  ";
    await connection.backend.send(first.id, "message-1", prompt);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toBe(prompt);
    await connection.backend.send(first.id, "message-1", prompt);
    expect(prompts).toHaveLength(1);
    await expect.poll(async () => (await connection!.backend.get(first.id)).status).toBe("idle");
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
    await client.close();
    client = undefined;
    await connection.backend.control(first.id, first.workspaceId, "archive");
    expect((await connection.backend.get(first.id)).archivedAt).toBeTruthy();
    expect(await connection.backend.restore(first.workspaceId)).toBe(true);
    expect((await connection.backend.get(first.id)).archivedAt).toBeNull();
    unwatch();
    connection.close();
    connection = undefined;
    await daemon.stop();
    daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    await daemon.start();
    connection = await connect();
    expect((await connection.backend.create("stable", options)).id).toBe(first.id);
    await connection.backend.send(first.id, "message-1", prompt);
    expect(prompts).toHaveLength(1);
  } finally {
    await client?.close();
    connection?.close();
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("revocation during creation closes the admitted provider session and removes persisted authority", async () => {
  const { LocalBackend } = await import("./local-backend.js");
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
  const backend = new LocalBackend({
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
    const result = backend.create("pending", {
      backend: "local",
      provider: "codex",
      cwd: home,
      env: {},
      toolPolicy: { preapproved: [] },
    });
    await started;
    backend.setAuthority(false);
    proceed();
    await expect(result).rejects.toThrow("execution_not_allowed");
    expect(manager.listAgents()).toHaveLength(0);
    expect(await storage.list()).toHaveLength(0);
    expect(closed).toBe(1);
  } finally {
    proceed();
    manager.prepareForShutdown();
    await manager.flushForShutdown();
    await storage.flush();
    await rm(home, { recursive: true, force: true });
  }
});
