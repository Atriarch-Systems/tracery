import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('built hosted UI and offline viewer retain complete readable third-party notices', () => {
  for (const file of ['index.html', 'viewer.html']) {
    const html = fs.readFileSync(new URL('../web/dist/' + file, import.meta.url), 'utf8');
    assert.ok(html.includes('id="tracery-licenses"'), file);
    assert.ok(html.includes('Permission is hereby granted'), file);
    for (const name of ['react@', 'react-force-graph-2d@', 'bezier-js@', 'd3-force@']) assert.ok(html.includes(name), name);
  }
});
