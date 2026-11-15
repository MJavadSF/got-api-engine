// ── Response cache policy on top of a CacheStore ─────────────────
//
// Keys, freshness, stale windows, Vary, tags, copy protection and
// resource / tag invalidation. Store errors are logged, never thrown.

import type { ResolvedCacheConfig } from "../core/config";
import { CACHEABLE_STATUS } from "../core/constants";
import { parseCacheControl } from "../http/directives";
import { getHeader } from "../http/headers";
import { cloneBody, deepFreeze } from "../http/transform";
import { normalizeUrl, stripQuery } from "../http/url";
import type { Fingerprinter } from "../security/fingerprint";
import type { CachedResponse, CacheStore, RequestCacheOptions } from "../types/cache";
import type { HeaderMap } from "../types/http";
import type { LoggerInterface } from "../types/observability";
import type { RequestOptions } from "../types/request";
import { buildCacheKey, resourceOfKey } from "./cache-key";

export interface CacheLookupInput {
  method: RequestOptions["method"] & string;
  url: string;
  headers: HeaderMap;
  authFp: string;
  variantFp: string;
  options: RequestOptions<unknown, unknown>;
}

export type Freshness = "fresh" | "stale" | "expired";

export class ResponseCache {
  /** Local tag index for stores without `deleteByTags`. */
  private readonly localTags = new Map<string, Set<string>>();

  constructor(
    readonly cfg: ResolvedCacheConfig,
    readonly store: CacheStore,
    private readonly fp: Fingerprinter,
    private readonly log: LoggerInterface,
  ) {}

  private requestOpts(options: RequestOptions<unknown, unknown>): RequestCacheOptions {
    return typeof options.cache === "object" ? options.cache : {};
  }

  eligible(input: Pick<CacheLookupInput, "method" | "options">): boolean {
    return input.options.cache !== false && input.options.responseType !== "stream" && this.cfg.methods.has(input.method);
  }

  keyFor(input: CacheLookupInput): string {
    const ro = this.requestOpts(input.options);
    const shared = ro.shared ?? this.cfg.shared;
    const custom = (ro.key ?? this.cfg.key)?.({ method: input.method, url: input.url, headers: input.headers });
    return buildCacheKey(
      {
        method: input.method,
        // A custom key replaces the query string and header variants.
        url: custom !== undefined ? stripQuery(input.url) : input.url,
        authFp: shared ? "" : input.authFp,
        variantFp: custom !== undefined ? `k${this.fp.hash(custom, 16)}` : input.variantFp,
      },
      this.fp,
    );
  }

  async get(key: string, headers: HeaderMap): Promise<CachedResponse | undefined> {
    let entry: CachedResponse | undefined;
    try {
      entry = (await this.store.get(key)) ?? undefined;
    } catch (err) {
      this.log.warn("Cache store get failed", { err: String(err) });
      return undefined;
    }
    if (!entry) return undefined;
    if (entry.vary) {
      for (const [name, value] of Object.entries(entry.vary)) {
        if ((getHeader(headers, name) ?? "") !== value) return undefined;
      }
    }
    return this.freshness(entry) === "expired" ? undefined : entry;
  }

  staleWindow(entry: CachedResponse): number {
    return entry.mustRevalidate ? 0 : (entry.staleTtlMs ?? this.cfg.staleTtlMs);
  }

  freshness(entry: CachedResponse, now = Date.now()): Freshness {
    if (now < entry.expiresAt) return "fresh";
    return now < entry.expiresAt + this.staleWindow(entry) ? "stale" : "expired";
  }

  /** `Cache-Control: no-cache` entries must always revalidate. */
  mustRevalidate(entry: CachedResponse): boolean {
    return entry.expiresAt <= entry.storedAt || Boolean(entry.mustRevalidate);
  }

  swrEnabled(options: RequestOptions<unknown, unknown>): boolean {
    return this.requestOpts(options).staleWhileRevalidate ?? this.cfg.staleWhileRevalidate;
  }

  /** The caller's copy of a cached body. */
  read(entry: CachedResponse): unknown {
    return this.cfg.copy === "clone" ? cloneBody(entry.body) : entry.body;
  }

  private resolveTtl(options: RequestOptions<unknown, unknown>, headers: HeaderMap | undefined): number | null {
    if (typeof options.cache === "number") return options.cache;
    const ro = this.requestOpts(options);
    if (ro.ttlMs !== undefined) return ro.ttlMs;
    if (this.cfg.respectCacheControl && headers) {
      const cc = parseCacheControl(getHeader(headers, "cache-control"));
      if (cc.noStore) return null;
      if (cc.noCache) return 0;
      const shared = ro.shared ?? this.cfg.shared;
      if (shared && cc.sMaxAgeMs !== undefined) return cc.sMaxAgeMs;
      if (cc.maxAgeMs !== undefined) return cc.maxAgeMs;
    }
    return this.cfg.ttlMs;
  }

