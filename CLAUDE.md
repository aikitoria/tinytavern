# CLAUDE.md

Repository instructions for coding agents. `AGENTS.md` links to this file.

## Project

MiniTavern: self-hosted chat frontend for OpenAI-compatible LLM APIs with tree-structured conversation history (branch on edit, swipe AI replies as siblings). Everything runs in Docker — no node process is expected to run on the host, so run commands through `docker compose`.

## Live environments — do not disturb

The user keeps stacks running while working. Treat them as someone else's live session:

- **Dev stack** (`docker-compose.dev.yml`: `server`, `client`, `caddy-dev`, HTTPS host port 5173, state in `./data-dev`) is the user's live hot-reload environment. Never `up`, `stop`, `restart`, or attach `--profile mock` to it. Application source edits hot-reload on their own. Caddy image/configuration or Compose changes require deployment; do not deploy unless the user requests it.
- **Prod stack** (`docker-compose.yml`: Node container `minitavern` plus `caddy-prod`, host port **5487**, state in `./data`) may also be running. Never touch it or its data.
- Never run tests or ad-hoc scripts against either live server — the e2e suite mutates global settings, creates endpoints/conversations, and would repoint the active endpoint at the mock mid-session.
- One-off throwaway containers are always safe: `docker compose -f docker-compose.dev.yml run --rm --no-deps server <cmd>` (used for typecheck/format below). It does not start or affect stack services.

## Screenshots

When the user references a screenshot by bare filename (e.g. `chrome_o4vT3bpfcy.png`), the file is in `/raid/share/` — Read it from there before responding.

## Stack setup and maintenance

Both stacks use Caddy for HTTPS and public HTTP/1.1, HTTP/2 and HTTP/3 traffic.
Only Caddy publishes application ports. Node serves APIs and WebSockets over
internal HTTP; Vite serves the dev client and HMR over internal HTTP.

| Stack       | Compose file             | Public URL            | Services                        | Data         |
| ----------- | ------------------------ | --------------------- | ------------------------------- | ------------ |
| Production  | `docker-compose.yml`     | `https://<host>:5487` | `minitavern`, `caddy-prod`      | `./data`     |
| Development | `docker-compose.dev.yml` | `https://<host>:5173` | `server`, `client`, `caddy-dev` | `./data-dev` |

Both require `certs/cert.pem`, `certs/key.pem`, and the external Docker network
`my-bridge-network`. Services run as UID/GID `1000:1000`; media directories and
private files must be accessible to that user. `scripts/init-caddy.sh --media-dirs`
creates directories and separate dev/prod media-signing and proxy keys under
`.secrets/`, preserving existing keys. Never log or commit those keys.

For a new installation or an explicitly requested deployment:

```sh
./scripts/init-caddy.sh --media-dirs

# Production: Node image plus Caddy image containing the compiled client.
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d --no-build minitavern caddy-prod

# Development: bind-mounted application sources and Caddy in front of Vite.
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm install
docker compose -f docker-compose.dev.yml build caddy-dev
docker compose -f docker-compose.dev.yml up -d --no-build server client caddy-dev
```

The stacks share a Compose project name and use distinct service names. Never
use `--remove-orphans`: it can remove the other stack. For a Caddy-only change,
build that service and apply it with `up -d --no-deps --no-build caddy-dev` or
`caddy-prod` using the appropriate Compose file. Application source edits in
dev need no container action. Do not attach the mock profile to the live stack;
use the isolated regression command below.

Reload certificate files through the wrapper, which reads the proxy key before
Caddy adapts its configuration:

```sh
docker compose -f docker-compose.yml exec caddy-prod minitavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f docker-compose.dev.yml exec caddy-dev minitavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
```

Production database backup: `docker compose exec minitavern node server/src/backup.ts /data/backups/<unique-name>.db`.
The helper uses SQLite's online backup API and refuses to overwrite files. Never
copy an active database file directly; the WAL may contain committed changes.
A full backup also needs the media directories. Preserve `.secrets/` across
container replacements.

