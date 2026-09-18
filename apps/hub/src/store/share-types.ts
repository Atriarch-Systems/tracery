/**
 * Share links (docs/SHARING.md): a `ShareRecord` is a capability -- its
 * `token` is the only credential a public viewer ever presents (routes/
 * shares.ts's public routes take no API key at all). `ShareStore` is a
 * parallel interface every `EventStore` implementation (`MemoryStore`,
 * `SqliteStore`, `PostgresStore`) also implements, kept separate from
 * `EventStore` itself so a store that predates sharing still type-checks
 * against the older interface unchanged.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export type ShareTargetType = 'flow' | 'trace';

export interface ShareTarget {
  readonly type: ShareTargetType;
  readonly id: string;
}

export type ShareMode = 'snapshot' | 'live';

/** Preview metadata kept on the record; the PNG bytes themselves live in a separate blob (see `ShareStore.setSharePreview`/`getSharePreview`) so listing shares never pulls image data. */
export interface SharePreviewMeta {
  readonly contentType: 'image/png';
  readonly bytes: number;
}

export interface SharePreviewData {
  readonly contentType: 'image/png';
  readonly data: Uint8Array;
}

export interface ShareRecord {
  readonly id: string;
  /** Random 32-byte base64url token -- the public credential. Never logged (see `redactedRequestUrl`-style handling in routes/shares.ts) and never returned by `listShares`. */
  readonly token: string;
  readonly workspace: string;
  readonly target: ShareTarget;
  readonly mode: ShareMode;
  /**
   * Hub cursor at creation time. In `'snapshot'` mode, reads through this
   * share never return an event whose cursor exceeds this value, no matter
   * what has since been ingested. `undefined` for `'live'` mode, which has
   * no cap.
   */
  readonly snapshotCursor: number | undefined;
  readonly includeContext: boolean;
  /** API key id, or `'local'` in local mode (task: "local mode" in SPEC.md §6 "Auth"). */
  readonly createdBy: string;
  readonly createdAt: number;
  /** `null` means never. */
  readonly expiresAt: number | null;
  /** `null` while active. */
  readonly revokedAt: number | null;
  readonly preview: SharePreviewMeta | null;
}

export interface CreateShareInput {
  readonly workspace: string;
  readonly target: ShareTarget;
  readonly mode: ShareMode;
  readonly snapshotCursor: number | undefined;
  readonly includeContext: boolean;
  readonly createdBy: string;
  readonly expiresAt: number | null;
}

export interface ListSharesQuery {
  /** Restrict to shares created by this key id (or `'local'`); omit for every share in the workspace (an admin listing). */
  readonly createdBy?: string;
}

/**
 * Storage for share links, implemented by every `EventStore` engine
 * alongside `EventStore` itself. A revoked or expired share is never
 * deleted outright -- `getShareByToken`/`getShareById` still return it (so
 * an authenticated "Manage shares" list can show "revoked"/"expired"
 * state) -- callers (routes/shares.ts) decide what "usable" means from
 * `revokedAt`/`expiresAt`.
 */
export interface ShareStore {
  createShare(input: CreateShareInput): Promise<ShareRecord>;
  getShareByToken(token: string): Promise<ShareRecord | undefined>;
  getShareById(workspace: string, id: string): Promise<ShareRecord | undefined>;
  listShares(workspace: string, query?: ListSharesQuery): Promise<readonly ShareRecord[]>;
  /** Returns `false` when no such share exists (or it belongs to a different workspace). Idempotent: revoking an already-revoked share still returns `true`. */
  revokeShare(workspace: string, id: string, revokedAt: number): Promise<boolean>;
  /** `null` clears any existing preview. Returns `false` when no such share exists. */
  setSharePreview(workspace: string, id: string, preview: SharePreviewData | null): Promise<boolean>;
  getSharePreview(workspace: string, id: string): Promise<SharePreviewData | undefined>;
}

/** 32 random bytes, base64url-encoded (43 characters, no padding) -- unguessable and URL-safe for `/s/:token`. */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateShareId(): string {
  return randomUUID();
}

export function isShareUsable(share: ShareRecord, now: number): boolean {
  if (share.revokedAt !== null) return false;
  if (share.expiresAt !== null && now >= share.expiresAt) return false;
  return true;
}

export const DEFAULT_SHARE_EXPIRY_DAYS = 30;
export const SHARE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
