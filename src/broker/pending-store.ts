/**
 * Where fill_secret parks consensus-gated fills until await_fill redeems
 * them.
 *
 * A parked fill holds the export's key material (`pending.material`), so
 * the store is as sensitive as the broker's Turnkey key. Two stores:
 *
 *  - `MemoryPendingFillStore`: process memory. The stdio broker uses it; a
 *    restart strands pending approvals, which is acceptable for one local
 *    process.
 *  - `FilePendingFillStore`: one AES-256-GCM encrypted file per fill, so a
 *    hosted broker can restart without stranding an approval. The key comes
 *    from the deployment (SBM_STATE_KEY), never from the state directory.
 *
 * Every fill has an owner: the agent session that parked it. Tools only see
 * their own session's fills through `scopedFills`. A fill whose owner
 * session no longer exists (the broker restarted, or the client
 * reconnected) can be claimed by the session that presents its fill_id.
 * The fill_id is a random UUID the broker gave only to the original
 * session, so presenting it is the proof of ownership.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PendingExport } from "./secrets-client.js";

/**
 * A fill_secret call parked on consensus approval. The agent holds just the
 * fillId. The original targets are retained so the fill can be re-validated
 * against the live page once approvals land.
 */
export type PendingFill = {
  fillId: string;
  pending: PendingExport;
  /** Requested destinations: element uids, with payload keys for JSON
   * multi-field secrets. */
  targets: { key?: string; elementUid: string }[];
  pageUrl: string;
  createdAt: number;
};

export type StoredFill = PendingFill & { owner: string };

/** Parked fills older than this are dropped. Turnkey activities do not
 * wait forever either. */
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1_000;

export class MemoryPendingFillStore {
  protected readonly fills = new Map<string, StoredFill>();

  constructor(private readonly ttlMs = DEFAULT_PENDING_TTL_MS) {}

  list(owner: string): StoredFill[] {
    this.expire();
    return [...this.fills.values()].filter((f) => f.owner === owner);
  }

  /**
   * The fill, if `owner` may use it: it owns it, or the owning session is
   * gone and the fill moves to `owner`. Checked and moved synchronously, so
   * two sessions cannot both claim one orphan.
   */
  async claim(
    fillId: string,
    owner: string,
    isLive: (owner: string) => boolean,
  ): Promise<StoredFill | undefined> {
    this.expire();
    const fill = this.fills.get(fillId);
    if (!fill) return undefined;
    if (fill.owner === owner) return fill;
    if (isLive(fill.owner)) return undefined;
    const claimed = { ...fill, owner };
    await this.put(claimed);
    return claimed;
  }

  async put(fill: StoredFill): Promise<void> {
    this.fills.set(fill.fillId, fill);
  }

  async delete(fillId: string): Promise<void> {
    this.fills.delete(fillId);
  }

  private expire(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const f of this.fills.values()) {
      if (f.createdAt < cutoff) void this.delete(f.fillId);
    }
  }
}

/**
 * Write-through encrypted persistence. All fills load into memory at
 * construction, so reads and ownership checks stay synchronous; every
 * write goes to disk before it resolves. One broker process per state
 * directory: two processes sharing a directory would not see each other's
 * writes.
 */
export class FilePendingFillStore extends MemoryPendingFillStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
    ttlMs = DEFAULT_PENDING_TTL_MS,
  ) {
    super(ttlMs);
    if (key.length !== 32) throw new Error("State key must be 32 bytes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".fill")) continue;
      const fill = this.decrypt(name, readFileSync(join(dir, name), "utf8"));
      if (fill) this.fills.set(fill.fillId, fill);
    }
  }

  override async put(fill: StoredFill): Promise<void> {
    const name = fileName(fill.fillId);
    const tmp = join(this.dir, `${name}.${randomBytes(4).toString("hex")}`);
    await writeFile(tmp, this.encrypt(name, fill), { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
    await super.put(fill);
  }

  override async delete(fillId: string): Promise<void> {
    await rm(join(this.dir, fileName(fillId)), { force: true });
    await super.delete(fillId);
  }

  // The file name is bound in as associated data, so an encrypted fill
  // cannot be renamed into another fill's slot.
  private encrypt(name: string, fill: StoredFill): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(fill), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  private decrypt(name: string, data: string): StoredFill | undefined {
    try {
      const raw = Buffer.from(data, "base64");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        raw.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      const fill = JSON.parse(json) as StoredFill;
      return fileName(fill.fillId) === name ? fill : undefined;
    } catch {
      // Wrong key or a damaged file. Skip it; the approval must restart.
      console.error(`secure-browser-mcp: skipping unreadable fill ${name}`);
      return undefined;
    }
  }
}

function fileName(fillId: string): string {
  return `${createHash("sha256").update(fillId).digest("hex")}.fill`;
}

/** Parse SBM_STATE_KEY: 32 bytes as 64 hex characters or base64. */
export function parseStateKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SBM_STATE_KEY must be 32 bytes, as 64 hex characters or base64",
    );
  }
  return key;
}

/** One agent session's view of the store. */
export type PendingFills = {
  list(): PendingFill[];
  get(fillId: string): Promise<PendingFill | undefined>;
  put(fill: PendingFill): Promise<void>;
  delete(fillId: string): Promise<void>;
};

export function scopedFills(
  store: MemoryPendingFillStore,
  owner: string,
  isLive: (owner: string) => boolean = () => true,
): PendingFills {
  return {
    list: () => store.list(owner),
    get: (fillId) => store.claim(fillId, owner, isLive),
    put: (fill) => store.put({ ...fill, owner }),
    delete: async (fillId) => {
      if (await store.claim(fillId, owner, isLive)) await store.delete(fillId);
    },
  };
}
