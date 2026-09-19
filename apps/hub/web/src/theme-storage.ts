/**
 * The hosted UI's theme choice (task: settings UI): a preset name plus a
 * handful of optional per-field color overrides, NOT a fully resolved
 * `ActivityTheme` -- so switching presets later (the preset `<select>` in
 * `ThemeSettings.tsx`) still applies cleanly instead of carrying a stale
 * resolved palette forward. Persisted to `localStorage` under
 * `tracery.theme`, guarded with try/catch per this app's existing
 * localStorage convention (see `session.ts`'s `loadSession`/`saveSession`,
 * which uses `sessionStorage` the same way for the same reason: a private
 * window, disabled storage, or a quota error must degrade to "use the
 * default" rather than crash the app).
 */
import { THEME_PRESETS, PRESET_NAMES, type ActivityTheme } from '@atriarch/tracery-react';

export interface ThemeOverrides {
  /** Chrome `--tracery-accent`. */
  readonly accent?: string;
  /** Chrome `--tracery-error`. */
  readonly error?: string;
  /** Graph `nodeFillActive` (the highlighted node-card fill). */
  readonly graphNodeFillActive?: string;
  /** Graph `edgeAccentFallback` (edge line / accent color family). */
  readonly graphEdgeAccentFallback?: string;
}

export interface ThemeChoice {
  readonly preset: string;
  readonly overrides?: ThemeOverrides;
}

const STORAGE_KEY = 'tracery.theme';
const DEFAULT_CHOICE: ThemeChoice = { preset: 'dark' };

export function loadThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHOICE;
    const parsed = JSON.parse(raw) as Partial<ThemeChoice>;
    if (typeof parsed.preset !== 'string' || !PRESET_NAMES.includes(parsed.preset)) return DEFAULT_CHOICE;
    return { preset: parsed.preset, overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : undefined };
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Best-effort: a private window, disabled storage, or a quota error
    // just means the choice won't survive a reload this time.
  }
}

/** Builds the full `ActivityTheme` a stored choice describes: the named
 * preset (falling back to `dark` for an unknown/removed preset name) with
 * any per-field overrides layered on top. */
export function resolveActivityTheme(choice: ThemeChoice): ActivityTheme {
  const preset = THEME_PRESETS[choice.preset] ?? THEME_PRESETS.dark!;
  const overrides = choice.overrides;
  if (!overrides) return preset;
  return {
    ...preset,
    ...(overrides.accent ? { accent: overrides.accent } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
    graph: {
      ...preset.graph,
      ...(overrides.graphNodeFillActive ? { nodeFillActive: overrides.graphNodeFillActive } : {}),
      ...(overrides.graphEdgeAccentFallback ? { edgeAccentFallback: overrides.graphEdgeAccentFallback } : {}),
    },
  };
}
