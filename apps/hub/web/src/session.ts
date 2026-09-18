/**
 * The hosted UI "does its own key entry" (SPEC.md §6): first load asks for a
 * read key, kept in `sessionStorage` (not `localStorage`, so it does not
 * outlive the tab) so subsequent navigations within the tab skip the form.
 */
export interface HubSession {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace?: string;
  /**
   * Set when this session was established automatically from `GET /v1/info`
   * reporting `auth: 'none'` (task: "local mode") rather than a key the user
   * typed in, or an SSO cookie. Distinguishes the two no-`apiKey` cases for
   * the header's "local mode" badge -- an SSO session also carries `apiKey:
   * ''` (`App.tsx`) but is not local mode.
   */
  readonly local?: boolean;
}

const STORAGE_KEY = 'atriarch-tracery-hub-session';

export function loadSession(): HubSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HubSession>;
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.apiKey !== 'string') return null;
    return {
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
      local: parsed.local === true,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: HubSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
