import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { ExecutionBackend } from "./local-backend.js";
import { PaseoBackend } from "./paseo-backend.js";

export const BackendsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_-]*$/),
    z
      .object({
        type: z.literal("paseo"),
        url: z
          .string()
          .url()
          .refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol)),
        token: z.string().min(1),
      })
      .strict(),
  )
  .refine((value) => !("local" in value), "local is reserved");
export type Backends = z.infer<typeof BackendsSchema>;
export async function readBackends(home: string): Promise<Backends> {
  try {
    return BackendsSchema.parse(
      JSON.parse(await readFile(join(home, "miko-backends.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export interface BackendConnection {
  backend: ExecutionBackend;
  close(): void;
}
export async function openBackend(input: {
  id: string;
  clientId: string;
  config: Backends;
  onClose(): void;
  localBackend?: ExecutionBackend;
}): Promise<BackendConnection> {
  let connection: BackendConnection;
  let established = false;
  if (input.id === "local") {
    if (!input.localBackend) throw new Error("local_backend_unavailable");
    return { backend: input.localBackend, close() {} };
  }
  const config = input.config[input.id];
  if (!config) throw new Error("backend_not_found");
  const socket = new WebSocket(config.url, {
    headers: { authorization: `Bearer ${config.token}` },
    handshakeTimeout: 15_000,
  });
  const backend = new PaseoBackend((frame) => socket.send(frame));
  connection = { backend, close: () => socket.close() };
  socket.on("message", (data) => {
    try {
      backend.receive(JSON.parse(data.toString()));
    } catch {
      socket.close(4400, "invalid native message");
    }
  });
  socket.once("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: input.clientId,
        clientType: "cli",
        protocolVersion: 1,
        capabilities: { all_providers: true, selective_agent_timeline: true },
      }),
    ),
  );
  socket.on("error", () => backend.close());
  socket.on("close", () => {
    backend.close();
    if (established) input.onClose();
  });
  await boundedReady(backend).catch((error) => {
    socket.terminate();
    throw error;
  });
  established = true;
  return connection;
}
async function boundedReady(backend: PaseoBackend): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      backend.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("backend_handshake_timeout")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
