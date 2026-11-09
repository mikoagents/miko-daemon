import { Command } from "commander";
import { MIKO_PRODUCT } from "@getpaseo/protocol/miko-product";
import { createDaemonCommand } from "./commands/daemon/index.js";
import { createProviderCommand } from "./commands/provider/index.js";
import { createHubCommand } from "./commands/hub/index.js";
import { addDaemonHostOption } from "./utils/command-options.js";
import { resolveCliVersion } from "./version.js";
export function createCli(): Command {
  const program = new Command()
    .name(MIKO_PRODUCT.command)
    .description("Miko execution daemon for Hub")
    .version(resolveCliVersion(), "-v, --version")
    .option("-o, --format <format>", "output format: table, json, yaml", "table")
    .option("--json", "output in JSON format")
    .option("-q, --quiet", "minimal output")
    .option("--no-headers", "omit table headers")
    .option("--no-color", "disable colored output");
  addDaemonHostOption(program);
  program.addCommand(createDaemonCommand());
  program.addCommand(createProviderCommand());
  program.addCommand(createHubCommand());
  return program;
}
