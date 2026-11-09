import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, resolveConfigFromPersisted } from "./config.js";

test("loads isolated Miko defaults and honors explicit listen precedence", async () => {
  const home = await mkdtemp(join(tmpdir(), "miko-config-"));
  try {
    expect(loadConfig(home, { env: {} }).listen).toBe("127.0.0.1:7767");
    expect(
      resolveConfigFromPersisted(
        home,
        { daemon: { listen: "127.0.0.1:7790" } },
        { env: { PASEO_LISTEN: "127.0.0.1:7791" }, cli: { listen: "127.0.0.1:7792" } },
      ).listen,
    ).toBe("127.0.0.1:7792");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("preserves provider profiles and native options", () => {
  const home = join(tmpdir(), "miko");
  const config = resolveConfigFromPersisted(
    home,
    {
      agents: {
        providers: {
          review: {
            label: "Review",
            extends: "codex",
            models: [{ id: "native-model", label: "Native model" }],
            env: { TASK_ENV: "explicit" },
          },
        },
      },
      worktrees: { root: "worktrees" },
    },
    { env: {} },
  );
  expect(config.providerOverrides?.review).toMatchObject({
    extends: "codex",
    models: [{ id: "native-model", label: "Native model" }],
    env: { TASK_ENV: "explicit" },
  });
  expect(config.worktreesRoot).toBe(resolve(home, "worktrees"));
});