  async put(
    key: string,
    input: {
      status: number;
      body: unknown;
      headers: HeaderMap;
      requestHeaders: HeaderMap;
      options: RequestOptions<unknown, unknown>;
    },
  ): Promise<void> {
    if (!CACHEABLE_STATUS.has(input.status)) return;
    const cc = parseCacheControl(getHeader(input.headers, "cache-control"));
    if (cc.noStore) return; // always honoured
    const ro = this.requestOpts(input.options);
    if (cc.private && (ro.shared ?? this.cfg.shared)) return;

    const varyHeader = getHeader(input.headers, "vary");
    if (varyHeader?.includes("*")) return;
    let vary: Record<string, string> | undefined;
    if (varyHeader) {
      vary = {};
      for (const name of varyHeader
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)) {
        vary[name] = getHeader(input.requestHeaders, name) ?? "";
      }
    }

    const ttl = this.resolveTtl(input.options, input.headers);
    if (ttl === null) return;

    const useDirectives = this.cfg.respectCacheControl;
    const directiveStale = Math.max(cc.staleWhileRevalidateMs ?? 0, cc.staleIfErrorMs ?? 0);
    const staleTtlMs = useDirectives && directiveStale > 0 ? directiveStale : undefined;
    const mustRevalidate = useDirectives && cc.mustRevalidate ? true : undefined;

    const now = Date.now();
    const body =
      this.cfg.copy === "clone" ? cloneBody(input.body) : this.cfg.copy === "freeze" ? deepFreeze(input.body) : input.body;
    const entry: CachedResponse = {
      status: input.status,
      body,
      headers: input.headers,
      storedAt: now,
      expiresAt: now + ttl,
      etag: getHeader(input.headers, "etag"),
      lastModified: getHeader(input.headers, "last-modified"),
      ...(ro.tags?.length ? { tags: ro.tags } : {}),
      ...(vary ? { vary } : {}),
      ...(staleTtlMs !== undefined ? { staleTtlMs } : {}),
      ...(mustRevalidate ? { mustRevalidate } : {}),
    };
    await this.write(key, entry, ttl + this.staleWindow(entry));
    if (ro.tags?.length && !this.store.deleteByTags) {
      for (const tag of ro.tags) {
        const keys = this.localTags.get(tag) ?? new Set<string>();
        keys.add(key);
        this.localTags.set(tag, keys);
      }
    }
  }

  /** 304 Not Modified: extend the entry with the new validators / TTL. */
  async refresh(
    key: string,
    entry: CachedResponse,
    headers: HeaderMap,
    options: RequestOptions<unknown, unknown>,
  ): Promise<CachedResponse> {
    const merged = { ...entry.headers, ...headers };
    const ttl = this.resolveTtl(options, merged) ?? this.cfg.ttlMs;
    const now = Date.now();
    const next: CachedResponse = {
      ...entry,
      headers: merged,
      storedAt: now,
      expiresAt: now + ttl,
      etag: getHeader(headers, "etag") ?? entry.etag,
      lastModified: getHeader(headers, "last-modified") ?? entry.lastModified,
    };
    await this.write(key, next, ttl + this.staleWindow(next));
    return next;
  }

  private async write(key: string, entry: CachedResponse, ttlMs: number): Promise<void> {
    try {
      await this.store.set(key, entry, ttlMs);
    } catch (err) {
      this.log.warn("Cache store set failed", { err: String(err) });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.store.delete(key);
    } catch (err) {
      this.log.warn("Cache store delete failed", { err: String(err) });
    }
  }

  /** Drop every cached variant of the given resources (origin + path). */
  async invalidateResources(urls: Iterable<string>): Promise<void> {
    const targets = new Set([...urls].map((u) => stripQuery(normalizeUrl(u))));
    try {
      if (this.store.deleteByResources) {
        await this.store.deleteByResources([...targets]);
      } else if (this.store.deleteMatching) {
        await this.store.deleteMatching((key) => {
          const res = resourceOfKey(key);
          return res !== undefined && targets.has(res);
        });
      } else {
        this.log.debug("Cache store has no deleteMatching; resource invalidation is best-effort");
      }
    } catch (err) {
      this.log.warn("Cache invalidation failed", { err: String(err) });
    }
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    try {
      if (this.store.deleteByTags) {
        await this.store.deleteByTags(tags);
        return;
      }
      for (const tag of tags) {
        for (const key of this.localTags.get(tag) ?? []) await this.store.delete(key);
        this.localTags.delete(tag);
      }
    } catch (err) {
      this.log.warn("Cache tag invalidation failed", { err: String(err) });
    }
  }

  async clear(): Promise<void> {
    this.localTags.clear();
    await this.store.clear();
  }
}

/** Resources affected by a mutation: the URL, Location / Content-Location and the parent collection. */
export function mutationTargets(url: string, respHeaders: HeaderMap): string[] {
  const out: string[] = [];
  const add = (u: string | undefined): void => {
    if (!u) return;
    try {
      out.push(new URL(u, url).href);
    } catch {
      /* ignore malformed */
    }
  };
  add(url);
  add(getHeader(respHeaders, "location"));
  add(getHeader(respHeaders, "content-location"));
  try {
    const parent = new URL(url);
    parent.search = "";
    parent.pathname = parent.pathname.replace(/\/[^/]*\/?$/, "") || "/";
    out.push(parent.href);
    if (parent.pathname !== "/") out.push(`${parent.href.replace(/\/$/, "")}/`);
  } catch {
    /* ignore */
  }
  return out;
}
