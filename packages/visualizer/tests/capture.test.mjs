// ActivityGraph.toImage's pixel work (docs/SHARING.md "Image export"),
// exercised via `renderCapture`/`captureToBlob` with a fake canvas/context --
// no real rendering, no DOM (same fakeCtx-style pattern as
// drawing-edges.test.mjs/groups.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCapture, captureToBlob, TRACERY_MARK_TEXT, TRACERY_MARK_COLOR } from '../dist/capture.js';

function fakeCanvas(width, height) {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => (key === 'measureText' ? (value) => ({ width: value.length * 6 }) : (...args) => calls.push([key, ...args])),
      set: (_target, key, value) => {
        calls.push([`set:${String(key)}`, value]);
        return true;
      },
    },
  );
  return {
    width,
    height,
    calls,
    getContext: (id) => (id === '2d' ? ctx : null),
    toBlob(callback) {
      callback({ fakeBlob: true, width, height });
    },
  };
}

function createFakeCanvas(calls) {
  return (width, height) => {
    const canvas = fakeCanvas(width, height);
    calls.push(canvas);
    return canvas;
  };
}

test('renderCapture scales the output canvas by `scale` (default 2) relative to the source', () => {
  const created = [];
  const canvas = renderCapture({ width: 400, height: 300 }, createFakeCanvas(created));
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 600);
  assert.equal(created.length, 1);
});

test('renderCapture respects a custom scale, rounding to whole pixels', () => {
  const canvas = renderCapture({ width: 401, height: 301 }, createFakeCanvas([]), { scale: 1.5 });
  assert.equal(canvas.width, Math.round(401 * 1.5));
  assert.equal(canvas.height, Math.round(301 * 1.5));
});

test('renderCapture always draws the source onto the output via drawImage, at the full scaled size', () => {
  const canvas = renderCapture({ width: 100, height: 50 }, createFakeCanvas([]));
  const drawImageCalls = canvas.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(drawImageCalls.length, 1);
  assert.deepEqual(drawImageCalls[0].slice(2), [0, 0, 200, 100]);
});

test('a `background` fills the output before the source is drawn; omitting it draws no fill at all', () => {
  const withBg = renderCapture({ width: 10, height: 10 }, createFakeCanvas([]), { background: '#12141c' });
  const fillRectCalls = withBg.calls.filter((c) => c[0] === 'fillRect');
  assert.equal(fillRectCalls.length, 1);
  const fillStyleSets = withBg.calls.filter((c) => c[0] === 'set:fillStyle');
  assert.ok(fillStyleSets.some((c) => c[1] === '#12141c'));

  const noBg = renderCapture({ width: 10, height: 10 }, createFakeCanvas([]));
  assert.equal(noBg.calls.filter((c) => c[0] === 'fillRect').length, 0);
});

test('mark defaults to on: draws "Tracery" bottom-right in the accent colour', () => {
  const canvas = renderCapture({ width: 200, height: 100 }, createFakeCanvas([]));
  const fillTextCalls = canvas.calls.filter((c) => c[0] === 'fillText');
  assert.equal(fillTextCalls.length, 1);
  assert.equal(fillTextCalls[0][1], TRACERY_MARK_TEXT);
  const [, , x, y] = fillTextCalls[0];
  assert.ok(x < canvas.width && x > canvas.width * 0.5, 'expected the mark near the right edge');
  assert.ok(y < canvas.height && y > canvas.height * 0.5, 'expected the mark near the bottom edge');
  const fillStyleSets = canvas.calls.filter((c) => c[0] === 'set:fillStyle');
  assert.ok(fillStyleSets.some((c) => c[1] === TRACERY_MARK_COLOR));
});

test('mark: false draws no text at all', () => {
  const canvas = renderCapture({ width: 200, height: 100 }, createFakeCanvas([]), { mark: false });
  assert.equal(canvas.calls.filter((c) => c[0] === 'fillText').length, 0);
});

test('renderCapture throws a clear error when getContext(\'2d\') returns null', () => {
  const createBrokenCanvas = () => ({ width: 1, height: 1, getContext: () => null, toBlob: () => {} });
  assert.throws(() => renderCapture({ width: 10, height: 10 }, createBrokenCanvas), /2D canvas context unavailable/);
});

test('captureToBlob resolves with the canvas\'s toBlob result', async () => {
  const canvas = fakeCanvas(10, 10);
  const blob = await captureToBlob(canvas);
  assert.deepEqual(blob, { fakeBlob: true, width: 10, height: 10 });
});

test('captureToBlob rejects when toBlob produces no blob', async () => {
  const canvas = { width: 1, height: 1, getContext: () => null, toBlob: (cb) => cb(null) };
  await assert.rejects(() => captureToBlob(canvas), /toBlob produced no blob/);
});
