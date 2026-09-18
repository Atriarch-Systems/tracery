// Wire shapes for the hub's share-link routes (docs/SHARING.md), mirrored
// here the same way `hub-types.stub.ts` mirrors `FlowSummary`/`Trace` --
// the client depends on no hub package, only on the wire contract.

export type ShareTargetType = 'flow' | 'trace';

export interface ShareTarget {
  readonly type: ShareTargetType;
  readonly id: string;
}

export type ShareMode = 'snapshot' | 'live';

export interface SharePreviewMeta {
  readonly contentType: 'image/png';
  readonly bytes: number;
}

/** The authenticated list/detail shape: never carries a `token` (docs/SHARING.md: "list ... tokens omitted"). */
export interface ShareSummary {
  readonly id: string;
  readonly workspace: string;
  readonly target: ShareTarget;
  readonly mode: ShareMode;
  readonly snapshotCursor: number | undefined;
  readonly includeContext: boolean;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly preview: SharePreviewMeta | null;
}

export interface CreateShareOptions {
  readonly target: ShareTarget;
  /** Default `'snapshot'`. */
  readonly mode?: ShareMode;
  /** Default `false`. */
  readonly includeContext?: boolean;
  /** Default 30 days; pass `'never'` for a share that does not expire. */
  readonly expiresInDays?: number | 'never';
}

export interface CreateShareResult {
  readonly id: string;
  readonly token: string;
  readonly url: string;
}

/** `GET /v1/shares/:token/meta`. */
export interface ShareMeta {
  readonly target: ShareTarget;
  readonly mode: ShareMode;
  readonly includeContext: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly label: string;
}
