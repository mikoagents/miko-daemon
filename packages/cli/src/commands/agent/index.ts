import { Command } from "commander";
import { addInspectOptions, runInspectCommand } from "./inspect.js";
import { addLogsOptions, runLogsCommand } from "./logs.js";
import { addLsOptions, runLsCommand } from "./ls.js";
import { withOutput } from "../../output/index.js";
import { addDaemonHostOption, addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createAgentCommand(): Command {
  const agent = new Command("agent").description("Inspect agents and their execution history");
  addJsonAndDaemonHostOptions(addLsOptions(agent.command("ls"))).action(withOutput(runLsCommand));
  addJsonAndDaemonHostOptions(addInspectOptions(agent.command("inspect"))).action(
    withOutput(runInspectCommand),
  );
  addDaemonHostOption(addLogsOptions(agent.command("logs"))).action(runLogsCommand);
  return agent;
}
