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
    expect(config.listen).toBe("127.0.0.1:7767");
    expect(config).not.toHaveProperty("relayEnabled");
    expect(config).not.toHaveProperty("speech");
    expect(config).not.toHaveProperty("webUi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
