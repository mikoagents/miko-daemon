import type { Command } from "commander";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState } from "./local-daemon.js";
import { resolveCliVersion } from "../../version.js";

interface DaemonStatus {
  status: "running" | "starting" | "stopped" | "stale_pid";
  home: string;
  listen: string;
  pid: number | null;
  startedAt: string | null;
  logPath: string;
  cliVersion: string;
}
const schema: OutputSchema<DaemonStatus> = {
  idField: "status",
  columns: [
    { header: "Status", field: "status" },
    { header: "PID", field: "pid" },
    { header: "Listen", field: "listen" },
    { header: "Home", field: "home" },
    { header: "Logs", field: "logPath" },
  ],
};
export type StatusResult = SingleResult<DaemonStatus>;
export async function runStatusCommand(
  options: CommandOptions,
  _command: Command,
): Promise<StatusResult> {
  const state = resolveLocalDaemonState({
    home: typeof options.home === "string" ? options.home : undefined,
  });
  let status: DaemonStatus["status"] = "stopped";
  if (state.running) {
    const client = await tryConnectToDaemon({ host: state.listen, timeout: 1000 });
    status = client ? "running" : "starting";
    await client?.close();
  } else if (state.stalePidFile) status = "stale_pid";
  return {
    type: "single",
    data: {
      status,
      home: state.home,
      listen: state.listen,
      pid: state.pidInfo?.pid ?? null,
      startedAt: state.pidInfo?.startedAt ?? null,
      logPath: state.logPath,
      cliVersion: resolveCliVersion(),
    },
    schema,
  };
}
