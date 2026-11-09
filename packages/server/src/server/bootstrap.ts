import { createServer as createHTTPServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { HostnamesConfig } from "./hostnames.js";
import type { DaemonAuthConfig } from "./auth.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import { AgentRequests } from "./agent/requests/index.js";
import { deletePaseoWorktree } from "../utils/worktree.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createWorkspaceRecoveryService } from "./session/workspace-recovery/workspace-recovery-service.js";
import { createPaseoWorktree } from "./paseo-worktree-service.js";
import { archiveByScope } from "./workspace-archive-service.js";
import { createGitHubService } from "../services/github-service.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { getOrCreateServerId } from "./server-id.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { ExecutionService } from "./miko/execution-service.js";
import { LocalBackend } from "./miko/local-backend.js";
import { ExecutionWebSocketServer } from "./websocket-server.js";
export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export interface DaemonLifecycleIntent {
  type: "shutdown" | "restart";
  clientId: string;
  requestId: string;
  reason: string;
}
export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  hostnames?: HostnamesConfig;
  allowedHosts?: HostnamesConfig;
  trustedProxies?: true | string[];
  git?: { maxProcessesPerSecond: number; maxProcessConcurrency: number };
  appendSystemPrompt?: string;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  auth?: DaemonAuthConfig;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerCatalogRefreshTimeoutMs?: number;
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  managedProcesses?: ManagedProcessRegistry;
}
export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}
export interface PaseoDaemonDependencies {
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const identity = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses =
    config.managedProcesses ??
    createManagedProcessRegistry({
      paseoHome: config.paseoHome,
      processTable: createSystemManagedProcessTable(),
      terminateProcess: terminateWithTreeKill,
      logger,
    });
  await managedProcesses.reapStale();
  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  await agentStorage.initialize();
  const projectRegistry = new FileBackedProjectRegistry(
    join(config.paseoHome, "projects/projects.json"),
    logger,
  );
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(config.paseoHome, "projects/workspaces.json"),
    logger,
  );
  await projectRegistry.initialize();
  await workspaceRegistry.initialize();
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: { forgeOverrides: { github } },
  });
  const provisioning = createWorkspaceProvisioningService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  const runtime = await createAgentProviderRuntime({
    paseoHome: config.paseoHome,
    logger,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      isDev: config.isDev,
      extraClients: config.agentClients,
    },
  });
  const agentManager = new AgentManager({
    ...runtime.snapshotManager.getAgentManagerProviderState(),
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    logger,
  });
  agentManager.setPaseoToolsEnabled(false);
  const detachPersistence = attachAgentStoragePersistence(logger, agentManager, agentStorage);
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(
      {
        agentManager,
        agentStorage,
        providerSnapshotManager: runtime.snapshotManager,
        logger,
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        ensureWorkspaceForCreate: async (cwd) =>
          (await provisioning.createWorkspaceForDirectory(cwd)).workspaceId,
        createPaseoWorktree: async (worktreeInput, options) =>
          createPaseoWorktree(
            {
              ...worktreeInput,
              paseoHome: config.paseoHome,
              worktreesRoot: config.worktreesRoot,
              runSetup: false,
            },
            {
              github,
              workspaceGitService,
              workspaceProvisioning: provisioning,
              resolveDefaultBranch: options?.resolveDefaultBranch,
            },
          ),
      },
      input,
    );
  const recovery = createWorkspaceRecoveryService({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    getWorkspace: (id) => workspaceRegistry.get(id),
    getProject: (id) => projectRegistry.get(id),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    unarchiveWorkspace: async (workspace) => {
      await workspaceRegistry.upsert({ ...workspace, archivedAt: null });
      for (const record of await agentStorage.listByWorkspace(workspace.workspaceId)) {
        if (record.archivedAt) await agentManager.unarchiveSnapshot(record.id);
      }
    },
  });
  const archiveWorkspace = async (workspaceId: string) => {
    await archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: async (cwd) =>
          (await workspaceRegistry.list()).find((w) => w.cwd === cwd && !w.archivedAt)
            ?.workspaceId ?? null,
        getWorkspace: (id) => workspaceRegistry.get(id),
        listActiveWorkspaces: async () =>
          (await workspaceRegistry.list()).filter((w) => !w.archivedAt),
        archiveWorkspaceRecord: (id) => workspaceRegistry.archive(id, new Date().toISOString()),
        emitWorkspaceUpdatesForWorkspaceIds: async () => {},
        markWorkspaceArchiving() {},
        clearWorkspaceArchiving() {},
        killTerminalsForWorkspace: async () => {},
        sessionLogger: logger,
      },
      { scope: { kind: "workspace", workspaceId }, requestId: `cleanup:${workspaceId}` },
    );
  };
  const requests = new AgentRequests(join(config.paseoHome, "agent-requests"));
  const localBackend = (ownerId: string) =>
    new LocalBackend({
      requests,
      cleanupFailedCreate: async (worktree) => {
        await deletePaseoWorktree({
          cwd: worktree.repoRoot,
          worktreePath: worktree.worktree.worktreePath,
          teardownCwds: [],
          paseoHome: config.paseoHome,
          worktreesBaseRoot: config.worktreesRoot,
        });
        await workspaceRegistry.remove(worktree.workspace.workspaceId);
      },
      ownerId,
      agentManager,
      agentStorage,
      providers: runtime.snapshotManager,
      workspaceRegistry,
      createAgent,
      restoreWorkspace: async (id) => {
        const state = await recovery.inspect(id);
        if (state.kind === "unavailable" && state.reason === "workspace_not_archived") return false;
        if (state.kind !== "recoverable") throw new Error(state.message);
        await recovery.restore(id);
        return true;
      },
      archiveWorkspace,
      logger,
    });
  const services = new Map<string, ExecutionService>();
  const allServices = new Set<ExecutionService>();
  const hubRelationships = new HubRelationshipController({
    paseoHome: config.paseoHome,
    hostname: hostname(),
    serverId,
    daemonPublicKey: identity.publicKeyB64,
    logger,
    remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
    clock: dependencies.hubRelationshipClock,
    retryPolicy: dependencies.hubRelationshipRetryPolicy,
    createDaemonId: dependencies.createHubDaemonId,
    attachSocket: async (socket, options) => {
      services.get(options.principalId)?.close();
      const service = new ExecutionService({
        socket,
        home: config.paseoHome,
        daemonId: options.daemonId,
        permissions: options.permissions,
        localBackend: localBackend(options.daemonId),
      });
      services.set(options.principalId, service);
      allServices.add(service);
      socket.once("close", () => {
        if (services.get(options.principalId) === service) services.delete(options.principalId);
        void service.drain().then(() => allServices.delete(service));
      });
    },
    retireExecutionAuthority: async () => {
      await Promise.all([...allServices].map((service) => service.retireAuthority()));
    },
    updateAttachedPermissions: (_id, permissions) => {
      for (const service of allServices) service.updatePermissions(permissions);
    },
  });
  const httpServer = createHTTPServer((request, response) => {
    if (request.url === "/health" || request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const wsServer = new ExecutionWebSocketServer({
    httpServer,
    config,
    serverId,
    version: config.daemonVersion ?? resolveDaemonVersion(import.meta.url),
    agentManager,
    agentStorage,
    providers: runtime.snapshotManager,
    hubRelationships,
    localBackend,
    workspaceRegistry,
    recovery,
    logger,
  });
  const target = parseListenString(config.listen);
  let bound: ListenTarget | null = null;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      await hubRelationships.stop();
      for (const service of services.values()) service.close();
      await wsServer.close();
      agentManager.prepareForShutdown();
      await agentManager.flushForShutdown();
      await Promise.allSettled(
        agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)),
      );
      await agentManager.flush();
      await agentStorage.flush();
      detachPersistence();
      await runtime.shutdown();
      await workspaceGitService.dispose();
      httpServer.closeAllConnections();
      if (httpServer.listening)
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          }),
        );
      bound = null;
    })());
  return {
    config,
    agentManager,
    agentStorage,
    getListenTarget: () => bound,
    start: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject);
          const listening = () => {
            httpServer.off("error", reject);
            resolve();
          };
          if (target.type === "tcp") httpServer.listen(target.port, target.host, listening);
          else httpServer.listen(target.path, listening);
        });
        bound = resolveBoundListenTarget(target, httpServer);
        if (target.type === "socket") {
          /* Node owns unlinking the socket on close. */
        }
        await hubRelationships.start();
        logger.info({ listen: formatListenTarget(bound) }, "Miko execution daemon listening");
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
  };
}
