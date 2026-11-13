import { expect, test } from "vitest";
import { createCliParseArgv } from "./run.js";
import { createCli } from "./cli.js";
test("defaults to help and exposes execution and diagnostic operations", () => {
  expect(createCliParseArgv({ argv: [], cwd: "/tmp" })).toEqual(["node", "miko", "--help"]);
  expect(
    createCli()
      .commands.map((command) => command.name())
      .sort(),
  ).toEqual(["agent", "daemon", "hub", "provider"]);
  expect(createCliParseArgv({ argv: ["daemon", "status"], cwd: "/tmp" })).toEqual([
    "node",
    "miko",
    "daemon",
    "status",
  ]);
});
