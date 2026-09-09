# CLAUDE.md

Repository instructions for coding agents. `AGENTS.md` links to this file.

## Project

TinyTavern: self-hosted chat frontend for OpenAI-compatible LLM APIs with tree-structured conversation history and ComfyUI image, video and image-description workflows. Media generation runs as durable background jobs with review drafts, gallery organization and rerun recipes. Everything runs in Docker. Never run a Bun or Node process on the host. Use the container scripts below for tooling: they copy source into a disposable container with no host mounts. Only explicitly requested output artifacts are copied back.

## Live environments — do not disturb

The user keeps stacks running while working. Treat them as someone else's live session:

- **Dev stack** (`docker-compose.dev.yml`: `server`, `client`, `caddy-dev`, HTTPS host port 5173, state in `./data-dev`) is the user's live hot-reload environment. Never `up`, `stop`, `restart`, or attach `--profile mock` to it. Application source edits hot-reload on their own. Caddy image/configuration or Compose changes require deployment; do not deploy unless the user requests it.
- **Prod stack** (`docker-compose.yml`: Bun container `tinytavern` plus `caddy-prod`, host port **5487**, state in `./data`) may also be running. Never touch it or its data.
- Never run tests or ad-hoc scripts against either live server — the test suite mutates global settings, creates endpoints/conversations, and would repoint the active endpoint at the mock mid-session.
- Use `scripts/run-in-container.sh` for throwaway work. Do not use a live service definition for tests or tooling: its writable data mount belongs to the running application.

## Screenshots

When the user references a screenshot by bare filename (e.g. `chrome_o4vT3bpfcy.png`), the file is in `/raid/share/` — Read it from there before responding.

## Stack setup and maintenance

Both stacks use Caddy for HTTPS and public HTTP/1.1, HTTP/2 and HTTP/3 traffic.
Only Caddy publishes application ports. Bun serves APIs and WebSockets over
internal HTTP; Vite runs under Bun and serves the dev client and HMR over internal HTTP. The backend has no direct TLS or compiled-SPA mode; its authenticated media/range routes remain available for isolated HTTP regressions.

| Stack       | Compose file             | Public URL            | Services                        | Data         |
| ----------- | ------------------------ | --------------------- | ------------------------------- | ------------ |
| Production  | `docker-compose.yml`     | `https://<host>:5487` | `tinytavern`, `caddy-prod`      | `./data`     |
| Development | `docker-compose.dev.yml` | `https://<host>:5173` | `server`, `client`, `caddy-dev` | `./data-dev` |

Both require `certs/cert.pem` and `certs/key.pem`. Compose creates the default
application network and a separate `<project>_comfy` network automatically. Optional
`TINYTAVERN_COMFY_NETWORK` and `TINYTAVERN_COMFY_NETWORK_EXTERNAL=true` in the ignored
`.env` select an existing external Comfy network. Preserve local overrides; never
hard-code an installation's network name in tracked configuration or documentation.
Only the application server joins the Comfy network. Services run as UID/GID `1000:1000`; media directories and
private files must be accessible to that user. `scripts/init-caddy.sh --media-dirs`
creates directories and separate dev/prod media-signing and proxy keys under
`.secrets/`, preserving existing keys. Never log or commit those keys.

For a new installation or an explicitly requested deployment:

```sh
./scripts/init-caddy.sh --media-dirs

# Production: Bun image plus Caddy image containing the compiled client.
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d --no-build tinytavern caddy-prod

# Development: read-only source mounts and image-owned dependencies.
docker compose -f docker-compose.dev.yml build server client caddy-dev
docker compose -f docker-compose.dev.yml up -d --no-build --force-recreate server client caddy-dev
```

The stacks share a Compose project name and use distinct service names. Never
use `--remove-orphans`: it can remove the other stack. For a Caddy-only change,
build that service and apply it with `up -d --no-deps --no-build caddy-dev` or
`caddy-prod` using the appropriate Compose file. Application source edits in
dev need no container action. Do not attach the mock profile to the live stack;
use the isolated regression command below.

An explicitly requested dev deployment recreates the Vite client too, clearing
cached module transforms from earlier hot reloads of shared sources. Vite watches
the entire shared source directory from startup, including new files and atomic
replacements. Individually mounted configuration and package files can retain
an old inode after an editor replaces the host file; those changes require
recreating the affected service as part of an authorized deployment.

Reload certificate files through the wrapper, which reads the proxy key before
Caddy adapts its configuration:

```sh
docker compose -f docker-compose.yml exec caddy-prod tinytavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f docker-compose.dev.yml exec caddy-dev tinytavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
```

Production database backup: `docker compose exec tinytavern bun server/src/backup.ts /data/backups/<unique-name>.db`.
The helper uses SQLite's online `VACUUM INTO` snapshot through `bun:sqlite`. It syncs the result and atomically publishes it without overwriting an existing path. Never
copy an active database file directly; it may contain a partially written transaction.
A full backup also needs the media directories. Preserve `.secrets/` across
container replacements.

## Commands

```sh
# Update the lockfile after editing dependency manifests. No host node_modules.
./scripts/run-in-container.sh install

# Server/client/scripts/tests typecheck; there is no lint step.
./scripts/run-in-container.sh check

# Format all supported source files; copy formatted sources back on success.
./scripts/run-in-container.sh format
./scripts/run-in-container.sh format:check

# Build the client and copy client/dist back on success.
./scripts/run-in-container.sh build

# Complete regression suite, including real HTTP/WebSocket integration.
./scripts/run-isolated-tests.sh
```

The scripts build cached dependency stages with frozen `bun.lock` installs, then
copy source into a disposable container. There are no host mounts, published
ports or live credentials. Only `install` needs network access; other tasks use
container loopback only. Dependency installs and caches stay inside containers.
Failures and interrupts remove the task container. `format`, `build` and `install`
copy their requested artifacts back only after successful execution. Image builds
do not deploy services. Rebuild and deploy dev services when dependency versions change.

The test command always runs every test; there are no filters or separate E2E
command. `tests/run.ts` discovers feature-grouped `tests/**/*.test.ts` files and
runs them through `bun:test`, with up to eight independent workers. SQLite's
schema and defaults are initialized once; each worker receives a copy of that
closed seed database on tmpfs. Related database cases reuse their connection and
reset fixture rows, not the schema. Browser-state cases use Solid's browser runtime.
`bun test` is the worker command; `bun run test` runs the complete coordinator.

Keep one direct regression for each meaningful invariant. Exercise combinations
in feature tests; use `tests/http/application.test.ts` for actual application
startup, HTTP/WS routing, streaming, authentication and concurrency guards.
Do not duplicate the same scenario across layers. Prefer controlled events or
mock clocks to real sleeps. Real process crashes and FFmpeg remain where those
boundaries are the behavior under test. Keep the complete warm-image command
under 15 seconds, including Docker startup, on the development machine.

