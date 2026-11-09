import { createCli } from "./cli.js";
export interface RunCliOptions {
  cwd?: string;
  nodeArgv?: [string, string];
}
export function createCliParseArgv(input: {
  argv: string[];
  cwd: string;
  nodeArgv?: [string, string];
}): string[] {
  return [
    ...(input.nodeArgv ?? ["node", "miko"]),
    ...(input.argv.length ? input.argv : ["--help"]),
  ];
}
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  await createCli().parseAsync(
    createCliParseArgv({ argv, cwd: options.cwd ?? process.cwd(), nodeArgv: options.nodeArgv }),
    { from: "node" },
  );
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
