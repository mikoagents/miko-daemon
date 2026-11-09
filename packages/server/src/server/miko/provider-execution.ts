import type { z } from "zod";
import { digest } from "./journal.js";
import type { Logger } from "pino";
import {
  HubExecutionAgentStreamEventSchema,
  ProviderSnapshotSchema,
  type CreateOptions,
  type HubProviderSnapshot,
  ValidationSchema,
} from "@mikoagents/execution-protocol";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { AgentRequests } from "../agent/requests/index.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
type AgentSnapshot = Pick<
  import("@mikoagents/execution-protocol").AgentSnapshot,
  "id" | "workspaceId" | "status" | "archivedAt"
>;
export type ProviderExecutionEvent =
  | { type: "agent_update" | "agent_snapshot"; agent: AgentSnapshot; timestamp: string }
  | {
      type: "agent_stream";
      agentId: string;
      event: import("@mikoagents/execution-protocol").HubExecutionAgentStreamEvent;
      timestamp: string;
    };

export interface ExecutionRuntime {
  create(key: string, options: CreateOptions): Promise<AgentSnapshot>;
  get(agentId: string): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string): Promise<void>;
  restore(workspaceId: string): Promise<boolean>;
  control(agentId: string, workspaceId: string, action: "interrupt" | "archive"): Promise<void>;
  watch(agentId: string, listener: (event: ProviderExecutionEvent) => void): Promise<() => void>;
  providers(options: { cwd?: string }): Promise<HubProviderSnapshot>;
  refresh(options: { cwd?: string; providers?: string[] }): Promise<void>;
  setAuthority?(enabled: boolean): void;
  validate(options: z.infer<typeof ValidationSchema>): Promise<unknown>;
}
export interface ProviderExecutionOptions {
  requests: AgentRequests;
  cleanupFailedCreate(worktree: CreatePaseoWorktreeWorkflowResult): Promise<void>;
  ownerId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providers: ProviderSnapshotManager;
  workspaceRegistry: WorkspaceRegistry;
  createAgent: BoundCreateAgentCommand;
  restoreWorkspace(workspaceId: string): Promise<boolean>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  logger: Logger;
}

