import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MIKO_PRODUCT } from "@getpaseo/protocol/miko-product";
import { ProviderOverridesSchema } from "./agent/provider-launch-config.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";
export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const LogFormatSchema = z.enum(["pretty", "json"]);

const LogConfigSchema = z
  .object({
    // Legacy global log settings (kept for backwards compatibility).
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),

    console: z
      .object({
        level: LogLevelSchema.optional(),
        format: LogFormatSchema.optional(),
      })
      .strict()
      .optional(),

    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).optional(),
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        appendSystemPrompt: z.string().optional(),
        cors: z
          .object({ allowedOrigins: z.array(z.string()).optional() })
          .strict()
          .optional(),
        auth: z
          .object({ password: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    worktrees: z
      .object({ root: z.string().min(1).optional() })
      .strict()
      .optional(),
    agents: z
      .object({
        providers: ProviderOverridesSchema.optional(),
        catalogRefreshTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
      })
      .strict()
      .optional(),
    log: LogConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [provider, value] of Object.entries(config.agents?.providers ?? {})) {
      if (value.paseoTools !== undefined)
        context.addIssue({
          code: "custom",
          path: ["agents", "providers", provider, "paseoTools"],
          message:
            "Miko does not host Paseo orchestration tools; configure explicit external MCP servers for each execution",
        });
    }
  });
export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;
const CONFIG_FILENAME = "config.json";
const DEFAULT_PERSISTED_CONFIG: PersistedConfig = {
  version: 1,
  daemon: { listen: "127.0.0.1:" + MIKO_PRODUCT.port, cors: { allowedOrigins: [] } },
};
interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

export function loadPersistedConfig(paseoHome: string, logger?: LoggerLike): PersistedConfig {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  if (!existsSync(configPath)) {
    try {
      writePrivateFileAtomicSync(
        configPath,
        JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
      );
      log?.info(`Initialized config file at ${configPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
    }
  }

  let raw: string;
  try {
    ensurePrivateFile(configPath);
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const result = PersistedConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config in ${configPath}:\n${issues}`);
  }

  log?.info(`Loaded from ${configPath}`);
  return result.data;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config to save:\n${issues}`);
  }

  try {
    writePrivateFileAtomicSync(configPath, JSON.stringify(result.data, null, 2) + "\n");
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, {
      cause: err,
    });
  }
}