## Commands

```sh
# First time / after dependency changes
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm install

# Typecheck (tsc --noEmit for server + client; there is no lint step)
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm run check

# Format (Prettier, enforced repo-wide)
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm run format

# Standalone regressions: launcher creates temporary data/DB paths before importing server code
docker compose -f docker-compose.dev.yml run --rm --no-deps server npm test

# HTTP E2E tests — run fully ISOLATED, never against the live stacks:
# separate compose project, server+mock inside one throwaway container,
# container-local DATA_DIR, non-default ports.
docker compose -p minitavern-e2e -f docker-compose.dev.yml run --rm --no-deps \
  -e MEDIA_SIGNING_KEY_FILE= -e CADDY_PROXY_KEY_FILE= -e SESSION_COOKIE_NAME=minitavern_session \
  -e DATA_DIR=/tmp/e2e-data -e E2E_BASE=http://127.0.0.1:15487 -e E2E_MOCK=http://127.0.0.1:19800/v1 \
  server sh -c 'PORT=15487 node server/src/index.ts >/tmp/server.log 2>&1 & \
    PORT=19800 node tests/mocks/server.ts >/tmp/mock.log 2>&1 & \
    sleep 2; npm run test:e2e; ec=$?; tail -5 /tmp/server.log; exit $ec'
# Afterwards: docker network rm minitavern-e2e_default
```

`npm test` discovers all `tests/*.test.ts` files and runs each in a separate
process with temporary data and database paths. Filter by filename stem with
`npm test -- client-sync` (or multiple stems). `npm run test:e2e` runs the feature
modules under `tests/e2e/` in their declared order; the runner passes shared
fixtures between scenarios. Its mock server is `tests/mocks/server.ts`. Keep
HTTP E2E runs isolated as shown above. Both suites are part of normal validation.

The presence of `E2E_BASE`/`E2E_MOCK` automatically switches the server and mock to fast timing (mock token cadence 3 ms, comfy poll 100 ms, speculation backoff 50 ms — production defaults are 15/1500/500), so a full run takes ~20 s instead of >1 min. `MOCK_TOKEN_MS`/`COMFY_POLL_MS`/`SPECULATION_BACKOFF_MS` override; keep tokens >= ~3 ms — several tests act mid-stream and need the generation to still be in flight.

**Caddy edge**: `caddy/Caddyfile` selects `/images/*` and `/avatars/*` for the local `minitavern_signed_url` matcher, which only validates the exact signed URI and expiry. Node signs outgoing DTOs in `mediaUrls.ts` (24-hour URLs, reused to avoid repeated signing; no client renewal), never DB/export/copy paths. Caddy serves media directly from read-only directory mounts with `Cache-Control: private, no-store`; signed URLs remain valid until expiry regardless of session revocation. APIs/WS stay session-authenticated in Node. `proxy.ts` requires a private header that Caddy overwrites before accepting original-client-IP/protocol headers. Only Caddy publishes application TCP/UDP ports; dev proxies Vite/HMR, prod serves its compiled client. `.secrets/{dev,prod}` keys are initialized by `scripts/init-caddy.sh`; changes apply on container recreation, never restart/recreate the live stacks during implementation. The isolated HTTP regression command above disables Caddy credentials for its container-local server and mock.

There is no server build step: Node 26 runs the TypeScript sources directly (`node server/src/index.ts`). Only the client is bundled (Vite), and only for production.

## Architecture

npm workspaces: `shared/` (contracts and the callback-based SSE frame reader), `server/` (dependency-light Node: `node:sqlite`, `ws`, hand-rolled router), `client/` (SolidJS + Vite).

**`shared/src/index.ts` is the contract.** All entity types (`Message`, `Conversation`, `Character`, `Endpoint`, …), the WebSocket protocol (`ServerEvent` / `ClientCommand`), and default settings live here and are imported by both sides. Protocol changes start in this file.

