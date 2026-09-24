import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Journal } from '@atriarch-systems/tracery-core';
import { sampleTraceEvents } from '@atriarch-systems/tracery-core/fixtures';
import { ActivityExplorer } from '../dist/ActivityExplorer.js';
import { useJournalSource } from '../dist/useJournalSource.js';
import { THEME_PRESETS, PRESET_NAMES, resolveThemeInput } from '../dist/themes.js';
import { DEFAULT_GRAPH_THEME } from '@atriarch-systems/tracery-visualizer';

const journal = new Journal();
journal.append(sampleTraceEvents);

function Harness(theme) {
  return function HarnessComponent() {
    const source = useJournalSource(journal);
    return createElement(ActivityExplorer, { source, ariaLabel: 'Fixture trace', theme });
  };
}

test('PRESET_NAMES lists the four presets in a fixed order', () => {
  assert.deepEqual(PRESET_NAMES, ['dark', 'light', 'high-contrast', 'ocean']);
  assert.deepEqual(new Set(Object.keys(THEME_PRESETS)), new Set(PRESET_NAMES));
});

test('THEME_PRESETS.dark\'s graph palette matches DEFAULT_GRAPH_THEME field-for-field', () => {
  assert.deepEqual(THEME_PRESETS.dark.graph, DEFAULT_GRAPH_THEME);
});

test('THEME_PRESETS.dark\'s chrome vars match style.ts\'s built-in DEFAULTS', () => {
  assert.equal(THEME_PRESETS.dark.bg, '#12141c');
  assert.equal(THEME_PRESETS.dark.fg, '#e7e9f2');
  assert.equal(THEME_PRESETS.dark.accent, '#7c9cff');
  assert.equal(THEME_PRESETS.dark.muted, '#8892a6');
  assert.equal(THEME_PRESETS.dark.error, '#ff6b6b');
});

test('THEME_PRESETS.dark renders identically (SSR markup) to no theme at all', () => {
  const noTheme = renderToString(createElement(Harness(undefined)));
  const darkTheme = renderToString(createElement(Harness(THEME_PRESETS.dark)));
  assert.equal(noTheme, darkTheme);
});

test('resolveThemeInput: a known preset name resolves to that preset', () => {
  assert.equal(resolveThemeInput('ocean'), THEME_PRESETS.ocean);
});

test('resolveThemeInput: an unknown preset name resolves to undefined without throwing', () => {
  assert.equal(resolveThemeInput('not-a-real-preset'), undefined);
});

test('resolveThemeInput: an ActivityTheme object passes through unchanged', () => {
  const custom = { bg: '#000000', graph: { nodeFillIdle: '#111111' } };
  assert.equal(resolveThemeInput(custom), custom);
});

test('resolveThemeInput: undefined passes through as undefined', () => {
  assert.equal(resolveThemeInput(undefined), undefined);
});

test('an SSR render of ActivityExplorer with theme="ocean" resolved does not throw and sets --tracery-accent', () => {
  const resolved = resolveThemeInput('ocean');
  const markup = renderToString(createElement(Harness(resolved)));
  assert.match(markup, /--tracery-accent:#3fc6ff/);
});
