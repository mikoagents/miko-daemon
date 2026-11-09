import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  result: z.unknown().optional(),
});
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) =>
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
          ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)))
          : candidate,
      ),
    )
    .digest("hex");
}
/** Persist before invoking the native backend. An unresolved submission is never repeated. */
export class RequestJournal {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}
  async receipt(key: string) {
    try {
      return ReceiptSchema.parse(
        JSON.parse(await readFile(join(this.directory, `${digest(key)}.json`), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  execute(
    key: string,
    input: unknown,
    run: () => Promise<unknown>,
    recoverable = false,
  ): Promise<unknown> {
    const previous = this.pending.get(key);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.once(key, input, run, recoverable),
    );
    this.pending.set(key, work);
    void work
      .finally(() => {
        if (this.pending.get(key) === work) this.pending.delete(key);
      })
      .catch(() => undefined);
    return work;
  }
  private async once(
    key: string,
    input: unknown,
    run: () => Promise<unknown>,
    recoverable: boolean,
  ) {
    const fingerprint = digest(input),
      existing = await this.receipt(key);
    if (existing && existing.fingerprint !== fingerprint) throw new Error("request_key_conflict");
    if (existing?.state === "completed") return existing.result;
    if (existing && !recoverable) throw new Error("request_outcome_unknown");
    const file = join(this.directory, `${digest(key)}.json`);
    writePrivateFileAtomicSync(file, JSON.stringify({ fingerprint, state: "pending" }));
    const result = await run();
    writePrivateFileAtomicSync(file, JSON.stringify({ fingerprint, state: "completed", result }));
    return result;
  }
}
