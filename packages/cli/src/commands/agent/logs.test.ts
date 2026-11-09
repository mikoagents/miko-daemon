import { afterEach, expect, test, vi } from "vitest";
import { Command } from "commander";
import { runLogsCommand } from "./logs.js";

const client = vi.hoisted(() => ({
  fetchAgent: vi.fn(async () => ({ agent: { id: "full-agent" } })),
  fetchAgentTimeline: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("../../utils/client.js", () => ({
  connectToDaemon: async () => client,
  getDaemonHost: () => "test",
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("agent logs retains full JSON tool detail and applies timestamp, type and tail filters", async () => {
  client.fetchAgentTimeline.mockResolvedValue({
    entries: [
      { timestamp: "2026-11-09T09:00:00Z", item: { type: "assistant_message", text: "Earlier" } },
      {
        timestamp: "2026-11-09T10:00:00Z",
        item: {
          type: "tool_call",
          name: "Shell",
          detail: { type: "shell", command: "cat file", output: "Detailed tool output" },
        },
      },
    ],
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await runLogsCommand(
    "full",
    { json: true, filter: "tools", tail: "1", since: "2026-11-09T09:30:00Z" },
    new Command(),
  );
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject([
    { type: "tool_call", detail: { command: "cat file", output: "Detailed tool output" } },
  ]);
  expect(client.fetchAgent).toHaveBeenCalledWith("full");
  expect(client.close).toHaveBeenCalledOnce();
});

test("invalid log filters fail before opening a connection", async () => {
  await expect(runLogsCommand("id", { since: "bad-date" }, new Command())).rejects.toThrow(
    "Invalid --since",
  );
  await expect(runLogsCommand("id", { tail: "-1" }, new Command())).rejects.toThrow(
    "Invalid --tail",
  );
  expect(client.fetchAgent).not.toHaveBeenCalled();
});
