import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { WebSocketLike } from "../websocket-server.js";
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

/** A native session on the existing WebSocket server, without a second process or session owner. */
export class LocalBackendSocket extends EventEmitter implements WebSocketLike {
  readyState: number = WebSocket.OPEN;
  constructor(private readonly receive: (value: unknown) => void) {
    super();
  }
  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    try {
      if (typeof data === "string") this.receive(JSON.parse(data));
      callback?.();
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error("invalid_native_frame"));
    }
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, reason);
  }
}
export interface BackendConnection {
  backend: PaseoBackend;
  close(): void;
}
export async function openBackend(input: {
  id: string;
  config: Backends;
  onClose(): void;
  attachLocal(socket: WebSocketLike): Promise<void>;
}): Promise<BackendConnection> {
  let connection: BackendConnection;
  if (input.id === "local") {
    const socket = new LocalBackendSocket((value) => backend.receive(value));
    const backend = new PaseoBackend((frame) => {
      socket.emit("message", frame);
    });
    socket.on("close", () => {
      backend.close();
      input.onClose();
    });
    connection = { backend, close: () => socket.close() };
    const ready = boundedReady(backend);
    await input.attachLocal(socket);
    await ready.catch((error) => {
      connection.close();
      throw error;
    });
    return connection;
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
        clientId: "miko:hub",
        clientType: "cli",
        protocolVersion: 1,
        capabilities: { all_providers: true, selective_agent_timeline: true },
      }),
    ),
  );
  socket.on("error", () => backend.close());
  socket.on("close", () => {
    backend.close();
    input.onClose();
  });
  await boundedReady(backend).catch((error) => {
    socket.terminate();
    throw error;
  });
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