**Server-authoritative state, clients are pure viewers.** All state lives in SQLite (`server/src/db.ts`, schema migrations via `PRAGMA user_version`, WAL mode). All SQL goes through `stmt()` from db.ts — a memoized prepared-statement cache; never call `db.prepare` directly. Clients never mutate locally; they call REST endpoints under `/api/` and receive updates over the `/ws` WebSocket:

- `tree` — full snapshot of a conversation's message tree (sent on subscribe; also the client's resync fallback)
- `treePatch` — incremental structural update after mutations (`broadcastTree` coalesces per microtask): `nodes` lists every message's structure (absent ids were deleted), `messages` carries full bodies only for messages created/edited since the last frame (tracked via `markMessageDirty` in tree.ts). Structural updates include `parentId` — splice deletions and block moves reparent messages without resending bodies, and the client must apply it.
- `delta` — streaming token append (`d` = content, `r` = reasoning) for one message id
- `final` — a message finished streaming
- `imageProgress` — image render progress (e.g. sampler steps) for a message with `imagePending`
- `invalidate` — an entity list (characters, endpoints, settings, …) changed; client refetches via `client/src/state/api.ts`

Each WebSocket client subscribes to at most one conversation (`events.ts`). The client keeps one global Solid store (`client/src/state/store.ts`); `ws.ts` reconnects with backoff and resubscribes/resyncs on reopen. Mobile PWA resume/online/BFCache lifecycle events deliberately replace even an apparently-open socket because a suspended browser can retain a dead WebSocket with `readyState === OPEN`; socket callbacks are identity-guarded so the replaced connection cannot clobber its successor. A successful swipe whose authoritative tree frame does not arrive within 750 ms triggers the same refresh while holding its animation for the reconnect snapshot (5 s is the final offline spring-back).

