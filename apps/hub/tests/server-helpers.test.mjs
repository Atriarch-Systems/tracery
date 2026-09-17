// Unit tests for the small pure helpers `server.ts` wires into Fastify's
// logger and error handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientErrorCode, redactedRequestUrl, safeRequestId } from '../dist/server.js';

// ---------------------------------------------------------------------------
// hub-3: redact ?token=/?api_key= before a request URL is logged
// ---------------------------------------------------------------------------

test('redactedRequestUrl: strips a live-feed token from the query string, keeping the path and other params', () => {
  const url = redactedRequestUrl('/v1/live?flow=f1&token=SUPER-SECRET-KEY-123');
  assert.ok(!url.includes('SUPER-SECRET-KEY-123'), `token leaked into logged url: ${url}`);
  assert.match(url, /^\/v1\/live\?/);
  assert.match(url, /flow=f1/);
  assert.match(url, /token=%5Bredacted%5D|token=\[redacted\]/);
});

test('redactedRequestUrl: also strips api_key, and leaves a url with no credential query untouched', () => {
  assert.ok(!redactedRequestUrl('/metrics?api_key=abc123').includes('abc123'));
  assert.equal(redactedRequestUrl('/v1/flows?limit=10'), '/v1/flows?limit=10');
  assert.equal(redactedRequestUrl('/healthz'), '/healthz');
});

test('redactedRequestUrl: an unparseable url is returned unchanged rather than throwing', () => {
  const malformed = 'http://[::1';
  assert.equal(redactedRequestUrl(malformed), malformed);
});

// ---------------------------------------------------------------------------
// hub-17: a control character in x-request-id must not turn the request into a 500
// ---------------------------------------------------------------------------

test('safeRequestId: a normal id is passed through unchanged', () => {
  assert.equal(safeRequestId('abc-123'), 'abc-123');
});

test('safeRequestId: absent, oversized, or control-character ids fall back to a fresh id instead of throwing downstream', () => {
  assert.match(safeRequestId(undefined), /^[0-9a-f-]{36}$/);
  assert.match(safeRequestId('a'.repeat(129)), /^[0-9a-f-]{36}$/);
  assert.match(safeRequestId('bad\nX-Evil: 1'), /^[0-9a-f-]{36}$/);
  assert.match(safeRequestId(''), /^[0-9a-f-]{36}$/);
});

// ---------------------------------------------------------------------------
// hub-4: framework errors map to this hub's error codes
// ---------------------------------------------------------------------------

test('clientErrorCode: maps Fastify body-parsing error codes to hub-shaped codes, and anything else to bad_request', () => {
  assert.equal(clientErrorCode({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }), 'body_too_large');
  assert.equal(clientErrorCode({ code: 'FST_ERR_CTP_INVALID_JSON_BODY' }), 'invalid_json');
  assert.equal(clientErrorCode({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' }), 'invalid_json');
  assert.equal(clientErrorCode({ code: 'FST_ERR_SOMETHING_ELSE' }), 'bad_request');
  assert.equal(clientErrorCode({}), 'bad_request');
});
