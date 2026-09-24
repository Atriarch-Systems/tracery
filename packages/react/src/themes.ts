/**
 * Named `ActivityTheme` presets: a complete, coherent theme (chrome CSS
 * variables + a matching canvas `graph` palette), not just a chrome
 * recolor. `dark` is the exact built-in default -- indistinguishable from
 * passing no `theme` at all, see `resolveThemeInput`'s doc comment for why
 * they are still kept as two distinct intents.
 */
import type { ActivityTheme } from './style.js';

export const THEME_PRESETS: Record<string, ActivityTheme> = {
  // The exact current defaults: chrome DEFAULTS from style.ts + DEFAULT_GRAPH_THEME
  // from @atriarch-systems/tracery-visualizer, spelled out literally so this object's shape
  // is directly comparable in a test without importing internals.
  dark: {
    bg: '#12141c',
    fg: '#e7e9f2',
    accent: '#7c9cff',
    muted: '#8892a6',
    error: '#ff6b6b',
    graph: {
      nodeAccentIdle: '#77827d',
      nodeAccentFallback: '#adf17b',
      nodeFillIdle: '#161d1a',
      nodeFillActive: '#17251d',
      nodeBorderIdle: '#343e38',
      nodeBorderActive: '#62834f',
      nodeBorderPulsing: '#62834f',
      nodeBorderSelected: '#e3f3de',
      labelSubIdle: '#78857c',
      labelSubBright: '#91b282',
      labelTitleIdle: '#a1ada4',
      labelTitleBright: '#e6f3e0',
      errorDim: '#a77570',
      errorBright: '#f28b82',
      edgeLineIdle: '#3d4941',
      edgeAccentFallback: '#8bb971',
      arrowIdle: '#65726a',
      arrowBright: '#b9ef95',
      travelingDot: '#d6ffb4',
      travelingDotGlow: '#adf17b',
      edgeLabelBg: '#111a15',
      edgeLabelTextIdle: '#8b988f',
      edgeLabelTextBright: '#c3e6ac',
      groupAccentFallback: '#8bb971',
    },
  },

  // A light background: dark text, lighter idle grays, near-white node fills.
  // Accent/error stay vivid enough to read on a light ground.
  light: {
    bg: '#f4f5f8',
    fg: '#1b1e27',
    accent: '#3b5bdb',
    muted: '#5c6479',
    error: '#c0392b',
    graph: {
      nodeAccentIdle: '#8d9690',
      nodeAccentFallback: '#3f8f3f',
      nodeFillIdle: '#ffffff',
      nodeFillActive: '#eaf5ea',
      nodeBorderIdle: '#d3d8d4',
      nodeBorderActive: '#5da35d',
      nodeBorderPulsing: '#5da35d',
      nodeBorderSelected: '#1f6f3d',
      labelSubIdle: '#7b8480',
      labelSubBright: '#3f6b45',
      labelTitleIdle: '#242923',
      labelTitleBright: '#173a20',
      errorDim: '#c98f89',
      errorBright: '#c0392b',
      edgeLineIdle: '#c7cec8',
      edgeAccentFallback: '#4d8f52',
      arrowIdle: '#9aa39c',
      arrowBright: '#3f7a45',
      travelingDot: '#2f6b34',
      travelingDotGlow: '#3f8f3f',
      edgeLabelBg: '#eef1ee',
      edgeLabelTextIdle: '#5c665e',
      edgeLabelTextBright: '#245a2b',
      groupAccentFallback: '#4d8f52',
    },
  },

  // Near-black/near-white chrome; saturated accent/error; maximizes color
  // contrast in place of the stroke-width changes this theme layer cannot make.
  'high-contrast': {
    bg: '#000000',
    fg: '#ffffff',
    accent: '#ffd60a',
    muted: '#c9c9c9',
    error: '#ff1744',
    graph: {
      nodeAccentIdle: '#e0e0e0',
      nodeAccentFallback: '#00ff5f',
      nodeFillIdle: '#000000',
      nodeFillActive: '#0a1f0f',
      nodeBorderIdle: '#ffffff',
      nodeBorderActive: '#00ff5f',
      nodeBorderPulsing: '#00ff5f',
      nodeBorderSelected: '#ffd60a',
      labelSubIdle: '#e6e6e6',
      labelSubBright: '#00ff5f',
      labelTitleIdle: '#ffffff',
      labelTitleBright: '#ffffff',
      errorDim: '#ff8a80',
      errorBright: '#ff1744',
      edgeLineIdle: '#8a8a8a',
      edgeAccentFallback: '#00ff5f',
      arrowIdle: '#dadada',
      arrowBright: '#00ff5f',
      travelingDot: '#ffffff',
      travelingDotGlow: '#00ff5f',
      edgeLabelBg: '#000000',
      edgeLabelTextIdle: '#e6e6e6',
      edgeLabelTextBright: '#00ff5f',
      groupAccentFallback: '#00ff5f',
    },
  },

  // Dark chrome, blue/cyan family replacing the default green throughout so
  // the whole canvas (node highlight, edges, traveling dot) reads as one hue.
  ocean: {
    bg: '#0b1622',
    fg: '#dceefc',
    accent: '#3fc6ff',
    muted: '#7ea3bd',
    error: '#ff6f6f',
    graph: {
      nodeAccentIdle: '#5c7c8f',
      nodeAccentFallback: '#3fc6ff',
      nodeFillIdle: '#0f1e2b',
      nodeFillActive: '#123246',
      nodeBorderIdle: '#22414f',
      nodeBorderActive: '#2f92c0',
      nodeBorderPulsing: '#2f92c0',
      nodeBorderSelected: '#d9f3ff',
      labelSubIdle: '#6f93a5',
      labelSubBright: '#8fd6f2',
      labelTitleIdle: '#a6c3d1',
      labelTitleBright: '#e4f6ff',
      errorDim: '#a7726f',
      errorBright: '#ff6f6f',
      edgeLineIdle: '#233f4d',
      edgeAccentFallback: '#3fc6ff',
      arrowIdle: '#5b8194',
      arrowBright: '#8fe2ff',
      travelingDot: '#c8f2ff',
      travelingDotGlow: '#3fc6ff',
      edgeLabelBg: '#0d1c27',
      edgeLabelTextIdle: '#84a9ba',
      edgeLabelTextBright: '#bdeeff',
      groupAccentFallback: '#3fc6ff',
    },
  },
};

/** Fixed, sensible display order for a preset picker. */
export const PRESET_NAMES: readonly string[] = ['dark', 'light', 'high-contrast', 'ocean'];

/**
 * Resolves a caller-supplied theme input into an `ActivityTheme | undefined`:
 * a preset name looks up `THEME_PRESETS` (`undefined` for an unknown name --
 * never throws), an already-built `ActivityTheme` object passes through
 * unchanged, and `undefined` passes through as `undefined`.
 *
 * `undefined` and `THEME_PRESETS.dark` render identically -- both resolve to
 * the built-in defaults -- but are kept distinct on purpose: `undefined`
 * means "the caller expressed no preference, use whatever the component's
 * own defaults are" (which could change independently of `dark`'s pinned
 * values in a future version), while `'dark'` is an explicit, stable choice
 * a caller can persist and rely on. Collapsing them into one would make it
 * impossible to tell "no opinion" from "chose dark on purpose".
 */
export function resolveThemeInput(input: string | ActivityTheme | undefined): ActivityTheme | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return THEME_PRESETS[input];
  return input;
}