**Caddy edge**: `caddy/Caddyfile` selects `/images/*` and `/avatars/*` for the local `tinytavern_signed_url` matcher, which only validates the exact signed URI and expiry. Bun signs outgoing DTOs in `mediaUrls.ts` (24-hour URLs, reused to avoid repeated signing; no client renewal), never DB/export/copy paths. Caddy serves media directly from read-only directory mounts with `Cache-Control: private, no-store`; signed URLs remain valid until expiry regardless of session revocation. APIs/WS stay session-authenticated in Bun. `proxy.ts` requires a private header that Caddy overwrites before accepting original-client-IP/protocol headers. Only Caddy publishes application TCP/UDP ports; dev proxies Vite/HMR, prod serves its compiled client. `.secrets/{dev,prod}` keys are initialized by `scripts/init-caddy.sh`; changes apply on container recreation, never restart/recreate the live stacks during implementation. The isolated test runner creates its own HTTP server and mock without live Caddy credentials.

There is no server build step: Bun 1.4.2 runs the TypeScript sources directly (`bun server/src/index.ts`). Only the client is bundled (Vite), and only for production.

Both Compose files select stages from the root `Dockerfile`: development uses
`tools`, and production uses `server-prod`. Development mounts source read-only and
keeps dependencies in the image. `scripts/watch-server.ts` watches server/shared
sources and gracefully terminates the application child before starting a fresh
process. Vite caches transforms under `/tmp`. Only the application data directory
is writable from the deployed server. Both server
images include FFmpeg for AV1 WebM inspection and thumbnail generation. Building an
image does not replace a live container. Source-only work still needs no service
action; applying a changed image remains a requested deployment.

## Architecture

Bun workspaces: `shared/` (contracts and the callback-based SSE frame reader), `server/` (native `bun:sqlite`, `Bun.serve` routing and WebSockets), `client/` (SolidJS + Vite).

**`shared/src/index.ts` is the contract.** All entity types (`Message`, `Conversation`, `Character`, `Endpoint`, …), the WebSocket protocol (`ServerEvent` / `ClientCommand`), and default settings live here and are imported by both sides. Media operations, workflows, assets and jobs are defined in `shared/src/media.ts` and re-exported here. Protocol changes start in this file.

**Server-authoritative state, clients are pure viewers.** All state lives in SQLite (`server/src/db.ts`, current schema in `server/src/schema.ts`, versioned via `PRAGMA user_version`; see `docs/database-schema.md` for future migrations, DELETE rollback journaling with `synchronous=EXTRA`). All application SQL goes through `stmt()` from db.ts — a memoized prepared-statement cache; never call `db.prepare` directly. Clients keep local form drafts and navigation state, but persistent mutations go through REST endpoints under `/api/` and receive updates over the `/ws` WebSocket:

- `tree` — full snapshot of a conversation's message tree (sent on subscribe; also the client's resync fallback)
- `treePatch` — incremental structural update after mutations (`broadcastTree` coalesces per microtask): `nodes` lists every message's structure (absent ids were deleted), `messages` carries full bodies only for messages created/edited since the last frame (tracked via `markMessageDirty` in tree.ts). Structural updates include `parentId` — splice deletions and block moves reparent messages without resending bodies, and the client must apply it.
- `delta` — streaming token append (`d` = content, `r` = reasoning) for one message id
- `final` — a message finished streaming
- `imageProgress` — progress for chat image attachments and interactive image rendering
- `mediaJob`, `mediaJobProgress`, `mediaJobDeleted` — global job snapshots, coalesced progress and history removal, independent of conversation subscription; initial/reconnect lists come from REST
- `mediaThumbnails` — batched asset thumbnail URLs/revisions, applied without refetching gallery, job or chat lists
- `invalidate` — an entity list (characters, endpoints, settings, …) changed; client refetches via `client/src/state/api.ts`

Live `Message` DTOs carry one required, ordered `media: MediaAsset[]`; `activeImage` indexes that array. URLs come from its assets, never a parallel `images` array. The database still stores `images_json`, and version-1 conversation transfer keeps its existing raster format at the serialization boundary. Attachment triggers guarantee an asset record for every stored path, including missing physical files; DTO mapping rejects missing records instead of silently shifting alternative indices.

Each WebSocket client subscribes to at most one conversation (`events.ts`). The client keeps one global Solid store (`client/src/state/store.ts`); `ws.ts` reconnects with backoff and resubscribes/resyncs on reopen. Mobile PWA visibility/focus/resume/online/BFCache lifecycle events deliberately replace even an apparently-open socket because a suspended browser can retain a dead WebSocket with `readyState === OPEN`; socket callbacks are identity-guarded so the replaced connection cannot clobber its successor. Connection attempts time out after 10 seconds and retry; reconnect refreshes the open media job and its variations as well as global data. A successful swipe whose authoritative tree frame does not arrive within 750 ms triggers the same refresh while holding its animation for the reconnect snapshot (5 s is the final offline spring-back).

