# Sharing

Sharing is the viral loop: a link (or a downloadable image, or a
standalone `.html` file) that lets someone with no Tracery Graph account and no
API key look at one flow or trace. Every surface a share reaches carries a
small "Tracery Graph" mark and an "Open in Tracery Graph" line — enough to be
recognizable, not enough to be obnoxious.

Three ways to hand someone a view of your graph, in increasing order of
"how little the recipient needs":

1. **A share link** (`/s/:token`) — needs a browser and network access to
   the hub. Live-updating if you choose, revocable at any time.
2. **A PNG image** — needs nothing at all; paste it into a chat, an issue,
   a slide. A frozen snapshot of the current view.
3. **A standalone `.html` file** — needs a browser but no network access
   at all, including no hub to reach. Built for local mode, where a share
   link is useless (nobody outside your machine can open it).

## What a share is

`POST /v1/shares` creates a `ShareRecord`: a random, unguessable 32-byte
token, the flow or trace it points at, a mode (below), whether it carries
producer context, an expiry, and (optionally) a preview image. The token
is the entire credential for every public route under
`/v1/shares/:token/*` and the share page at `/s/:token` — there is no API
key check on any of them, and a share is scoped read-only to exactly the
flow or trace it names, never the rest of the workspace.

```
POST /v1/shares
{ "target": { "type": "flow", "id": "triage-cve-2026-1234" },
  "mode": "snapshot", "includeContext": false, "expiresInDays": 30 }
→ { "id": "...", "token": "...", "url": "https://tracery.example.com/s/<token>" }
```

`GET /v1/shares` lists the calling key's own shares (or every share in the
workspace, for an admin key) — tokens are never included in a list, only in
the response to the `POST` that minted them. `DELETE /v1/shares/:id`
revokes one; only its creator or an admin key may do that.

## Snapshot vs. live

Every share is created in one of two modes:

- **`snapshot`** (the default, and what the web UI picks when the flow
  already looks complete): frozen at the moment of creation. The hub
  records the current hub-wide cursor as the share's `snapshotCursor`, and
  every read through that share — `/flow`, `/trace`, `/events`, the
  embedded HTML export — is capped there. Events ingested after the share
  was created are invisible to it, forever, even if the same flow keeps
  running. There is no live feed for a snapshot share; `WS
  /v1/shares/:token/live` closes immediately (code `4400`) if you try.
- **`live`** (what the web UI picks when the flow still looks like it's
  running): no cap at all. `GET .../events` always reflects the current
  state, and `WS /v1/shares/:token/live` streams new events exactly the
  way `WS /v1/live` does for an authenticated connection — snapshot frame,
  then events, then a heartbeat every 15s, with the same reconnect-from-
  cursor and slow-client-drop rules.

Snapshot is the safer default: nothing a share viewer sees can ever change
out from under a link you already sent someone, and nothing new the
producer emits after that moment leaks through a link you thought you'd
already shown someone. Choose `live` when you specifically want someone to
watch a flow run in real time.

## Redaction rules

A share's `includeContext` (default `false`) decides whether the
producer's `context` — the free-form JSON on ops, timeline entries, and
raw events — reaches the viewer at all. When it's `false`, every context
value the hub would otherwise send is replaced by its shape, never its
values:

```json
{ "_redacted": true, "keys": ["cve", "severity"], "bytes": 41 }
```

