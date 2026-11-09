import { randomUUID } from "node:crypto";
import { BackendIdSchema, type HubProviderSnapshot } from "@mikoagents/execution-protocol";
import { openBackend, readBackends } from "./backends.js";

/** Read-only native discovery on a separate client identity, without creating an agent. */
export async function diagnoseExecutionBackend(
  home: string,
  id: string,
): Promise<HubProviderSnapshot> {
  BackendIdSchema.parse(id);
  if (id === "local") throw new Error("Use the daemon client for local diagnostics");
  const connection = await openBackend({
    id,
    clientId: `miko:diagnostic:${randomUUID()}:${id}`,
    config: await readBackends(home),
    onClose: () => {},
  });
  try {
    return await connection.backend.providers({});
  } finally {
    connection.close();
  }
}
