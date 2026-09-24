---
name: activity
description: Print the Tracery Graph hub link for this session's live flow graph. Use when asked for the activity dashboard, the hub link, the trace/flow graph link, or where to watch this session.
---

# activity

Print the deep link to this session's flow in the Tracery Graph hub.

1. Find the current session id: prefer `$CLAUDE_SESSION_ID` if it is set;
   otherwise list `${CLAUDE_PLUGIN_DATA:-$TMPDIR/tracery}/state/`
   and take the most recently modified `<session_id>.json`, stripping the
   `.json` suffix. That file exists only while the emitter hook has run at
   least once this session, so it is a heuristic, not a certainty — if the
   directory is empty, say the activity plugin has not seen any hook fire
   yet for this session.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/hooks/link.mjs" <session_id>` and print
   its output verbatim.

If the script prints "not configured", tell the user the plugin's `hub_url`
and `api_key` userConfig (or `TRACERY_HUB_URL` / `TRACERY_API_KEY`) are not
set.
