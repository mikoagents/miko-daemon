import type { Logger } from "pino";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import type {
  CreatePaseoWorktreeInput,
  CreatePaseoWorktreeResult,
} from "./paseo-worktree-service.js";
export interface AgentWorktreeSetupContinuation {
  kind: "agent";
  startAfterAgentCreate(input: { agentId: string }): void;
}
export type CreatePaseoWorktreeSetupContinuationInput =
  | { kind: "workspace" }
  | {
      kind: "agent";
      appendTimelineItem(input: { agentId: string; item: AgentTimelineItem }): Promise<boolean>;
      emitLiveTimelineItem(input: { agentId: string; item: AgentTimelineItem }): Promise<boolean>;
      logger: Logger;
    };
export type CreatePaseoWorktreeWorkflowResult = CreatePaseoWorktreeResult & {
  setupContinuation?: AgentWorktreeSetupContinuation;
};
export type CreatePaseoWorktreeWorkflowFn = (
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
  },
) => Promise<CreatePaseoWorktreeWorkflowResult>;
