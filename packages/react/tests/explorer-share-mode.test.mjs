// ActivityExplorer's share mode (docs/SHARING.md): readOnly renders the
// "Shared from Tracery · Open in Tracery" footer; lockedTarget hides the
// flow picker and restricts the scope switch to what the target's data can
// answer. Server-rendered (react-dom/server), same style as
// explorer-ssr.test.mjs, using a plain journal source seeded with the shared
// fixture trace so this needs no network mocking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Journal } from '@atriarch/tracery-core';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch/tracery-core/fixtures';
import { ActivityExplorer } from '../dist/ActivityExplorer.js';
import { useJournalSource } from '../dist/useJournalSource.js';

const journal = new Journal();
journal.append(sampleTraceEvents);

function renderShare(extraProps) {
  function Harness() {
    const source = useJournalSource(journal);
    return createElement(ActivityExplorer, { source, ariaLabel: 'Share preview', readOnly: true, ...extraProps });
  }
  return renderToString(createElement(Harness));
}

test('readOnly renders the "Shared from Tracery" footer linking to the Tracery repo', () => {
  const markup = renderShare({});
  assert.match(markup, /share-footer/);
  assert.match(markup, /Shared from Tracery/);
  assert.match(markup, /Open in Tracery/);
  assert.match(markup, /href="https:\/\/github\.com\/atriarch-systems\/tracery"/);
});

test('without readOnly, no share footer is rendered', () => {
  function Harness() {
    const source = useJournalSource(journal);
    return createElement(ActivityExplorer, { source });
  }
  const markup = renderToString(createElement(Harness));
  assert.doesNotMatch(markup, /share-footer/);
});

test('lockedTarget (flow) hides the flow picker and offers only the "flow" scope tab', () => {
  const markup = renderShare({ lockedTarget: { type: 'flow', id: sampleFlowIds.parent } });
  assert.doesNotMatch(markup, /flow-picker/);
  assert.match(markup, /scope-flow/);
  assert.doesNotMatch(markup, /scope-ancestors/);
  assert.doesNotMatch(markup, /scope-trace/);
  // The locked flow's content still renders.
  assert.match(markup, /Plan the investigation/);
});

test('lockedTarget (trace) hides the flow picker and offers "flow" and "trace" scope tabs, not "ancestors"', () => {
  const markup = renderShare({ lockedTarget: { type: 'trace', id: sampleFlowIds.parent } });
  assert.doesNotMatch(markup, /flow-picker/);
  assert.match(markup, /scope-flow/);
  assert.match(markup, /scope-trace/);
  assert.doesNotMatch(markup, /scope-ancestors/);
});
