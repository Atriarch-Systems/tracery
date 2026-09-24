# Tracery event generator

An interactive example: pick a sample flow, click **Generate**, and watch it
draw itself in a real `ActivityExplorer` -- no hub required. Check
**Also send to a hub** to push the exact same events to a running Tracery
hub over HTTP at the same time, so you can compare the in-process library
view against the standalone hub's hosted UI side by side.

```
npm install
npm run dev -w tracery-example-generator
```

Then open the printed URL. Two sample flows are included:

- **Simple flow** -- one agent plans, calls a tool, and reports. A few
  seconds, easy to read on a first look.
- **Subagents + error** -- an orchestrator plans, searches, and spawns two
  subagents (one succeeds, one errors) while a guard check and a human
  approval run alongside them. The same scenario used for the root README's
  hero image.

To try the "send to a hub" half: start a hub in another terminal --

```
npx @atriarch-systems/tracery-hub
```

-- check **Also send to a hub**, leave the URL at its default
(`http://127.0.0.1:8971`), leave the API key blank (a local-mode hub has
auth off), and click **Generate**. Once the first batch is accepted, an
**Open in hub ↗** link appears pointing at that flow in the hub's own hosted
UI. Against a hub started with `TRACERY_API_KEYS` configured instead, paste
a key with the `ingest` role.

`src/scenarios.ts` has the exact event schedules, timed with real
`setTimeout` delays rather than fired all at once, so the graph visibly
grows the same way a real agent's activity would. `src/sendToHub.ts` posts
them to `POST /v1/events` (SPEC.md §6) with a plain `fetch()` -- see there
for why this example doesn't use `@atriarch-systems/tracery-client`'s `ActivityTracer`
builder API for this.

For cross-origin hub delivery, set `TRACERY_ALLOWED_ORIGINS` to this page's exact
origin (for example `http://localhost:5173`) when starting the hub. Use the actual
port Vite prints. This is required in local mode too. Native SDKs are unaffected.
