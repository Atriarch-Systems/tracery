#!/usr/bin/env bash
# Claude Code plugin demo: verifies the demo hub is reachable, runs the
# plugin's mapper end-to-end once (SessionStart -> PreToolUse -> PostToolUse
# for one session, through hooks/emit.mjs, exactly as Claude Code would
# invoke it), confirms the resulting flow landed on the hub, then prints the
# exact command to launch a real Claude Code session with the plugin pointed
# at that hub.
#
# Usage: scripts/demo-plugin.sh
# Env overrides: TRACERY_HUB_URL, TRACERY_API_KEY, TRACERY_WORKSPACE
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/claude-code"
FIXTURES_DIR="$PLUGIN_DIR/tests/fixtures"

HUB_URL="${TRACERY_HUB_URL:-http://127.0.0.1:8971}"
API_KEY="${TRACERY_API_KEY:-tdk_a7f3c9e2b1d4}"
WORKSPACE="${TRACERY_WORKSPACE:-default}"
SESSION_ID="demo-plugin-smoke"

echo "[demo-plugin] hub: $HUB_URL (workspace: $WORKSPACE)"

# --- 1. verify the hub is reachable -----------------------------------------
if ! curl -fsS "$HUB_URL/healthz" >/dev/null; then
  echo "[demo-plugin] ERROR: hub at $HUB_URL is not reachable (GET /healthz failed)." >&2
  exit 1
fi
echo "[demo-plugin] hub is reachable"

# --- 2. run the mapper end to end for one session ---------------------------
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT

emit() {
  local fixture="$1"
  node "$SCRIPT_DIR/demo-plugin-fixture.mjs" "$FIXTURES_DIR/$fixture" "$SESSION_ID" \
    | CLAUDE_PLUGIN_DATA="$STATE_DIR" TRACERY_HUB_URL="$HUB_URL" TRACERY_API_KEY="$API_KEY" TRACERY_WORKSPACE="$WORKSPACE" \
      node "$PLUGIN_DIR/hooks/emit.mjs"
}

echo "[demo-plugin] piping SessionStart through hooks/emit.mjs (session: $SESSION_ID)"
emit "session-start.json"

echo "[demo-plugin] piping PreToolUse (Bash) through hooks/emit.mjs"
emit "pre-tool-use-bash.json"

echo "[demo-plugin] piping PostToolUse (Bash) through hooks/emit.mjs"
emit "post-tool-use-bash.json"

# --- 3. confirm it landed on the hub -----------------------------------------
FLOW_URL="$HUB_URL/v1/flows/$SESSION_ID"
HTTP_STATUS="$(curl -sS -o /tmp/demo-plugin-flow.json -w '%{http_code}' -H "authorization: Bearer $API_KEY" "$FLOW_URL")"
if [ "$HTTP_STATUS" != "200" ]; then
  echo "[demo-plugin] ERROR: GET $FLOW_URL returned $HTTP_STATUS, expected 200. Body:" >&2
  cat /tmp/demo-plugin-flow.json >&2
  exit 1
fi
echo "[demo-plugin] confirmed: GET /v1/flows/$SESSION_ID -> 200"
cat /tmp/demo-plugin-flow.json
echo ""
rm -f /tmp/demo-plugin-flow.json

# --- 4. print the deep link pattern the /tracery:activity skill produces ----
echo ""
echo "[demo-plugin] smoke-test flow's deep link: $HUB_URL/ui/flows/$SESSION_ID"
echo "[demo-plugin] general pattern (what /tracery:activity prints for the running session):"
echo "  $HUB_URL/ui/flows/<session_id>"

# --- 5. print the launch command for a new Claude Code session -------------
echo ""
echo "[demo-plugin] launch command for a new Claude Code session with the plugin"
echo "[demo-plugin] pointed at the demo hub:"
echo ""
echo "TRACERY_HUB_URL=$HUB_URL TRACERY_API_KEY=$API_KEY TRACERY_WORKSPACE=$WORKSPACE claude --plugin-dir \"$PLUGIN_DIR\""
