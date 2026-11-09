import { defineConfig, configDefaults } from "vitest/config";
export default defineConfig({
  test: {
    env: { PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000" },
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, "**/.dev/**", "**/dist/**"],
  },
});