**Client conventions**: the settings editors are imperative — they load/save via `.value` on refs (`createEntityEditor` in util.ts). Two custom components honor that contract: `MacroTextarea` (macro-highlight overlay; intercepts the element's `value` property so programmatic loads re-render, and mirrors scrollbar width/scroll position onto the overlay) and `Select` (dropdown replacing native `<select>`, which repositions on scroll; exposes a `SelectHandle` with a `value` accessor). All dropdowns use `DropdownSurface` and the single shared `.popover-surface`/`.popover-menu` appearance in `styles/controls.css`. Feature styles may arrange menu content, but must not redefine menu surfaces, row padding, typography, or selection colors. Sibling swipe animations run off the `pendingSwipe` signal in store.ts: the outgoing side slides fully out and holds until the replacing `treePatch` unmounts it, the incoming sibling/descendants consume the signal at mount time to slide in.

**Dialog stack and page URLs** (`state/dialogStack.ts`, `state/pageLocation.ts`): routed panes are retained as stable frames, rendered by `App` through `DialogContext`. Pushing Jobs, a media tool, gallery or settings keeps the covered component and its unsaved form/selection/scroll state mounted. Only the top pane writes its URL or plays previews. Back pops to the real parent; Jobs is a separate pane and never fabricates an empty draft. Opening an already-mounted job (including another variation of the same review draft) unwinds to that existing editor, retaining its local edits; removed child editors pass through their leave guards. Repeated job IDs in shared URLs normalize to a single pane. Flat hash routes describe the pane order: `#70+/gallery/123+/jobs+/media/job/<job-id>` and `#70+/conversation+/settings/characters/5?detail=1`. The root carries the background chat/map/trace view; individual panes retain gallery filters, settings selection and media context. Media routes use action names (`create-image`, `edit-image`, `create-video`), with `mode=first-frame` or `mode=references` for unsaved video inputs. Once a job exists its pane is `/media/job/<job-id>`; the server supplies the operation, context, inputs and workflow, and controls stay locked until the job loads. Reconstructing a new unsaved media pane seeds its first input from the nearest suitable gallery detail or saved job result in its ancestor panes; saved jobs and already-mounted editors keep their own inputs. Reload reconstructs the frames and fetches saved jobs, without serializing prompts, credentials, media URLs or local form buffers. Older path layouts normalize to the flat format; saved job IDs must be numeric. Browser Back/Forward retains the common frame prefix and guards every removed editor, including covered ones; Cancel restores the original history entry without consuming it. UI Back uses the parent's existing history entry when available, or replaces a deep link on close. `Modal` shares `dialogLayers` for activation, focus restoration and inert covered surfaces, including local pickers and confirmation dialogs. `uiBack.ts` routes Escape and hardware mouse Back to one top visible surface (including dropdowns, image viewers and mobile editor detail); one press cannot dismiss two layers. Navigation confirmations can appear above covered editors.

**Settings workspace** (`SettingsModal.tsx`): a full-screen page using the same `Modal fullscreen` shell as Gallery (`styles/pages.css`). Desktop section navigation sits beside the editor; below 1100px the shared Select in the header replaces it. Fields are centered at a maximum 960px width, while save bars span the available workspace. Forms use shared controls; related settings are grouped in subtly shaded sections with padding, and selectors share bordered inner groups with the fields they control. This treatment is shared across all settings pages. There are no settings-only input sizes. The header and shared action footer stay outside the scrolling editor on desktop and mobile. Entity editors retain their mobile list/detail navigation; SettingsActions portals each editor’s buttons into the shared footer. Back, Escape, section changes, and entity changes go through the existing Save/Discard/Cancel guard. Each editable setting uses `SettingLabel` and a conditional revert arrow; entity/preset editor pickers have no revert action. `createDefaultField` in `SettingField.tsx` tracks both native edits and imperative `.value`/`.checked` loads; Select resets call its explicit `change` method so dependent editors update too. Defaults are the built-in new-entity values, never an editable entity named or selected as default. Reverts affect one draft field and retain the existing save/guard behavior; avatar removal remains immediate. Section headings use spacing rather than divider lines, with a smaller gap below than above.

**Settings JSON transfer** (`shared/src/settingsTransfer.ts`, `SettingsTransferButtons.tsx`, `routes/entityTransfer.ts`): version-1 `tinytavern-settings` documents are scoped to a settings page or individual saved entity. Page settings import into the current draft and use the usual Save/Discard/revision guard. Entity-page imports have a review dialog and atomically merge records through the existing CRUD field validators; a snapshot hash rejects concurrent changes. Named items merge within their operation/reference-count group. References resolve by unique exact name, then unique case-insensitive name; missing or ambiguous names retain the destination selection. Imported IDs are never reused across installations. Protected entity defaults create editable copies. Persona JSON includes PNG avatar data; characters keep PNG cards, whose TinyTavern extension includes named prompt/template/folder references. Endpoint API keys and the access password are excluded from JSON transfer; an existing endpoint key is retained only when its origin is unchanged.

**Route registration is by side effect.** `server/src/router.ts` collects route declarations and compiles them once into `Bun.serve` native routes; each file in `server/src/routes/` registers its routes at import time, and `server/src/index.ts` imports them for their side effects. A new route file does nothing until added to that import list. Entity CRUD (presets, templates, personas, characters, endpoints) is table-driven: `defineEntityRoutes` in `server/src/routes/entityRoutes.ts` generates list/create/patch/delete/duplicate from a field spec (column, validator, current-value merge; duplicate copies the full row including secrets and import blobs, plus side-band files such as avatars via `onDuplicate`); only bespoke routes (avatars, card import/export, model fetching) live in the per-entity files. Adding a column to an entity means: schema migration, shared type, `toX` mapper, one field-spec line.

**The message tree** (`server/src/tree.ts`): messages form a tree via `parentId`; each node stores `activeChildId` and the conversation stores `activeLeafId`. `setActiveLeaf` repoints `active_child_id` along the entire new path — this invariant is what lets switching back to a branch restore the deep chain that was previously active beneath it.

**Tree deletion**: all production subtree and conversation deletes use `deleteMessageSubtrees` / `deleteConversationRows` from `db.ts`. They detach the doomed set’s parent/active-child edges and delete within one transaction, avoiding SQLite’s recursive cascade limit on deep trees. Collect media before deletion and repair the active path before the outer commit; never replace these helpers with a direct recursive-cascade delete.

**Tree operations**: the delete button means "remove this block from the screen" (`spliceMessage`): the message AND its sibling swipes are deleted (a swipe's subtree dies with it) while the message's own children reattach to its parent. "Delete swipe" removes only the selected sibling and its subtree (`deleteMessage`), activating another sibling when available; whole-tail removal is `/del` (delete-tail). `rotateDown` implements the ⋯ menu's move up/down as a block rotation: the moved message's sibling group reattaches under its active child, whose group rises to the parent, and its former children reattach under the moved message. Duplicate inserts a copy immediately after the source, reparenting its existing children beneath the copy so the continuation stays intact; content/name/reasoning/render-config and attached media are copied, with files stored under independent paths. "Branch to new conversation" copies only the root→selected-message ancestry into a new linear chat with the source conversation's character/persona/endpoint/speaker/scenario-override configuration; attached image/video files are copied, never shared.

**Optimistic concurrency** (`server/src/concurrency.ts`): mutating conversation endpoints require `expectedActiveLeafId`; a mismatch returns 409 and rebroadcasts the tree so the stale client resyncs. Settings writes are similarly guarded by a monotonic `revision`.

**Synchronous route handlers are the concurrency model.** Route handlers in `server/src/routes/` are race-free only because they run fully synchronously between check and act — Bun's single JavaScript thread serializes them against each other and against generation/streaming callbacks, so guard-then-act sequences like `hasActiveGeneration` → `startGeneration` are atomic. Introducing a single `await` mid-handler reopens double-generation and active-leaf races; if a handler ever needs to await, every checked precondition must be re-validated after it.

**Generation** (`server/src/generation.ts`): in-flight content and reasoning stay in an in-memory `active` map keyed by message id. The initial message row and generation token are created immediately for tree synchronization; streamed buffers are written once on completion, cancellation, or terminal failure, atomically with the status and conversation revision. There is no periodic persistence. SIGINT/SIGTERM cancel and save active generations before SQLite closes; a process crash loses the unfinished in-memory portion. `mergeLiveBuffers` overlays in-flight content onto tree snapshots so a client subscribing mid-stream sees partial text. The endpoint resolves per generation: conversation `endpointId` override → global `activeEndpointId`. Transient upstream failures (5xx/429, network errors, idle timeout) retry up to 2× on foreground generations, resuming from the partial content prefill-style unless the endpoint disables prefills; 4xx fails immediately and the client toasts `genMeta.error` (background swipes rely on speculation.ts's own retry instead). The `active` map uses identity checks (`active.get(mid) === gen`) because `continue` reuses message ids.

**Prompt assembly** (`server/src/prompt.ts`): `Character.name` is the UI label; its optional `chatName` override supplies `{{char}}`, greetings, default assistant message headers, and speaker prefills through the shared `characterChatName` helper. Explicit per-message or `/char` speaker names still win for speaker labels. Character cards preserve the nullable override in `data.extensions.tinytavern.chatName`. The system prompt resolves character `customPrompt` → character preset → global default preset. The template resolves character inline `customTemplate` (a JSON `CustomTemplate` with the same settings as a template entity) → character `templateId` → global default template (`resolveTemplate`); there is no runtime layout fallback. The seeded standard prompt and template rows are read-only; duplication produces editable rows. The UI hides editing/deletion actions for protected defaults, and entity routes reject PATCH/DELETE. Missing or empty template content emits no system message. `DEFAULT_PROMPT_TEMPLATE` supplies only the seeded/new-template editor value; runtime defaults are saved selections. A template carries: content (rendered with `{{#if}}` blocks and macro slots — `{{system}}`, `{{personality}}`, `{{persona}}`, `{{scenario}}`, plus `{{examples}}` fed from the character's example-conversation partials, SillyTavern `mes_example`), an optional fake first user message, speaker-name prefixing (which also drives assistant prefill via the endpoint's `prefillMode`), `usesPersonas` — when false the persona is ignored entirely (`{{user}}` = "User"; the client mirrors this via the `personasEnabled` memo) — and `steerTemplate` (the steer format for steered regeneration, resolved through the same chain via `resolveSteerTemplate`; the saved text is used directly; empty disables regeneration with an instruction). `Conversation.scenarioOverride` replaces the character scenario for that chat when non-null; an empty string intentionally suppresses the scenario.

**Tree map** (`client/src/components/TreeMap.tsx`): `viewMode: 'map'` renders the whole message tree as a pan/zoom canvas — O(n) layout off `childrenByParent()` (leaves get successive rows, parents center on children, depth → columns), fixed 640×240 cards each mounting a real `MessageNode inMap` (touch gestures disabled; action chrome hidden via treemap.css), bezier edges drawn in screen space on a viewport-sized canvas (no world-sized layers — they exceed GPU texture limits and blank the UI at extreme zoom-out; likewise no `will-change` on the content layer), ImageViewer-style transform pan/zoom, and rAF viewport culling. The layout never changes with zoom (no relayout jumps): below scale 0.45 a card swaps its MessageNode for a snippet tile whose font scales inversely with zoom (constant screen size, em-based CSS in treemap.css, fixed slot clips overflow). Opens centered on the active leaf at scale 1; click activates the branch (stay in map), double-click jumps back to chat.

### Media code map

`MediaJobsModal` is a separate routed `media-jobs` pane. Opening Jobs does not construct a media editor or compile its workflow; old embedded Jobs URLs normalize to this pane. `MediaToolsModal` owns only the generation/review editor.

Settings pages share `createSettingsSubmission` for revision tracking, submission locking and preserving edits made during a save. Their field storage and validation remain local. Navigation also guards pending submissions; Save/Discard wait for completion while Cancel remains available. `NamedCollectionToolbar` shares preset/workflow selection, inline rename and collection actions; storage/default-selection rules remain with each editor.

Entity CRUD and bulk settings transfer use `createEntityWriter` to evaluate fields against one current DTO and reuse write SQL. The callers retain their own transaction, validation, avatar rollback and publication boundaries. Speculative generation preparation, cancellation and refill live in `speculation.ts`; conversation lookup/touch helpers live in `conversationStore.ts` and do not register routes.

Media implementation is currently in `server/src/`, not a separate server media directory. Keep changes on the shared paths below rather than adding operation-specific workers or gallery-only generation APIs.

| Responsibility                                                 | Files                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Shared operations, workflows, assets, jobs and prompt defaults | `shared/src/media.ts`, re-exported by `shared/src/index.ts`                                     |
| Annotated workflow controls and seed randomization             | `shared/src/workflowInputs.ts`                                                                  |
| Job API, validation, capture and lifecycle                     | `server/src/routes/mediaJobs.ts`, `mediaJobs.ts`, `mediaJobStore.ts`                            |
| Review drafts and accept/discard                               | `server/src/mediaDrafts.ts`                                                                     |
| Comfy execution and remote file ledger                         | `server/src/mediaWorker.ts`, `mediaRemote.ts`                                                   |
| Downloads, result attachment and rerun recipes                 | `server/src/mediaFiles.ts`, `mediaJobResults.ts`, `mediaRecipes.ts`                             |
| Schema, local ownership and deletion                           | `server/src/schema.ts`, `db.ts`, `images.ts`                                                    |
| Character associations and thumbnails                          | `server/src/mediaCharacters.ts`, `mediaThumbnails.ts`                                           |
| Gallery and tool UI                                            | `client/src/components/Gallery*.tsx`, `client/src/media/`                                       |
| Image commands and avatar adapters                             | `server/src/comfy.ts`, `mediaImageAdapter.ts`, `routes/avatarGenerate.ts`, `client/src/images/` |
| Image description                                              | `server/src/mediaDescription.ts`, `comfyTextOutput.ts`, gallery `/describe` route               |
| Portable image recipes                                         | `server/src/conversationImageRecipes.ts`, `routes/conversationTransfer.ts`                      |

### Operations, settings and workflows

`MEDIA_OPERATIONS` defines the supported operations. Image editing is one operation with one to three references; it has no separate source slot. The removed first-and-last-frame video operation must not return to runtime selectors or APIs.

| Operation          | Slots                                         | Output       |
| ------------------ | --------------------------------------------- | ------------ |
| `image`            | None                                          | Raster image |
| `image-edit`       | `reference1`–`reference3`, selected count 1–3 | Raster image |
| `video`            | None                                          | AV1 WebM     |
| `video-first`      | `first_frame`                                 | AV1 WebM     |
| `video-references` | `reference1`–`reference3`, selected count 1–3 | AV1 WebM     |
| `image-describe`   | `source`                                      | Text         |

Users paste Comfy API-format JSON; do not search for or seed production workflows. When investigating installed Comfy APIs or nodes, read `/raid/workspaces/comfy/ComfyUI` and its custom nodes. Describe image starts unconfigured. Its text output is separate from image/video output validation.

`Settings.mediaRendering` owns the Comfy URL, `jobTimeoutSeconds`, named workflows, operation/reference-count defaults and avatar workflow selection. `mediaWorkflowKey(operation, count)` identifies each group. Reference-count editors are vertically stacked, each with its own selector and actions. The selected workflow is both the active default and the edited item; New/Duplicate/Rename/Delete and inline rename operate on that group. Avatar workflow selection is its own section; null inherits the Create image default. Image and video workflows must return media files from exactly one output node. More than one is an error before downloads; every observed remote output still enters cleanup. Do not reintroduce configurable output-node IDs.

Prompt settings are independent of rendering:

| Settings owner        | Content                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `imageGeneration`     | Chat image preset sets, avatar preset/context pairs and chat image revision templates |
| `galleryImagePrompts` | Standalone Create image and Edit image presets                                        |
| `chatVideoPrompts`    | Chat steering presets for each video operation                                        |
| `galleryVideoPrompts` | Standalone video presets                                                              |

The UI exposes Media rendering, Avatar prompts, Chat image prompts, Chat video prompts, Gallery image prompts and Gallery video prompts as separate settings pages. Chat video records contain only `chatPrompt`; gallery records contain `systemPrompt`, `userMessage`, `reasoningPrefill`, and `messagePrefill`. Video workflows may select chat and gallery presets independently. Image workflows select only a gallery preset; chat image tools use their dedicated sets. The media preset toolbar selects the operation default; its built-in Default is read-only. Settings import/export preserves these separate groups and remaps named references.

**Workflow binding.** `compileMediaWorkflow` parses a graph and discovers typed bindings; `expandMediaWorkflow` substitutes values once. `{{prompt}}` supplies final text. Reserved basenames `source.png`, `first_frame.png`, and `reference1.png`–`reference3.png` in `LoadImage`/`LoadImageMask` become their corresponding slot bindings. Subfolders and a trailing ` [input]` annotation are accepted. Explicit slot macros also support other loader nodes. Validate bindings against the operation and reference count. Other filenames and linked inputs stay untouched. The saved workflow JSON is never rewritten with upload paths.

**Exposed controls.** Supported primitive/KJNodes Int, Float, Text, Text (Multiline), and Boolean constants use `_meta.title`, e.g. `Duration [input: min=1, max=10, step=0.5, order=1]`. Numbers accept min/max/positive step; all types accept integer `order`. Text has no length or multiline title parameters: its node type determines single-line/textarea display. Boolean controls sit in the same field column as other values. Sort explicit order values ascending before unspecified nodes; ties retain graph enumeration order. Literal defaults and submitted overrides are validated on both sides. `workflowValues` maps control keys to typed values and is persisted in draft/recipe configuration. Switching workflows clears overrides. Apply overrides after macro expansion so user strings remain literal.

`ResolutionSelector` with `Resolution [input]` exposes eight aspect ratios plus a megapixels float (0.1–16, default step 0.1). Optional numeric limits apply to megapixels; `multiple` and output connections stay untouched. Keys are `<nodeId>.aspect_ratio` and `<nodeId>.megapixels`; ordinary constants use the node ID. Keep these two controls together and show the resolution hint. `client/src/media/workflowDefaults.ts` selects the nearest aspect ratio when opening a workflow from an image.

Numeric `seed`/`noise_seed` inputs, including flattened names such as `sampling_mode.seed`, receive the persisted job seed. Directly linked integer constants are randomized too, except explicitly exposed seed controls. Other computations retain their links. `{{seed}}` and `{{job_id}}` remain available for explicit bindings. Discovery needs no schema request to Comfy.

### Prompt preparation and chat integrations

Workflow compilation is cached by exact JSON content, with limits of 64 entries and 8 Mi UTF-16 source code units. Compiled graphs and controls are read-only derived state; each expansion creates a fresh graph before applying seeds and overrides. Operation/reference-count validation stays separate. Changing a workflow under the same ID cannot alter a captured job snapshot. `resolveJobConfiguration` shares default/snapshot resolution across draft edits and starts.

`/image`, `/imagechar`, and `/imageface` use the existing foreground tool-generation path: the full structured chat prefix plus a trailing user steering turn from `buildToolPrompt`, snapshotted before streaming. Tool messages are visible in chat but omitted from later LLM history. Assistant reply swipes/continue do not apply to tool text; image alternatives use their separate within-message controls. Tool generations may run concurrently, and deleting an older tool block preserves active descendants. Starting a tool discards speculative swipes without refilling them.

Media tools use persisted review drafts. For chat image creation, resolve `Settings.imageGeneration` through `shared/imagePrompts.ts`; the default follows `/imagechar`. The presence of a nonempty instruction chooses the with/without-instruction preset set. Switching sets retains a same-named preset or selects the default. Never combine these choices with gallery image presets.

For chat image/video preparation, retain `buildChatMessages` as the exact structured prefix, including assistant reasoning, then append the expanded steering using `appendChatMessage`'s role-merging rules. This preserves prefix-cache reuse. Inherit the resolved chat reasoning prefill and omit character reply/message prefills. Unfinished chat replies block preparation. Gallery creation uses standalone system/user templates and their own reasoning/message prefills. Image editing always uses standalone preparation, even when its result returns to chat.

All interjected chat instructions use one `[System Note]` marker via shared `systemNote`: tool/media prompts, reply/image revisions, revision bridge, draft completion, titles and speaker handoffs. It normalizes obsolete task headings without stacking markers and leaves optional empty notes disabled. Standalone gallery/avatar templates and replayed original assistant prompts are not steering turns. Prompt text and uploaded images are separate inputs: endpoint requests use only the explicit text templates and reference-prompt macros; actual image files are uploaded to Comfy.

**Reference prompt capture.** Clients submit slot/asset IDs, never authoritative source prompt text. `parseInputs` captures `gallery_items.prompt` for gallery assets, otherwise the asset's recipe prompt, or empty text. Unchanged slot/asset selections retain their captured text; changed selections capture anew. `MediaJobInputSnapshot.prompt` and recipe `inputs_json` preserve it across edits, reruns, source deletion and image transfer. Supported macros are `first_frame_prompt` and `reference1_prompt`–`reference3_prompt`, exposed only where the operation has those slots. Empty/unused inputs expand to empty text. `expandTemplate` resolves nested `{{#if key}}` blocks before one-pass substitution; inserted source prompts stay literal and keep whitespace. Do not restore the removed aggregate `{{references}}` macro.

**Streaming feedback.** `PromptGenerationStatus.tsx` supplies a spinner and bounded scrolling reasoning preview. `streamEndpointCompletion` first emits the reasoning prefill actually sent, then accepts `reasoning_content` or `reasoning` separately from content. Prefill-disabled endpoints omit that text in both places. Avatar SSE uses `{r}` and `{d}`; media jobs keep reasoning in `mediaLive` and include it in reconnect DTOs/progress. In tools, reasoning replaces the Final prompt field until the first content delta. The spinner belongs beside the field header. Completion/cancellation discards transient reasoning; it never enters durable media prompts, recipes, exports or Comfy inputs. Foreground chat keeps its existing reasoning persistence. Prompt streams have a 120-second inactivity watchdog renewed by every incoming chunk, not a total lifetime limit.

**Existing image rendering.** `comfy.ts` and `mediaImageAdapter.ts` route all renders through the same worker and recipes. `messages.render_recipe_id` retains configuration before the first output and after the last image is removed; an existing alternative uses its asset's recipe. Forward image swipes call `startMessageImageRender` with normal branch/revision/pending guards and append the result to the same message. `messageRenderOnly` preserves its text/status while updating progress/errors. Videos rerun through the tool page. Do not reintroduce `image_render_json` or separate gallery rendering/revision state.

### Jobs, drafts and recovery

`consumeTemporaryMediaJob` shares observer registration, terminal-state waiting and abort cleanup for avatars and image description. It retains ownership through asynchronous result consumption, then releases in `finally`; active remote cancellation remains worker-owned until execution stops. Do not return manual result leases from the avatar byte path.

`/api/media/jobs` captures workflow, inputs, prompt context and endpoint parameters in SQLite. Endpoint credentials are not stored in captured job JSON; preparation resolves the current key only if the captured endpoint still exists at the same base URL. `requestKey` makes repeated draft creation idempotent. Mutations require `expectedRevision`; draft selection/accept/discard also require `expectedDraftRevision`. Route validation, branch guards and mutation stay synchronous.

A tool draft groups variations in `media_drafts`. Each variation retains its instruction, final prompt, workflow controls and ordered inputs. Rendering/preparation does not attach a message or gallery row. Selection is persisted independently of the working editor; switching variations only changes the displayed result and its read-only saved text. Saving one requires no active variation, applies the current chat branch/revision guard if needed, and atomically attaches the chosen result while retaining all variations. Finish/discard releases job ownership; saved results retain their destination owners. Unstarted drafts are discarded on close; starting prompt preparation or rendering makes them persistent. The automatic discard check inspects all variations, so another client starting work cannot lose it. Explicit discard cancels active work before releasing its inputs.

The worker moves jobs through preparation, submission, reconciliation, queue/rendering and download. At most four asynchronous I/O steps run together, at most two of them prompt preparations; a job waiting between Comfy polls occupies no worker slot. Only unchanged lifecycle states honor poll/retry delay. Render/cancel actions and preparation→submission proceed immediately. Prompt/reasoning buffers stay in RAM; persist final/partial prompt text once on completion or interruption. `mediaPromptBuffers` overlays chat snapshots during preparation.

Connect the preview WebSocket in parallel with reference uploads and before POSTing the workflow; a bounded connection failure is nonfatal. Persist a caller-generated Comfy prompt ID before `/prompt`. Once submission acceptance is uncertain, reconcile only that ID through queue/history; never blindly resubmit. Execution-start frames can advance the row before POST/queue responses return; stale responses must not downgrade rendering to queued. A remote ledger ID is the stable ingestion key for download retries and partial multi-output recovery.

`jobTimeoutSeconds: 0` means no overall Comfy deadline. A configured cap starts after preparation when rendering begins, independently of network request timeouts. Cancel aborts local work and calls `POST /api/jobs/:id/cancel`; confirm execution has stopped before releasing its inputs. Uncertain submission/cancellation remains under reconciliation. A failed retrieval retains remote results for 24 hours and can retry without rerendering.

Successful automatic attachments delete their job records after the attachment transaction. Saving a review result adds its chat/gallery owner and leaves the draft open; `MediaDraft.savedAssetIds` derives saved results from destination ownership, making repeated saves idempotent and restart-safe. Finish uses draft discard to remove the jobs and unsaved results while destination owners preserve every saved result. Failed jobs remain for retry. Deletion is real database removal, not a filtered history view. Recipes and the remote cleanup ledger outlive visible jobs. Shutdown persists partial prompt text and detaches from submitted Comfy work. Startup repairs interrupted preparation, resumes submitted jobs, finishes discards and removes saved successes before sweeping unowned files.

### Local files and remote cleanup

`media_assets` gives each local file a stable ID; `media_owners` records message, gallery, job and recipe ownership. Canonical attachment paths still live in `messages.images_json` and `gallery_items.image`; triggers cover all SQL writers and cascading deletes. Results transfer ownership from job to message/gallery atomically. Copies own independent files; immutable recipes may be shared. Cleanup checks both asset and message recipe references, and `message_media_files` includes recipe inputs in deletion scopes.

Downloads stream into exclusive `.part` files, bounded to 64 MB raster or 1 GB video. Validate raster bytes and dimensions; video inspection verifies the WebM EBML type and AV1 codec through FFprobe. Reserve an asset ID before downloading, sync and exclusively publish `media-<assetId>.<ext>` before recording the result, then remove the temporary link; preserve original WebM bytes. Recording updates that reserved asset. Failed operations release reservations, and startup sweeps unfinished `.part` files and reservations left before file creation. Caddy serves signed `/images/` rasters, WebM and thumbnails with range support. Bun's direct media serving also supports ranges and streams with backpressure. FFmpeg is installed in both root Dockerfile stages used by Compose.

`media_remote_files` is a durable cleanup ledger independent of job history. Record planned uploads before sending, then record the returned locator and every observed history/WS output. Upload names are `tinytavern-<job>-asset-<id>.<ext>` in Comfy's input root, not per-job directories. Seeing a pre-existing input preview in Comfy output does not acquire ownership of that file. Never delete the user's sample inputs.

Delete releasable files using `DELETE /view` with filename/subfolder/type. Keep files with another active owner. Release successful remote outputs only after local storage is durable, and release inputs/discarded outputs only once execution no longer needs them. Cleanup runs with bounded concurrency/backoff, treats 404 as success, and survives visible job deletion. Cleanup errors must not hide a successful result. Startup removes local orphans left in crash windows.

### Gallery, references and character associations

Original media filenames use their existing numeric asset ID: `media-<assetId>.<ext>`, for generation, uploads, copies and imports. `reserveMediaFile` in `images.ts` allocates the SQLite ID and path together before file creation; synchronous saves/copies keep registration in one transaction. Asset thumbnails use `thumb-<assetId>-<revision>.jpg` and increment the revision on successful publication. Avatar originals remain `character-<id>.png` / `persona-<id>.png`, with numeric cache versions; their derivatives use `thumb-<kind>-<id>-<avatarVersion>-<revision>.jpg`. Startup sweeps remove unreferenced files and repair missing derivatives. Ownership and deletion come from database references. `galleryStore.ts` shares insertion of an existing asset into the gallery.

Gallery saves make independent copies of chat attachments. Upload accepts one raw PNG/JPEG/WebP per request (64 MB), validates bytes and assigns the selected character or Uploads label. Source conversation/message links are nullable navigation metadata; file ownership comes from `media_owners`.

Gallery details edits `gallery_items.prompt` and asset character associations with explicit Save/Discard. PATCH guards the prompt with `expectedPrompt` and associations with `expectedCharacterIds`; validate both before the transaction. Keep whitespace and allow clearing prompt text. Blur, close and tool launches do not save edits; disable launches while an explicit save is pending. Rerun uses the current saved prompt and the recipe's original instruction, workflow and controls. The original recipe prompt remains unchanged by gallery edits.

Character associations are many-to-many in `media_characters`, with indexes for asset and character lookup. Capture the union of reference associations and chat context before rendering; reruns also include the current source result's associations. Recipes persist captured IDs; copied assets get independent association rows. Character deletion removes associations without deleting media. `GalleryItem.characters` lists all IDs/names; `characterName` joins them, using the saved label only when none remain. Gallery queries supply `characters_json` to `toGalleryItem`. Each character filter includes a combined item once. Details uses `MediaCharacterPicker` and shows every associated character.

`GET /api/media/assets/:id/inputs` lazily returns ordered recipe slots with signed assets. Deleting a gallery source marks it unavailable, nulls recipe asset IDs and releases recipe/inactive-job pins. An active job may retain the actual file until it finishes; its result cannot resurrect that source reference. Keep the slot and captured prompt text so details can say “Deleted image” and rerun can request a replacement. This is deliberate deletion behavior, not permanent input retention. Gallery invalidation refreshes the visible source panel.

`GalleryModal`/`GalleryGrid` retain O(n) justified layout, binary-search row virtualization and focus/scroll anchors. Gallery picker mode filters to images and keeps ordered slot selection separate from bulk deletion. Tools belongs in the grid header; Jobs is available from both the grid and gallery details headers. `MediaToolsModal` is fullscreen, with a non-scrolling preview stage and compact variation/actions footer. Jobs appears only in the page header. Gallery and generation share a fixed 450px desktop sidebar width (full width in the mobile layout), with prompt editors growing into spare desktop height until the user grabs the native resize grip; gallery source images use compact thumbnail rows and Save/Discard appear only for changed details. Media controls use a compact scrolling form with a separate persistent progress/action footer, smaller desktop controls and reference thumbnails, and resizable instruction/prompt editors; mobile retains its normal control sizing and page scrolling. Every originating pane stays mounted but inactive under child panes and pickers. Fullscreen pages pin directly to their fixed backdrop edges instead of centering a viewport-unit-sized modal; backdrops contain layout; the covered root chat/sidebar skip rendering via content-visibility and chat scroll-follow avoids layout reads until uncovered. Render progress uses compact adjacent node/step bars and an inline saved count. Gallery and macro textarea resize observers apply measurements directly, without another animation-frame delay; gallery ignores stage-height changes from its own layout and batches geometry reads before reactive writes. Reduced-motion CSS uses zero transition duration: a nonzero universal duration accidentally enables transitions on every property, repeatedly restarting layout transitions during continuous resizing. Composer has Create image from chat and Create video from chat; Edit image opens standalone, including image actions from chat. Image actions prefill Reference 1, first frame, or video reference. Message/code-block menus share `MediaPromptMenuItems` and copy exact text into Final prompt with chat as the destination. Global jobs and open variations refresh on reconnect without overwriting unsaved edits. Result selection only changes the preview; it never loads a previous variation into the working instruction/prompt. A Result details button beside Download under the preview opens the selected variation’s captured workflow name, seed and effective exposed parameters, followed by its saved instruction/prompt with explicit Copy/Use in editor actions, in a separate read-only dialog; it does not add another editor to the generation sidebar. Gallery exposes the same dialog through the read-only asset details API, using original recipe text independently of gallery annotations. Result ingestion preserves the seed in recipe configuration so it survives job cleanup; older recipes recover it from a retained job where possible. Saving stays in the tool; Finish clears the remaining draft work and keeps saved chat/gallery media. Jobs use compact cards (`MediaJobList`/`MediaJobCard`) with chat/character context, ordered input thumbnails, bounded prompt/reasoning excerpts and visible-only live video previews through one shared intersection observer. Draft groups show an active variation before newer idle ones. Locked workflow controls read the running job’s captured graph and values, independently of local edits or changed workflow defaults.

### Video previews and thumbnails

`ComfyGraphProgress` uses workflow titles/class names for the current node. Cached nodes and `progress_state` supply completed-node counts against the submitted graph; dynamic children map to display parents without completing them early. Steps reset on node changes. These counts describe graph completion, not elapsed time. First progress/preview is immediate; subsequent broadcasts coalesce at 50 ms without periodic DB writes.

All submissions request `extra_data.preview_method: 'taesd'`. For videos, set `VHS_latentpreview` with the model's default rate. Disable `VHS_MetadataImage` and `VHS_KeepIntermediate` in `extra_data.extra_pnginfo.workflow.extra` to avoid the metadata PNG sidecar and retained intermediates.

VHS broadcasts `{id,length,rate}` metadata. Accept it only for the running job's current `executing.display_node`. Binary frames contain three big-endian uint32 values of 1, a uint32 frame index, a 16-byte Pascal node ID, then JPEG bytes. `ComfyVideoPreview` keeps a bounded 16 MiB encoded cache; events send changed indices and eviction markers, while job snapshots include the retained cache. `VideoPreview.tsx` decodes JPEGs once at their original resolution, caches/replaces bitmaps and loops a canvas at the supplied rate. Do not resize these previews. Hidden/inactive views pause; unmount releases bitmaps.

Gallery tiles use JPEG thumbnails and only mount video playback after 500 ms of hover, muted and looping. Leave, scroll, hide or deactivate cancels pending playback and releases sources. Video tree-map cards use thumbnails. Chat, gallery detail and completed-tool players use the original WebM with `preload="auto"` and no thumbnail poster. The media wrapper reserves the exact aspect ratio before playback. Details/completed tools autoplay with sound and loop, subject to browser autoplay policy. `VideoFullscreenButton` operates on the existing player and shows its resolution; preserve playhead/sound rather than mounting a replacement. Inactive/unmounted players release their source and offer download if decoding is unsupported.

`Settings.galleryThumbnailSize` (General → Thumbnails, default 512 px, range 64–2048) rebuilds asset thumbnails. Two shared FFmpeg workers create JPEGs without upscaling, waking on asset/entity/settings changes and retrying failures after a minute. Keep old derivatives until replacements are ready. Abort stale work and wait for FFmpeg exit before deleting temporary files. Thumbnail revisions plus batched `mediaThumbnails` events prevent stale snapshots from restoring old URLs. Asset deletion removes its thumbnail; startup repairs missing thumbnails and removes orphan derivatives/obsolete posters.

Avatar originals remain in `/avatars`; `avatar_thumbnails` maps their versioned URLs to 128 px previews. Character/persona DTOs expose both `avatar` and `avatarThumbnail`. Replacements/deletions reconcile the queue; card export and avatar editing use the original.

### Image description and avatars

Describe image is a temporary worker job with one `source` image and text output. Users configure a Generate Text/Preview as Text workflow under Media rendering; no endpoint prompt preparation runs. Exactly one history output must contain one nonempty string in its `text` array. The result becomes the temporary job prompt, then gallery SSE fills the unsaved editor. It must not create a media result asset or write `gallery_items.prompt`. Node/token progress is transient. Cancel, disconnect or closing details stops the job; uploads stay ledger-owned until execution stops and cleanup succeeds. Text jobs are excluded from the image/video tool history UI and image recipe transfer.

Avatar preparation uses the active preset's paired prompt/context templates and entity macros. For characters, `{{description}}` means personality. Avatar rendering uses the shared worker through `mediaImageAdapter.ts`, with an SSE observer for progress/previews. Temporary ownership lasts until the response buffer is ready or the caller cancels. Entity avatar data changes only on Save through the PNG-enforcing PUT route. Abandoned temporary jobs are cleaned on completion/startup. Avatar prompt settings show macro help for both instruction and context.

### Media transfer and database changes

Conversation JSON remains version 1. Export raster attachments and recursively reachable image recipes/references; omit video files while retaining their messages/prompts and remapping the selected remaining image. Recipes include instruction, prompt, workflow snapshot, controls and ordered input prompt snapshots, without connection settings, credentials or jobs. Character associations export names and import through unique name matches. Export message recipe roots even when their last output was removed.

Validate the entire tree, raster bytes, recipe bindings, reachability and acyclic references before import writes. Remap message/asset/recipe IDs in one transaction; rollback removes every written raster. Repeated attachments get independent copies, while recipe inputs share pins. Imported recipes use the destination Comfy connection even when their workflow is not saved in settings. Older image JSON without recipes remains supported as an import format, not a second rendering path.

The complete current schema is `server/src/schema.ts`. Version 68 is the minimum supported database schema; older schemas are rejected at startup. Media jobs, drafts and recipes use independent numeric IDs with explicit references. Only Comfy submission IDs require UUIDs. New databases create the current schema and defaults directly; existing supported databases skip initialization. The `migrate(...)` entry point in `db.ts` is reserved for future changes starting at 69. Keep the baseline at 68, update the fresh schema alongside each new migration, and never replay seeds on existing data. See `docs/database-schema.md` for persisted JSON, file references and ownership records to consider. Runtime restart recovery and documented transfer formats remain active contracts.

### Chat assistance and remaining server behavior

`completionStream.ts` shares callback-based OpenAI delta decoding and a timestamp inactivity watchdog. Incoming chunks update activity without allocating timers; foreground chat and standalone tools retain their own completion, prefix, retry and persistence policies. Draft completion appends its instruction through `appendChatMessage` to the already-normalized `buildChatMessages` result, preserving that upstream prefix.

**Assistant is a seeded character**. New conversations have `auto_title_pending = 1` and initially display the character name if there is a greeting, otherwise "New chat". After the first real user message receives a completed assistant reply, `maybeAutoTitle` sends the complete branch (including greetings and template prologue) through `buildToolPrompt` with the configured `[System Note]` title instruction as a trailing user turn and the resolved reasoning prefill. It never clips the history or builds a standalone excerpt. Manual renames clear pending even when the text matches the initial title; conditional writes preserve renames made while the title request is running. An in-memory set prevents concurrent title requests; success or failure clears pending without changing `updated_at`. Copies/imports retain their titles.

**Assistance prompt settings**: Settings → General owns `titlePrompt` (a trailing steering instruction after the complete conversation branch, using the same prompt assembly as chat tools) and `draftCompletionPrompt` (`{{draft}}`, appended after the unchanged chat prefix). Draft completion requests the full message beginning with an exact copy of the draft; the server validates that prefix incrementally and sends only the new continuation. Changed or incomplete prefixes fail without modifying the original draft. Both assistance tasks inherit the resolved chat template’s macro-expanded reasoning prefill (including character overrides), honoring endpoint prefill support; visible-message and speaker-name prefills are excluded. Their default instructions begin with `[System Note]`. The selected Template and character inline overrides own `steerTemplate` and `speakerHandoffTemplate` (`{{speaker}}`, used with name prefixes when endpoint prefills are disabled). Chat image prompts → Chat image revision owns the context bridge, original assistant-message wrapper, and final revision instruction. Request builders use saved settings/templates and never replace them with built-in instructions. Optional empty bridge/handoff fields omit the message, while an empty steer template rejects regeneration with an instruction. Avatar requests require the selected preset's explicit context.

**Steered regeneration** (`POST /api/messages/:id/regenerate`): the prompt is snapshotted at route time via `promptOverride`, and the one-off revision request never enters message history. Assistant results remain assistant sibling swipes: the original reply is included and followed by an alternating-safe user turn rendered through the conversation's resolved `steerTemplate` (`resolveSteerTemplate`: character inline `customTemplate` → character `templateId` → global default template; `{{instruction}}` slot). Image tool results are appended as child tool messages after the source (image alternatives remain the special within-message image swipes), retain their render config, and automatically render a fresh image. `buildSteeredToolPrompt` preserves the unchanged roleplay history as the upstream prefix (for prefix caching and contextual references), then appends the original image prompt as an assistant turn and the global Images revision instruction as a user turn. The default `[System Note]` steering instruction marks history as reference-only and separately tags `<original_image_prompt>` and `<revision_instruction>` so the model does not continue the roleplay.

**`updated_at` means "last new content"**: content-creating routes (send, spawn, resume, edits, deletes) call `touchConversation`; `setActiveLeaf` deliberately does NOT bump it, so branch switching and swiping between already-seen siblings never reorder the sidebar. Swiping onto a not-yet-seen speculative sibling does bump — revealing it is the moment that content "arrives", same as a foreground regeneration.

**Search**: message contents are indexed in an external-content FTS5 table (`messages_fts`, kept in sync by insert/update/delete triggers on `messages` — any SQL write path is covered automatically). The search route quotes user tokens as FTS phrases (last token prefix-matched) and generates snippets; note `snippet()` refuses aggregate contexts and SQLite flattens subqueries, so best-per-conversation dedupe happens in JS. Titles use escaped-LIKE substring search. Entity list endpoints sort by name (`COLLATE NOCASE`).

**Speculative swipes** (`server/src/speculation.ts`): when `backgroundSwipeGeneration` is on, the server keeps one unread assistant sibling ahead of the active leaf (`generationKind: 'speculative'`), only while the conversation has a connected viewer and its character has not opted out via `disableBackgroundSwipeGeneration`. By default preparation waits for the primary reply to finish; `parallelBackgroundSwipeGeneration` allows the active streaming reply and its one speculative sibling to overlap (at most two streams, still only one unread alternative). Swiping to the prepared reply stops the outgoing primary, promotes the prepared reply, and refills under the same limit. Stopping/failing the primary, leaving the last subscription, or changing branches cancels in-flight background work and retries. Context changes discard prepared swipes; refill retries use backoff capped at 8 attempts, with explicit user actions resetting the budget.

**Access control**: Caddy applies the configured source-IP allowlist to the entire application; every Bun HTTP request and WebSocket upgrade is first gated by source IP (`server/src/ipAccess.ts`, using the client IP forwarded by the trusted Caddy service). Configured via `TINYTAVERN_IP_ALLOWLIST` in a gitignored `.env`; the Compose files default to an empty value, which allows all addresses. Docker-internal traffic (e.g. the manual mock) needs `172.16.0.0/12`. An optional password under Settings > General adds a second server-side gate (`server/src/auth.ts`): API routes and WebSocket upgrades require an opaque HTTP-only session cookie. Caddy media routes use expiring signed URLs issued through authenticated DTOs. Session token hashes/expiry live in SQLite so cookies survive server restarts; raw tokens exist only in cookies. Only the static login shell and exact `/api/auth/{status,login,logout}` endpoints are public behind the IP/origin checks; password changes revoke all persisted sessions and connected sockets.

**Mock LLM** (`tests/mocks/server.ts`): OpenAI-compatible streaming endpoint at `http://mock:9800/v1` (from inside the compose network) with `/control/*` endpoints to inject failures; available for manual isolated demonstrations. Automated tests own their focused upstream fixtures.
