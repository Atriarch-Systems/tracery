#!/usr/bin/env node
// Prints the Atriarch Activity hub deep link for a session id. Used by the
// `activity` skill; unlike emit.mjs this is a normal CLI script (stdout is
// meant to be read), not a telemetry hook.
//
// Usage: node link.mjs <session_id>

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

const env = process.env;
const hubUrl = firstNonEmpty(env.CLAUDE_PLUGIN_OPTION_HUB_URL, env.ACTIVITY_HUB_URL).replace(/\/+$/, '');
const sessionId = process.argv[2];

if (hubUrl.length === 0) {
  console.log('Atriarch Activity is not configured (no hub_url set for this plugin).');
} else if (!sessionId) {
  console.log('No session id given; pass the current session_id as an argument.');
} else {
  console.log(`${hubUrl}/ui/flows/${sessionId}`);
}
