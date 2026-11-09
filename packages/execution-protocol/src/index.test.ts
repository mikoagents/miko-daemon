import { expect, test } from "vitest";
import {
  CreateOptionsSchema,
  RequestSchema,
  AgentSnapshotSchema,
  EXECUTION_PROTOCOL_VERSION as version,
} from "./index.js";
test("the public execution version is exact and independent of native protocol versions", () => {
  const request = {
    type: "miko.request",
    version,
    operation: "discover",
    requestId: "request",
    input: {},
  };
  expect(RequestSchema.safeParse(request).success).toBe(true);
  expect(RequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false);
  expect(
    AgentSnapshotSchema.safeParse({ id: "session", workspaceId: "workspace", status: "idle" })
      .success,
  ).toBe(false);
});
test("custom provider options and every supported worktree mode survive schema validation", () => {
  const options = {
    backend: "remote",
    provider: "profile",
    cwd: "/repo",
    env: { TASK: "value" },
    toolPolicy: { preapproved: [] },
    providerOptions: { custom: { nested: [true, null, 3] } },
    worktree: { mode: "checkout-pr", prNumber: 42 },
  };
  expect(CreateOptionsSchema.parse(options)).toEqual(options);
});
