import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import { generateKeyPairSync } from "node:crypto";
interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}
function generateKeyPair(): KeyPair {
  const pair = generateKeyPairSync("x25519");
  const publicKey = pair.publicKey.export({ format: "jwk" });
  const secretKey = pair.privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.from(publicKey.x!, "base64url"),
    secretKey: Buffer.from(secretKey.d!, "base64url"),
  };
}
function importPublicKey(value: string): Uint8Array {
  return decodeKey(value);
}
function importSecretKey(value: string): Uint8Array {
  return decodeKey(value);
}
function decodeKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("Invalid X25519 key length");
  return bytes;
}
function exportPublicKey(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
function exportSecretKey(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

const KeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

export interface DaemonKeyPairBundle {
  keyPair: KeyPair;
  publicKeyB64: string;
}

export async function loadOrCreateDaemonKeyPair(
  paseoHome: string,
  logger?: pino.Logger,
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = path.join(paseoHome, KEYPAIR_FILENAME);

  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const raw = readFileSync(filePath, "utf8");
      const parsed = KeyPairSchema.parse(JSON.parse(raw));

      const publicKey = importPublicKey(parsed.publicKeyB64);
      const secretKey = importSecretKey(parsed.secretKeyB64);
      const publicKeyB64 = exportPublicKey(publicKey);

      log?.info({ filePath }, "Loaded daemon keypair");
      return { keyPair: { publicKey, secretKey }, publicKeyB64 };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  const keyPair = generateKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  const secretKeyB64 = exportSecretKey(keyPair.secretKey);

  const payload: StoredKeyPair = {
    v: 2,
    publicKeyB64,
    secretKeyB64,
  };

  writePrivateFileAtomicSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  log?.info({ filePath }, "Saved daemon keypair");

  return { keyPair, publicKeyB64 };
}
