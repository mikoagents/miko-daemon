import { connectToDaemon } from "../utils/client.js";
import { Command } from "commander";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { diagnoseExecutionBackend, resolvePaseoHome } from "@getpaseo/server";
import { z } from "zod";
import { addJsonOption } from "../utils/command-options.js";
import {
  type OutputSchema,
  type CommandOptions,
  type ListResult,
  type SingleResult,
  withOutput,
} from "../output/index.js";

const ConfigSchema = z.record(
  z.string(),
  z.object({ type: z.literal("paseo"), url: z.string().url(), token: z.string() }),
);
async function readConfig() {
  try {
    return ConfigSchema.parse(
      JSON.parse(await readFile(join(resolvePaseoHome(), "miko-backends.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
async function saveConfig(config: z.infer<typeof ConfigSchema>) {
  const home = resolvePaseoHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `.miko-backends-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temporary, join(home, "miko-backends.json"));
}
interface BackendRow {
  id: string;
  type: string;
  url?: string;
  restartRequired?: boolean;
}
const schema: OutputSchema<BackendRow> = {
  idField: "id",
  columns: [
    { header: "Backend", field: "id" },
    { header: "Type", field: "type" },
    { header: "Endpoint", field: "url" },
  ],
  renderHuman(result) {
    return JSON.stringify(result.data, null, 2);
  },
};
interface DiagnosticRow {
  backend: string;
  provider: string;
  status: string;
  models: number;
  exactMcpPreapproval: boolean;
}
const diagnosticSchema: OutputSchema<DiagnosticRow> = {
  idField: "provider",
  columns: [
    { header: "Backend", field: "backend" },
    { header: "Provider", field: "provider" },
    { header: "Status", field: "status" },
    { header: "Models", field: "models" },
    { header: "Exact MCP preapproval", field: "exactMcpPreapproval" },
  ],
};
export function createBackendCommand(): Command {
  const command = new Command("backend").description(
    "Configure Hub execution backends (restart daemon after changes)",
  );
  addJsonOption(command.command("ls")).action(
    withOutput(
      async (_options: CommandOptions, _command: Command): Promise<ListResult<BackendRow>> => ({
        type: "list" as const,
        schema,
        data: [
          { id: "local", type: "local" },
          ...Object.entries(await readConfig()).map(([id, value]) => ({
            id,
            type: value.type,
            url: new URL(value.url).origin,
          })),
        ],
      }),
    ),
  );
  addJsonOption(
    command
      .command("add")
      .argument("<id>")
      .requiredOption("--url <url>", "Paseo native WebSocket endpoint")
      .requiredOption("--token-file <path>", "Read the native service bearer from a private file"),
  ).action(
    withOutput(
      async (
        id: string,
        options: CommandOptions,
        _command: Command,
      ): Promise<SingleResult<BackendRow>> => {
        if (!/^[a-z][a-z0-9_-]*$/.test(id) || id === "local")
          throw new Error("Choose a backend ID other than local");
        const url = new URL(z.string().parse(options.url));
        if (
          !["ws:", "wss:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Use a ws/wss URL without embedded credentials");
        const token = (await readFile(z.string().parse(options.tokenFile), "utf8")).trim();
        if (!token) throw new Error("Token file is empty");
        const config = await readConfig();
        if (config[id]) throw new Error("Backend already exists; remove it first");
        config[id] = { type: "paseo", url: url.href, token };
        await saveConfig(config);
        return {
          type: "single" as const,
          schema,
          data: { id, type: "paseo", restartRequired: true },
        };
      },
    ),
  );
  addJsonOption(command.command("remove").argument("<id>")).action(
    withOutput(
      async (
        id: string,
        _options: CommandOptions,
        _command: Command,
      ): Promise<SingleResult<BackendRow>> => {
        const config = await readConfig();
        if (!config[id]) throw new Error("Backend not found");
        delete config[id];
        await saveConfig(config);
        return {
          type: "single" as const,
          schema,
          data: { id, type: "removed", restartRequired: true },
        };
      },
    ),
  );
  addJsonOption(
    command
      .command("diagnostic")
      .description("Read backend connectivity, provider availability and capabilities")
      .argument("<id>"),
  ).action(
    withOutput(
      async (
        id: string,
        options: CommandOptions,
        _command: Command,
      ): Promise<ListResult<DiagnosticRow>> => {
        let snapshot;
        if (id === "local") {
          const client = await connectToDaemon({ host: options.host });
          try {
            snapshot = await client.getProvidersSnapshot();
          } finally {
            await client.close();
          }
        } else snapshot = await diagnoseExecutionBackend(resolvePaseoHome(), id);
        return {
          type: "list",
          schema: diagnosticSchema,
          data: snapshot.entries.map((entry) => ({
            backend: id,
            provider: entry.provider,
            status: entry.status,
            models: entry.models?.length ?? 0,
            exactMcpPreapproval: entry.supportsExactMcpPreapproval ?? false,
          })),
        };
      },
    ),
  );
  return command;
}