**Client conventions**: the settings editors are imperative — they load/save via `.value` on refs (`createEntityEditor` in util.ts). Two custom components honor that contract: `MacroTextarea` (macro-highlight overlay; intercepts the element's `value` property so programmatic loads re-render, and mirrors scrollbar width/scroll position onto the overlay) and `Select` (scroll-proof dropdown replacing native `<select>`, which closes on any wheel tick; exposes a `SelectHandle` with a `value` accessor). Sibling swipe animations run off the `pendingSwipe` signal in store.ts: the outgoing side slides fully out and holds until the replacing `treePatch` unmounts it, the incoming sibling/descendants consume the signal at mount time to slide in.

**Route registration is by side effect.** `server/src/router.ts` is a tiny regex router; each file in `server/src/routes/` registers its routes at import time, and `server/src/index.ts` imports them for their side effects. A new route file does nothing until added to that import list. Entity CRUD (presets, templates, personas, characters, endpoints) is table-driven: `defineEntityRoutes` in `server/src/routes/entityRoutes.ts` generates list/create/patch/delete/duplicate from a field spec (column, validator, current-value merge; duplicate copies the full row including secrets and import blobs, plus side-band files such as avatars via `onDuplicate`); only bespoke routes (avatars, card import/export, model fetching) live in the per-entity files. Adding a column to an entity means: schema migration, shared type, `toX` mapper, one field-spec line.

**The message tree** (`server/src/tree.ts`): messages form a tree via `parentId`; each node stores `activeChildId` and the conversation stores `activeLeafId`. `setActiveLeaf` repoints `active_child_id` along the entire new path — this invariant is what lets switching back to a branch restore the deep chain that was previously active beneath it.

**Tree operations**: the delete button means "remove this block from the screen" (`spliceMessage`): the message AND its sibling swipes are deleted (a swipe's subtree dies with it) while the message's own children reattach to its parent. "Delete swipe" removes only the selected sibling and its subtree (`deleteMessage`), activating another sibling when available; whole-tail removal is `/del` (delete-tail). `rotateDown` implements the ⋯ menu's move up/down as a block rotation: the moved message's sibling group reattaches under its active child, whose group rises to the parent, and its former children reattach under the moved message. Duplicate inserts a copy immediately after the source, reparenting its existing children beneath the copy so the continuation stays intact; content/name/reasoning/render-config and generated images are copied, with image files stored under independent paths. "Branch to new conversation" copies only the root→selected-message ancestry into a new linear chat with the source conversation's character/persona/endpoint/speaker/scenario-override configuration; generated image files are copied, never shared.

**Optimistic concurrency** (`server/src/concurrency.ts`): mutating conversation endpoints require `expectedActiveLeafId`; a mismatch returns 409 and rebroadcasts the tree so the stale client resyncs. Settings writes are similarly guarded by a monotonic `revision`.

**Synchronous route handlers are the concurrency model.** Route handlers in `server/src/routes/` are race-free only because they run fully synchronously between check and act — Node's single thread serializes them against each other and against generation/streaming callbacks, so guard-then-act sequences like `hasActiveGeneration` → `startGeneration` are atomic. Introducing a single `await` mid-handler reopens double-generation and active-leaf races; if a handler ever needs to await, every checked precondition must be re-validated after it.

**Generation** (`server/src/generation.ts`): in-flight streams are kept in an in-memory `active` map keyed by message id, with a dirty-flagged flush timer persisting to the DB. `mergeLiveBuffers` overlays in-flight content onto tree snapshots so a client subscribing mid-stream sees partial text. The endpoint resolves per generation: conversation `endpointId` override → global `activeEndpointId`. Transient upstream failures (5xx/429, network errors, idle timeout) retry up to 2× on foreground generations, resuming from the partial content prefill-style unless the endpoint disables prefills; 4xx fails immediately and the client toasts `genMeta.error` (background swipes rely on speculation.ts's own retry instead). The `active` map uses identity checks (`active.get(mid) === gen`) because `continue` reuses message ids.

**Prompt assembly** (`server/src/prompt.ts`): the system prompt resolves character `customPrompt` → character preset → global default preset. The template resolves character inline `customTemplate` (a JSON `CustomTemplate` with the same settings as a template entity) → character `templateId` → global default template → built-in `DEFAULT_PROMPT_TEMPLATE` (`resolveTemplate`). A template carries: content (rendered with `{{#if}}` blocks and macro slots — `{{system}}`, `{{personality}}`, `{{persona}}`, `{{scenario}}`, plus `{{examples}}` fed from the character's example-conversation partials, SillyTavern `mes_example`), an optional fake first user message, speaker-name prefixing (which also drives assistant prefill via the endpoint's `prefillMode`), `usesPersonas` — when false the persona is ignored entirely (`{{user}}` = "User"; the client mirrors this via the `personasEnabled` memo) — and `steerTemplate` (the steer format for steered regeneration, resolved through the same chain via `resolveSteerTemplate`; empty — including old inline-template blobs that predate the key — falls back to `DEFAULT_STEER_TEMPLATE`). `Conversation.scenarioOverride` replaces the character scenario for that chat when non-null; an empty string intentionally suppresses the scenario.

**Tree map** (`client/src/components/TreeMap.tsx`): `viewMode: 'map'` renders the whole message tree as a pan/zoom canvas — O(n) layout off `childrenByParent()` (leaves get successive rows, parents center on children, depth → columns), fixed 640×240 cards each mounting a real `MessageNode inMap` (touch gestures disabled; action chrome hidden via treemap.css), bezier edges drawn in screen space on a viewport-sized canvas (no world-sized layers — they exceed GPU texture limits and blank the UI at extreme zoom-out; likewise no `will-change` on the content layer), ImageViewer-style transform pan/zoom, and rAF viewport culling. The layout never changes with zoom (no relayout jumps): below scale 0.45 a card swaps its MessageNode for a snippet tile whose font scales inversely with zoom (constant screen size, em-based CSS in treemap.css, fixed slot clips overflow). Opens centered on the active leaf at scale 1; click activates the branch (stay in map), double-click jumps back to chat.

**Plugins** (`client/src/plugins/`): a client-side plugin (contract in `api.ts`, registry in `index.ts`) contributes composer tools-menu buttons, slash commands, a page in Settings → Tools (`ToolsTab` renders any plugin with a `settingsPage`), and a `messageView` — it claims tool messages by their data and `create()` returns `Header`/`Body` render functions sharing per-message state via closures (MessageNode delegates to them); an optional `swipe` handles both global Left/Right and horizontal touch gestures when the claimed message is last above the composer. Plugin CSS lives in a plugin-owned stylesheet imported by the plugin module. Plugin settings persist in `Settings.pluginSettings[pluginId]` (arbitrary JSON blob, revision-guarded like all settings, synced via the settings invalidate; `pluginSettings()` reads merged defaults; editors save through `api.putSettings` using their loaded revision). The Image Generation plugin is the reference: `/image [instruction]` expands `{{instruction}}` client-side, then runs a **tool generation**; swiping forward while its prompt is streaming cancels it before rendering.

**Tool generations** (`POST /api/conversations/:id/tool`): a plugin prompt runs as a foreground generation streaming into a `role: 'tool'` message appended at the active leaf — so the normal streaming/retry machinery applies unchanged. The prompt gets the full chat context plus the macro-expanded prompt as a trailing user turn (`buildToolPrompt`; `{{char}}`/`{{user}}` expand server-side, no name prefill), snapshotted at route time via the generation's `promptOverride` so retries stay consistent. Tool messages are chat-visible but skipped by `buildChatMessages`, so they never enter later prompt history; they can't be swiped/advanced/resumed (assistant-role guards on both sides). Multiple tool prompts may stream concurrently because each is an independent snapshot; deleting an older tool block preserves active descendants and only stops streams whose rows are actually deleted. Starting one discards an in-flight speculative swipe without refilling (a branch switch restarts speculation anyway).

**Image rendering** (`server/src/comfy.ts`): a tool request may carry `image: { workflow, comfyUrl }` (ComfyUI API-format JSON with `{{prompt}}`/`{{seed}}` slots, validated at route time, persisted on the message as `image_render_json`). When the text generation completes, the server expands `{{prompt}}` (JSON-string-escaped message content) and `{{seed}}` (fresh random int per render), submits to ComfyUI with `extra_data.preview_method = 'taesd'`, and listens on the job-scoped Comfy WebSocket. JSON sampler progress and validated binary JPEG/PNG preview frames are relayed as ephemeral `imageProgress` events; previews live only in client progress state and replace the placeholder until the final image arrives. Polling `/history` still drives completion, so the socket is optional. The server downloads the output, appends it to the message's `images[]` (served with `Cache-Control: private, no-store` under `/images/`, stored in `DATA_DIR/images`), then drops ComfyUI's copy with a fire-and-forget `DELETE /view` (same params as the download; our copy is the durable one, so failures are only logged) — this lives in `renderToBuffer`, so every render path including avatar generation cleans up. `imagePending` flags an in-flight render (cleared by finalize on non-done text generations, by the failure path with `genMeta.imageError`, and at boot). `POST /api/messages/:id/render-image` re-renders with a fresh seed; the client supplies the currently selected workflow, which replaces the stored snapshot, while a missing current selection falls back to `image_render_json`. `/:id/active-image` persists the selected alternative; `/:id/delete-image` removes the selected within-message image swipe, hard-deletes its file, and selects the nearest survivor while retaining the prompt/message (including when no images remain). **Image files are hard-deleted with their rows**: every deletion path collects doomed paths before the SQL and unlinks after commit (`server/src/images.ts`), with a startup sweep of unreferenced files as the crash-window backstop. The compose files join the external `my-bridge-network` so the server reaches ComfyUI at `http://comfy:8588`; the mock implements the ComfyUI surface (`/prompt`, `/history`, `/view` — GET and DELETE, both with strict file params — ws progress and binary previews) for e2e, including failure injection via `/control/comfy-fail-next?stage=prompt|render&count=N` and a `/control/comfy-deleted` log of deleted outputs.

**Saved image gallery** (`server/src/routes/gallery.ts`): saving a specific message image swipe copies the raster to a gallery-owned file and snapshots its prompt, render configuration, character name, and optional source links in `gallery_items`. The `source_message_id`, `source_conversation_id`, and `character_id` foreign keys use `ON DELETE SET NULL`; they are navigation/grouping metadata, never ownership, so deleting the source swipe/message/conversation/character cannot delete or orphan the gallery copy. Gallery generation opens an editable prompt form; its second form can SSE-stream an LLM revision from the current prompt plus an edit instruction using the same `appendImagePromptRevisionTask` as chat image regeneration, even after the source chat is gone. Rendering uses the submitted prompt with the currently selected workflow (or the saved workflow fallback) to create a separate gallery item rather than appending an alternative to its source; a job-scoped SSE stream shared with avatar rendering carries live sampler progress and preview frames for the pending card. Selection mode can bulk-delete arbitrary saved items through one transactional route; gallery deletion owns only gallery paths. `sweepOrphanedImages()` treats message image arrays and gallery image paths as live references.

**Avatar generation** (`server/src/routes/avatarGenerate.ts`): an interactive, client-driven flow — nothing is stored until the user confirms. `POST /api/{characters,personas}/:id/avatar/prompt` takes the active avatar preset's paired `{ prompt, context }` templates, expands `{{name}}`/`{{char}}`/`{{user}}`/`{{description}}`/`{{personality}}`/`{{scenario}}`/`{{firstMessage}}` from the entity row (characters have no `description` column — `{{description}}` maps to `personality`, matching card import/export), sends them as separate system/user messages, and SSE-streams the completion (`data: {d}` deltas, `{error}`, `{done}`) via `streamChatCompletion` in generation.ts (streaming sibling of `chatCompletionOnce`, same refusal/empty diagnosis, global active endpoint); a per-entity in-memory guard 409s a second concurrent stream. Old clients that omit `context` receive the server's field-serialized fallback. `POST /api/avatar/render` is stateless: `{ prompt, image: { workflow, comfyUrl } }` (validated by `parseImageConfig`) → image bytes via comfy.ts's `renderToBuffer`; a caller-provided `jobId` gets sampler progress and transient TAESD preview data URLs through a private job-scoped SSE stream registered before submission, preventing first-step races and cross-modal leakage. Saving is the normal `PUT .../avatar` route, so PNG enforcement lives there. On the client the image plugin owns the flow: the paired avatar prompt preset + a dedicated `avatarWorkflow` selection ('' falls back to the /image workflow) in its tool settings, and `AvatarGenerateModal` (`client/src/plugins/AvatarGenerateModal.tsx`) opened from the `generate` prop on `AvatarRow` — it streams the prompt into an editable textarea, auto-renders with the live preview in the modal, and offers regenerate (fresh seed), edit-and-rerender, save, or cancel. The mock records completion requests (streaming or not) at `/control/last-completion` for e2e macro assertions.

**Assistant is a seeded character** (migration 11), not a special case: `characterId: null` remains a legacy/fallback path. Conversations created with a greeting-less character start titled "New chat" and auto-title from the first message; greeting characters are titled with their name. Once the FIRST assistant reply in a "New chat" conversation completes, a silent one-shot (non-streaming) completion through the resolved endpoint generates a short LLM title (`maybeAutoTitle` in conversations.ts): it only fires while the title is still the placeholder/fallback (a user rename wins), never bumps `updated_at`, and keeps the old title on failure.

**Steered regeneration** (`POST /api/messages/:id/regenerate`): the prompt is snapshotted at route time via `promptOverride`, and the one-off revision request never enters message history. Assistant results remain assistant sibling swipes: the original reply is included and followed by an alternating-safe user turn rendered through the conversation's resolved `steerTemplate` (`resolveSteerTemplate`: character inline `customTemplate` → character `templateId` → global default template → `DEFAULT_STEER_TEMPLATE`; `{{instruction}}` slot). Image-plugin tool results are appended as child tool messages after the source (image alternatives remain the special within-message image swipes), retain their render config, and automatically render a fresh image. `buildSteeredToolPrompt` preserves the unchanged roleplay history as the upstream prefix (for prefix caching and contextual references), then appends an alternating-safe `[IMAGE PROMPT REVISION TASK]` that marks history as reference-only and separately tags `<original_image_prompt>` and `<revision_instruction>` so the model does not continue the roleplay.

**`updated_at` means "last new content"**: content-creating routes (send, spawn, resume, edits, deletes) call `touchConversation`; `setActiveLeaf` deliberately does NOT bump it, so branch switching and swiping between already-seen siblings never reorder the sidebar. Swiping onto a not-yet-seen speculative sibling does bump — revealing it is the moment that content "arrives", same as a foreground regeneration.

**Search**: message contents are indexed in an external-content FTS5 table (`messages_fts`, kept in sync by insert/update/delete triggers on `messages` — any SQL write path is covered automatically). The search route quotes user tokens as FTS phrases (last token prefix-matched) and generates snippets; note `snippet()` refuses aggregate contexts and SQLite flattens subqueries, so best-per-conversation dedupe happens in JS. Titles use escaped-LIKE substring search. Entity list endpoints sort by name (`COLLATE NOCASE`).

**Speculative swipes** (`server/src/speculation.ts`): when `backgroundSwipeGeneration` is on, the server keeps one unread assistant sibling ahead of the active leaf (`generationKind: 'speculative'`), only while the conversation has a connected viewer and its character has not opted out via `disableBackgroundSwipeGeneration`. By default preparation waits for the primary reply to finish; `parallelBackgroundSwipeGeneration` allows the active streaming reply and its one speculative sibling to overlap (at most two streams, still only one unread alternative). Swiping to the prepared reply stops the outgoing primary, promotes the prepared reply, and refills under the same limit. Stopping/failing the primary, leaving the last subscription, or changing branches cancels in-flight background work and retries. Context changes discard prepared swipes; refill retries use backoff capped at 8 attempts, with explicit user actions resetting the budget.

**Access control**: Caddy applies the configured source-IP allowlist to the entire application; every Node HTTP request and WebSocket upgrade is first gated by source IP (`server/src/ipAccess.ts`, using the client IP forwarded by the trusted Caddy service). Configured via `MINITAVERN_IP_ALLOWLIST` in a gitignored `.env`; the Compose files default to an empty value, which allows all addresses. Docker-internal traffic (e.g. the mock, e2e runs) needs `172.16.0.0/12`. An optional password under Settings > General adds a second server-side gate (`server/src/auth.ts`): API routes and WebSocket upgrades require an opaque HTTP-only session cookie. Caddy media routes use expiring signed URLs issued through authenticated DTOs. Session token hashes/expiry live in SQLite so cookies survive server restarts; raw tokens exist only in cookies. Only the static login shell and exact `/api/auth/{status,login,logout}` endpoints are public behind the IP/origin checks; password changes revoke all persisted sessions and connected sockets.

**Mock LLM** (`tests/mocks/server.ts`): OpenAI-compatible streaming endpoint at `http://mock:9800/v1` (from inside the compose network) with `/control/*` endpoints to inject failures; the e2e suite drives it.
