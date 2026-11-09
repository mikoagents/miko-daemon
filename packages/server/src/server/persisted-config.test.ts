import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  loadPersistedConfig,
  savePersistedConfig,
  PersistedConfigSchema,
} from "./persisted-config.js";

test("persists explicit execution configuration in a private file", async () => {
  const home = await mkdtemp(join(tmpdir(), "miko-persisted-"));
  try {
    const initial = loadPersistedConfig(home);
    const next = {
      ...initial,
      agents: {
        providers: {
          review: {
            label: "Review",
            extends: "codex",
            models: [{ id: "native-model", label: "Native model" }],
          },
        },
      },
    };
    savePersistedConfig(home, next);
    expect(loadPersistedConfig(home)).toEqual(next);
    if (process.platform !== "win32")
      expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test.each([
  { features: { dictation: { enabled: true } } },
  { pluginsEnabled: true },
  { agents: { providers: { codex: { paseoTools: { enabled: true } } } } },
  { daemon: { relay: { enabled: true } } },
  { daemon: { browserTools: { enabled: true } } },
])("rejects removed product configuration instead of silently accepting it: %j", (value) => {
  expect(PersistedConfigSchema.safeParse(value).success).toBe(false);
});
