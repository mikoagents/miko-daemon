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
    operation: "providers",
    requestId: "request",
    input: {},
  };
  expect(RequestSchema.safeParse(request).success).toBe(true);
  expect(RequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false);
  expect(RequestSchema.safeParse({ ...request, version: "1.0.0" }).success).toBe(false);
  expect(RequestSchema.safeParse({ ...request, operation: "discover" }).success).toBe(false);
  for (const operation of ["providers", "refresh"])
    expect(
      RequestSchema.safeParse({ ...request, operation, input: { backend: "local" } }).success,
    ).toBe(false);
  expect(
    AgentSnapshotSchema.safeParse({ id: "session", workspaceId: "workspace", status: "idle" })
      .success,
  ).toBe(false);
});
test("custom provider options and every supported worktree mode survive schema validation", () => {
  const options = {
    provider: "profile",
    cwd: "/repo",
    env: { TASK: "value" },
    toolPolicy: { preapproved: [] },
    providerOptions: { custom: { nested: [true, null, 3] } },
    worktree: { mode: "checkout-pr", prNumber: 42 },
  };
  expect(CreateOptionsSchema.parse(options)).toEqual(options);
  expect(CreateOptionsSchema.safeParse({ ...options, backend: "local" }).success).toBe(false);
});
