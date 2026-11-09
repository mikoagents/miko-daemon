import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import { fetchProjectedTimelineItems } from "../../utils/timeline.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamMessage } from "@getpaseo/protocol/messages";
import { curateAgentActivity } from "@getpaseo/server";

export function addLogsOptions(cmd: Command): Command {
  return cmd
    .description("View agent activity/timeline")
    .argument("<id>", "Agent ID (or prefix)")
    .option("-f, --follow", "Follow log output (streaming)")
    .option("--tail <n>", "Show last n entries")
    .option("--filter <type>", "Filter by event type (tools, text, errors, permissions)")
    .option("--since <time>", "Show logs since timestamp");
}

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean;
  tail?: string;
  filter?: string;
  since?: string;
}

// Logs command returns void - it outputs directly to console
export type AgentLogsResult = void;

export const NO_ACTIVITY_MESSAGE = "No activity to display.";

export async function fetchAgentTimelineItems(
  client: DaemonClient,
  agentId: string,
  options?: { timeoutMs?: number },
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({ client, agentId, timeoutMs: options?.timeoutMs });
}

export function formatAgentActivityTranscript(
  timelineItems: AgentTimelineItem[],
  tailCount?: number,
): string {
  if (tailCount === 0) {
    return "";
  }
  return curateAgentActivity(
    timelineItems,
    tailCount !== undefined ? { maxItems: tailCount } : undefined,
  );
}

function parseTailCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Check if a timeline item matches the filter type
 */
function matchesFilter(item: AgentTimelineItem, filter?: string): boolean {
  if (!filter) return true;

  const filterLower = filter.toLowerCase();
  const type = item.type.toLowerCase();

  switch (filterLower) {
    case "tools":
      return type === "tool_call";
    case "text":
      return type === "user_message" || type === "assistant_message" || type === "reasoning";
    case "errors":
      return type === "error";
    case "permissions":
      // Permissions might be in tool_call status or a separate event type
      return type.includes("permission");
    default:
      // If filter doesn't match predefined types, match against the actual type
      return type.includes(filterLower);
  }
}

export async function runLogsCommand(
  id: string,
  options: AgentLogsOptions,
  _command: Command,
): Promise<AgentLogsResult> {
  const host = getDaemonHost({ host: options.host });

  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: miko agent logs <id>");
    process.exit(1);
  }

  const json = options.json || _command.optsWithGlobals()["json"] === true;
  const tailCount = parseTailCount(options.tail);
  if (options.tail !== undefined && tailCount === undefined)
    throw new Error("Invalid --tail value; expected a nonnegative integer");
  if (options.since && Number.isNaN(Date.parse(options.since)))
    throw new Error("Invalid --since timestamp");
  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Cannot connect to daemon at ${host}: ${message}`);
    console.error("Start the daemon with: miko daemon start");
    process.exit(1);
  }

  try {
    const fetchResult = await client.fetchAgent(id);
    if (!fetchResult) {
      console.error(`Error: No agent found matching: ${id}`);
      console.error("Use `miko agent ls` to list available agents");
      await client.close();
      process.exit(1);
    }
    const resolvedId = fetchResult.agent.id;

    // For follow mode, we stream events continuously
    if (options.follow) {
      await runFollowMode(client, resolvedId, { ...options, json });
      return;
    }

    // Fetch timeline directly via cursor RPC.
    let timelineItems = await fetchAgentTimelineItems(client, resolvedId);

    if (options.since) {
      const since = Date.parse(options.since);
      if (Number.isNaN(since)) throw new Error("Invalid --since timestamp");
      timelineItems = timelineItems.filter(
        (item) =>
          "timestamp" in item &&
          typeof item.timestamp === "string" &&
          Date.parse(item.timestamp) >= since,
      );
    }
    // Apply filter
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter));
    }

    if (json) {
      let selected = timelineItems;
      if (tailCount !== undefined)
        selected = tailCount === 0 ? [] : timelineItems.slice(-tailCount);
      console.log(JSON.stringify(selected, null, 2));
      await client.close();
      return;
    }
    await client.close();

    // Use curateAgentActivity to format the transcript
    if (tailCount === 0) {
      return;
    }

    const transcript = formatAgentActivityTranscript(timelineItems, tailCount);
    console.log(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to get logs: ${message}`);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode(
  client: DaemonClient,
  agentId: string,
  options: AgentLogsOptions,
): Promise<void> {
  const tailCount = parseTailCount(options.tail) ?? 10;
  let bootstrapping = true;
  const buffered: AgentStreamMessage[] = [];
  let epoch: string | undefined;
  let sequence = 0;
  const print = (item: AgentTimelineItem, timestamp?: string) => {
    if (!matchesFilter(item, options.filter)) return;
    if (options.since && (!timestamp || Date.parse(timestamp) < Date.parse(options.since))) return;
    if (options.json) console.log(JSON.stringify({ ...item, timestamp }));
    else {
      const transcript = formatAgentActivityTranscript([item]);
      if (transcript !== NO_ACTIVITY_MESSAGE) console.log(transcript);
    }
  };
  const receive = (message: AgentStreamMessage) => {
    const payload = message.payload;
    if (payload.agentId !== agentId || payload.event.type !== "timeline") return;
    if (payload.epoch === epoch && payload.seq !== undefined && payload.seq <= sequence) return;
    if (payload.epoch !== undefined) epoch = payload.epoch;
    if (payload.seq !== undefined) sequence = payload.seq;
    print(payload.event.item, payload.timestamp);
  };
  const unsubscribe = client.on("agent_stream", (message) => {
    if (bootstrapping) buffered.push(message);
    else receive(message);
  });
  const interest = client.observeAgentTimeline(agentId);
  try {
    await interest.ready;
    const history = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    epoch = history.epoch;
    sequence = history.window.maxSeq;
    let entries = history.entries.filter(
      (entry) =>
        matchesFilter(entry.item, options.filter) &&
        (!options.since || Date.parse(entry.timestamp) >= Date.parse(options.since)),
    );
    entries = tailCount === 0 ? [] : entries.slice(-tailCount);
    for (const entry of entries) print(entry.item, entry.timestamp);
    bootstrapping = false;
    for (const message of buffered.splice(0)) receive(message);
    if (!options.json) console.log("\n--- Following logs (Ctrl+C to stop) ---\n");
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } finally {
    unsubscribe();
    try {
      await client.close();
    } finally {
      interest();
    }
  }
}
