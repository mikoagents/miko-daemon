import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolvePaseoHome } from "../paseo-home.js";
import { loadConfig } from "../config.js";
test("Miko state and default network/features remain separate from Paseo", async () => {
  const root = await mkdtemp(join(tmpdir(), "miko-defaults-"));
  try {
    const home = join(root, "miko");
    expect(resolvePaseoHome({ MIKO_HOME: home, PASEO_HOME: join(root, "original-paseo") })).toBe(
      home,
    );
    const config = loadConfig(home, { env: {} });
    expect(config.paseoHome).toBe(home);
    expect(config.relayEnabled).toBe(false);
    expect(config.webUi.enabled).toBe(false);
    expect(config.mcpInjectIntoAgents).toBe(false);
    expect(config.speech.providers.dictationStt.enabled).toBe(false);
    expect(config.speech.providers.voiceTts.enabled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
