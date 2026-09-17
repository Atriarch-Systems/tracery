/**
 * Thin client for the public `GET /v1/license` route (SPEC.md §7 "License
 * key"). Used only by `Footer.tsx` to decide whether this is the community
 * edition (show the Ko-fi tip-jar link) or a licensed deployment (white-label
 * footer, product name only). No auth required -- same pattern as
 * `sso.ts`'s `fetchAuthMe`.
 */

export interface LicenseStatus {
  readonly valid: boolean;
  readonly org?: string;
  readonly features?: readonly string[];
  readonly reason?: string;
}

function isLicenseStatus(value: unknown): value is LicenseStatus {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>).valid === 'boolean';
}

/** `GET /v1/license`, same-origin. Returns `null` on any network/parse failure or when the community hub has no ee layer built at all (no route) -- callers treat that the same as "unlicensed". */
export async function fetchLicenseStatus(): Promise<LicenseStatus | null> {
  try {
    const res = await fetch('/v1/license', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isLicenseStatus(body) ? body : null;
  } catch {
    return null;
  }
}