`keys` is the sorted list of top-level field names; `bytes` is the
serialized size of what was hidden. This applies uniformly everywhere
context could appear — a flow/trace summary's op contexts and timeline
entries, every event in `/events` or the live feed, and the embedded data
block in an HTML export — via one shared function (`redactContext` in
`apps/hub/src/routes/redact.ts`), so there is exactly one place that
decides what "hidden" looks like. `ActivityExplorer` recognizes the shape
and shows "Context hidden by the sharer" (with the key names, for a hint
at what's there) instead of a JSON blob that would otherwise just render
that same shape anyway.

Setting `includeContext: true` sends context through untouched — use it
only when you're sure nothing in it is sensitive; the hub has no way to
tell secrets from ordinary data on your behalf.

## Expiry and revocation

`expiresInDays` on creation sets when a share stops working — `7`, `30`
(the default), `90`, or the literal string `"never"`. `DELETE
/v1/shares/:id` revokes one immediately, by its creator or an admin key.
Neither expiry nor revocation deletes the `ShareRecord` — an authenticated
"Manage shares" list still shows a revoked/expired share (so you can see
you shared something and it's now closed), but every public route treats
an unknown, expired, or revoked token identically: a plain `404 not_found`
with no distinguishing detail. A scan of random tokens can't tell "never
existed" from "existed once and is gone now."

## Rate limits

Every public route (`/v1/shares/:token/*`, `GET /s/:token`, `WS
/v1/shares/:token/live`) is limited to 60 requests per minute per source
IP, via an in-memory token bucket (`apps/hub/src/routes/rate-limit.ts`).
Exceeding it gets `429 rate_limited`. This is per hub replica, not shared
across a `postgres`-backed multi-replica deployment — a looser bound than
a shared limiter, but still enough to stop any one instance from being
hammered by a scan or a runaway client.

## OG previews

`GET /s/:token` serves the hosted UI's `index.html` with Open Graph and
Twitter Card meta tags injected for that specific share — `og:title`
(the flow/trace's label), `og:description`, `og:url`, `og:image`, and
`twitter:card: summary_large_image` — so pasting a share link into Slack,
Discord, or a chat app shows a rich preview instead of a bare URL.
`og:image` points at `GET /v1/shares/:token/preview.png` when one has been
uploaded (the web UI does this automatically right after creating a share
— see "Share as image" below), or a static default image
(`apps/hub/web/public/tracery-share-default.png`, served at
`/ui/tracery-share-default.png`) otherwise. A preview is PNG only, capped
at 2 MB (`PUT /v1/shares/:id/preview`, by the share's creator or an admin
key).

## `TRACERY_PUBLIC_URL`

A share's `url` (and every OG tag's absolute URL) is built from
`TRACERY_PUBLIC_URL` when it's set, or the inbound request's own origin
otherwise (`Host`/`X-Forwarded-*`, falling back to the connection's own
protocol/host). Leaving it unset is fine behind a single reverse proxy
that already sets those headers correctly; set it explicitly whenever the
hub is reachable at a different public hostname than requests actually
arrive on — behind a CDN, a path-rewriting gateway, or anything else where
"the request's own origin" wouldn't be the address you'd hand someone.

```
TRACERY_PUBLIC_URL=https://tracery.example.com
```

## Share as image

Every share dialog (and the explorer's own header) offers "Download
image": `ActivityGraphHandle.toImage({ scale?, background?, mark? })`
(`@atriarch-systems/tracery-visualizer`) fits the current view, waits a frame, and
renders the live canvas onto an offscreen one at `scale` (default 2×)
resolution, optionally over a solid `background` (the graph canvas itself
is transparent) and with a small "Tracery Graph" mark in the accent color drawn
in the bottom-right corner (`mark`, default on). The result is a plain
PNG `Blob` — the web UI turns it into a downloaded file with no server
round-trip at all. Creating a share also renders and uploads one of these
automatically as the share's preview image (see "OG previews" above).

## Standalone HTML export

`GET /v1/flows/:id/export.html` and `GET /v1/traces/:id/export.html`
(read role; `?context=false` applies the same redaction a share with
`includeContext: false` gets) return a single downloadable `.html` file
(`Content-Disposition: attachment`) with everything inlined: the built
explorer app (`apps/hub/web`'s second Vite entry, `viewer.html`, built
with `vite-plugin-singlefile` so even the dynamically-imported graph
renderer chunk is folded in) plus a `<script id="tracery-data"
type="application/json">{ meta, events }</script>` block carrying the raw
event log for that flow or trace. Opening the file — via `file://`,
straight from disk, no server, no network request of any kind — renders
the exact same `ActivityExplorer` in share mode. This is the answer to
"local mode has no share links worth sending anyone" (nothing outside the
machine can reach a `/s/:token` URL served on `127.0.0.1`): the web UI's
share dialog puts "Export .html" first, above the link-creation form,
whenever the hub reports local mode, though the route itself works in any
auth mode.

The export 404s with a clear `viewer_not_built` message if
`apps/hub/web`'s `viewer.html` hasn't been built into `web/dist/` — same
"not built" spirit as the ordinary hosted-UI placeholder page.

## Client and React API

- `@atriarch-systems/tracery-client`: `HubClient.shares.{create,list,revoke,uploadPreview}`
  for the authenticated routes, and a standalone `ShareClient(token)` —
  `.meta()`, `.flow()`, `.trace()`, `.events(after?)`, `.previewUrl()`,
  `.live(onFrame)` — for the public ones. `ShareClient` sends no
  credential of any kind; the token in its URLs is the whole story.
- `@atriarch-systems/tracery-react`: `useShareSource(baseUrl, token)` returns an
  `ActivitySource` (plus `target`, `mode`, `label`, `includeContext`,
  `notFound`) driven by `ShareClient` — one fetch for a snapshot share, a
  live WebSocket (falling back to polling) for a live one.
  `ActivityExplorer` gains `readOnly` (renders the "Shared from Tracery Graph ·
  Open in Tracery Graph" footer) and `lockedTarget` (hides the flow picker
  sidebar — there is nothing else to pick, `useShareSource` only ever
  loads the one target's data — and limits the scope switch to what that
  target's data can actually answer: just "This flow" for a flow-target
  share, or "This flow"/"Whole trace" for a trace-target share, which
  loads every member flow).

## Auth summary

| Route | Auth |
| --- | --- |
| `POST /v1/shares`, `GET /v1/shares`, `PUT /v1/shares/:id/preview` | API key, `read` role |
| `DELETE /v1/shares/:id` | API key, `read` role, and (creator of that share OR `admin` role) |
| `GET /v1/shares/:token/*`, `WS /v1/shares/:token/live`, `GET /s/:token` | none — the token is the credential |
| `GET /v1/flows/:id/export.html`, `GET /v1/traces/:id/export.html` | API key, `read` role |

Local mode (`authMode: 'none'`) works the same as everywhere else in the
hub: every request is a full-access principal on the single `default`
workspace, and `createdBy` on a share made that way is the literal string
`"local"`.