/** Uses the existing provider/session owner directly; no native socket or product server. */
export class ProviderExecution implements ExecutionRuntime {
  private generation = 0;
  private authorized = true;
  constructor(private readonly options: ProviderExecutionOptions) {}
  setAuthority(enabled: boolean): void {
    if (this.authorized !== enabled) {
      this.authorized = enabled;
      this.generation++;
    }
  }
  private requireAuthority(generation = this.generation): void {
    if (!this.authorized || generation !== this.generation)
      throw new Error("execution_not_allowed");
  }
  async providers(options: { cwd?: string }) {
    const entries = await this.options.providers.listProviders({ ...options, wait: true });
    // Apply the same JSON boundary as native transport: omit optional undefined metadata.
    return ProviderSnapshotSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...options,
          entries,
          generatedAt: new Date().toISOString(),
        }),
      ),
    );
  }
  async refresh(options: { cwd?: string; providers?: string[] }) {
    if (options.cwd)
      await this.options.providers.refreshSnapshotForCwd({ ...options, cwd: options.cwd });
    else await this.options.providers.refreshSettingsSnapshot(options);
  }
  async validate(options: z.infer<typeof ValidationSchema>) {
    const entry = (
      await this.options.providers.listProviders({ providers: [options.provider], wait: true })
    ).find((value) => value.provider === options.provider);
    if (!entry?.supportsExactMcpPreapproval)
      return {
        valid: false,
        issues: [
          {
            path: ["provider"],
            message:
              "Provider does not declare exact MCP preapproval support for unattended execution",
          },
        ],
      };
    const { mode, ...rest } = options;
    const issues = await this.options.providers.validateAgentConfiguration({
      ...rest,
      modeId: mode,
    });
    return issues.length ? { valid: false, issues } : { valid: true };
  }
  async create(key: string, options: CreateOptions): Promise<AgentSnapshot> {
    this.requireAuthority();
    const generation = this.generation;
    const { agentManager, agentStorage, createAgent, workspaceRegistry, ownerId } = this.options;
    const id = await this.options.requests.create({
      key: digest([ownerId, key]),
      request: options,
      findAgent: async (agentId) => Boolean(await agentStorage.get(agentId)),
      create: async (agentId) => {
        this.requireAuthority(generation);
        let createdWorktree: CreatePaseoWorktreeWorkflowResult | undefined;
        try {
          // Native command owns provider validation and worktree rollback boundaries.
          const result = await createAgent({
            kind: "mcp",
            provider: options.provider,
            title: options.title ?? "",
            cwd: options.cwd,
            mode: options.mode,
            thinking: options.thinkingOptionId,
            config: {
              model: options.model,
              providerOptions: options.providerOptions,
              mcpServers: options.mcpServers,
              toolPolicy: options.toolPolicy,
            },
            env: options.env,
            background: options.background ?? true,
            notifyOnFinish: false,
            owner: { kind: "daemon", daemonId: ownerId, executionId: key },
            worktree: executionWorktree(options.worktree),
            agentId,
            onWorktreeCreated: (worktree) => {
              if (worktree.created) createdWorktree = worktree;
            },
          });
          this.requireAuthority(generation);
          await agentStorage.applySnapshot(result.liveSnapshot);
          await agentStorage.flush();
        } catch (error) {
          if (agentManager.getAgent(agentId)) await agentManager.closeAgent(agentId);
          await agentManager.deleteAgentState(agentId);
          await agentStorage.remove(agentId);
          if (createdWorktree) await this.options.cleanupFailedCreate(createdWorktree);
          throw error;
        }
      },
    });
    const snapshot = await this.get(id);
    if (options.workspaceTitle !== undefined) {
      const workspace = await workspaceRegistry.get(snapshot.workspaceId);
      if (workspace)
        await workspaceRegistry.upsert({ ...workspace, title: options.workspaceTitle });
    }
    // Persisted state is the source of truth even after a lost create acknowledgement.
    if (!agentManager.getAgent(id) && !(await agentStorage.get(id)))
      throw new Error("session_not_found");
    return snapshot;
  }
  async requireOwned(agentId: string) {
    this.requireAuthority();
    const record = await this.options.agentStorage.get(agentId);
    if (
      !record ||
      record.owner?.kind !== "daemon" ||
      record.owner.daemonId !== this.options.ownerId
    )
      throw new Error("session_not_found");
    return record;
  }
  async get(agentId: string): Promise<AgentSnapshot> {
    const record = await this.requireOwned(agentId);
    const live = this.options.agentManager.getAgent(agentId);
    const value = live
      ? serializeAgentSnapshot(live)
      : buildStoredAgentPayload(record, this.options.agentManager.getRegisteredProviderIds());
    if (!value.workspaceId) throw new Error("session_binding_mismatch");
    return {
      id: value.id,
      workspaceId: value.workspaceId,
      status: value.status,
      ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
    };
  }
  async send(agentId: string, messageId: string, text: string) {
    await this.requireOwned(agentId);
    const generation = this.generation;
    const { agentManager, agentStorage, logger } = this.options;
    await this.options.requests.send({
      agentId,
      messageId,
      request: { text },
      prepare: async () => {
        await ensureUnarchivedAgentLoaded(agentId, { agentManager, agentStorage, logger });
      },
      send: async () => {
        this.requireAuthority(generation);
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId,
          prompt: text,
          messageId,
          activeTurnBehavior: "steer",
          logger,
        });
      },
    });
  }
  async restore(workspaceId: string) {
    this.requireAuthority();
    const records = await this.options.agentStorage.listByWorkspace(workspaceId);
    if (
      !records.some(
        (record) =>
          record.owner?.kind === "daemon" && record.owner.daemonId === this.options.ownerId,
      )
    )
      throw new Error("session_not_found");
    return this.options.restoreWorkspace(workspaceId);
  }
  async control(agentId: string, workspaceId: string, action: "interrupt" | "archive") {
    const record = await this.requireOwned(agentId);
    this.requireAuthority();
    if (record.workspaceId !== workspaceId) throw new Error("session_binding_mismatch");
    if (action === "archive") await this.options.archiveWorkspace(workspaceId);
    else if (this.options.agentManager.getAgent(agentId))
      await this.options.agentManager.cancelAgentRun(agentId);
  }
  async watch(
    agentId: string,
    listener: (event: ProviderExecutionEvent) => void,
  ): Promise<() => void> {
    await this.requireOwned(agentId);
    const unsubscribe = this.options.agentManager.subscribe((event) => {
      if (event.type === "agent_state" && event.agent.id === agentId) {
        const snapshot = serializeAgentSnapshot(event.agent);
        if (snapshot.workspaceId)
          listener({
            type: "agent_update",
            agent: { ...snapshot, workspaceId: snapshot.workspaceId },
            timestamp: new Date().toISOString(),
          });
      } else if (event.type === "agent_stream" && event.agentId === agentId) {
        const stream = serializeAgentStreamEvent(event.event);
        if (stream)
          listener({
            type: "agent_stream",
            agentId,
            event: HubExecutionAgentStreamEventSchema.parse(stream),
            timestamp: new Date().toISOString(),
          });
      }
    });
    try {
      listener({
        type: "agent_snapshot",
        agent: await this.get(agentId),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }
}

function executionWorktree(target: CreateOptions["worktree"]) {
  if (!target) return undefined;
  if (target.mode === "branch-off")
    return {
      worktreeName: target.newBranch,
      baseBranch: target.base,
      action: "branch-off" as const,
    };
  if (target.mode === "checkout-branch")
    return { refName: target.branch, action: "checkout" as const };
  return { githubPrNumber: target.prNumber, action: "checkout" as const };
}
