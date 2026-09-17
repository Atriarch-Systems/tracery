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

function Harness() {
  const source = useJournalSource(journal);
  return createElement(ActivityExplorer, { source, ariaLabel: 'Fixture trace' });
}

test('ActivityExplorer server-renders via useJournalSource with the fixture trace without throwing', () => {
  const markup = renderToString(createElement(Harness));
  assert.equal(typeof markup, 'string');
  assert.ok(markup.length > 0);
});

test('server-rendered markup includes the fixture flows\' labels in the flow picker', () => {
  const markup = renderToString(createElement(Harness));
  // Parent flow's root op label, and the (shared) label both research flows use.
  assert.match(markup, /Plan the investigation/);
  assert.match(markup, /Plan research angle/);
});

test('server-rendered markup shows the flow picker with all three fixture flows', () => {
  const markup = renderToString(createElement(Harness));
  assert.match(markup, /flow-picker-item/);
  const count = (markup.match(/data-flow-id=/g) ?? []).length;
  // At least the 3 flow-picker rows; each row's data-flow-id is unique per flow id.
  assert.ok(count >= 3, `expected at least 3 data-flow-id attributes, saw ${count}`);
  assert.match(markup, new RegExp(sampleFlowIds.parent.replace(':', '\\:')));
  assert.match(markup, new RegExp(sampleFlowIds.research1.replace(':', '\\:')));
  assert.match(markup, new RegExp(sampleFlowIds.research2.replace(':', '\\:')));
});

test('a source with no flows yet still renders (empty state, no throw)', () => {
  const empty = new Journal();
  const markup = renderToString(
    createElement(function EmptyHarness() {
      const source = useJournalSource(empty);
      return createElement(ActivityExplorer, { source });
    }),
  );
  assert.match(markup, /No flows yet/);
  assert.match(markup, /No flow selected/);
});
