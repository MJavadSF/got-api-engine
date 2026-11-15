// ── Keyed fingerprints (HMAC) for cache / dedupe keys ────────────
//
// Plain SHA-256 of a credential is guessable offline for low-entropy secrets
// (Basic auth passwords, short API keys) if keys leak from a shared store.
// HMAC with a secret makes that infeasible.

import { createHmac, randomBytes } from "node:crypto";
import type { HeaderMap } from "../types/http";

const MEMO_LIMIT = 512;

export class Fingerprinter {
  private readonly secret: Buffer;
  /**
   * Credentials rarely change between requests: memoise their HMAC (in-process
   * only, bounded). Saves an HMAC per request on the hot path.
   */
  private readonly memo = new Map<string, string>();

  constructor(secret?: string) {
    this.secret = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
  }

  hash(input: string | Buffer, length = 22): string {
    return createHmac("sha256", this.secret).update(input).digest("base64url").slice(0, length);
  }

  /** Credentials → stable opaque id ("" when none). */
  credentials(headers: HeaderMap): string {
    const keys = Object.keys(headers);
    if (keys.length === 0) return "";
    const material =
      keys.length === 1
        ? `${(keys[0] as string).toLowerCase()}:${headers[keys[0] as string]}`
        : keys
            .map((k) => `${k.toLowerCase()}:${headers[k]}`)
            .sort()
            .join("\n");
    return this.memoised(material, 22);
  }

  private memoised(material: string, length: number): string {
    let fp = this.memo.get(material);
    if (fp === undefined) {
      if (this.memo.size >= MEMO_LIMIT) this.memo.clear();
      fp = this.hash(material, length);
      this.memo.set(material, fp);
    }
    return fp;
  }

  /** Header variants + response type → id ("" for the default variant). */
  variant(headers: HeaderMap | undefined, responseType: string, defaultResponseType: string): string {
    const entries = Object.entries(headers ?? {})
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0 && responseType === defaultResponseType) return "";
    return this.hash(JSON.stringify([entries, responseType]), 16);
  }
}
