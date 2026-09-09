# Agent guide

`AGENTS.md` links to this file. Keep it focused on constraints and commands; read implementation details from the code.
TinyTavern uses Bun, SQLite, SolidJS and Vite. Prioritize performance and low latency.

## Protect live sessions

- Everything runs in Docker. Never run Bun or Node on the host or install host dependencies.
- Dev: `docker-compose.dev.yml`, services `server`, `client`, `caddy-dev`, HTTPS port 5173, state `data-dev/`.
- Prod: `docker-compose.yml`, services `tinytavern`, `caddy-prod`, HTTPS port 5487, state `data/`.
- Never start, stop, restart or recreate either stack without an explicit deployment request. Source edits hot-reload in dev; no container action is needed.
- Never run tests or ad-hoc scripts against live services or their data. Never attach the mock profile to a live stack.
- Both stacks share a Compose project. Never use `--remove-orphans`; it can remove the other stack.
- Preserve ignored `.env` overrides, certificates and `.secrets/`. Never log or commit keys, or hard-code installation-specific networks in tracked files.
- Bare screenshot filenames refer to `/raid/share/`.

## Tools and checks

Use these disposable-container scripts; they have no host mounts, published ports or live credentials:

```sh
./scripts/run-in-container.sh install       # Update bun.lock after manifest changes
./scripts/run-in-container.sh check         # Typecheck server, client, shared, scripts and tests
./scripts/run-in-container.sh format:check
./scripts/run-in-container.sh format        # Copies formatted sources back
./scripts/run-in-container.sh build         # Copies client/dist back
./scripts/run-isolated-tests.sh             # Complete suite; no filters
```

Only install needs network access. Dependencies stay in containers. There is no lint or server build step.
Tests discover `tests/**/*.test.ts`, use isolated databases and run with up to eight workers. Keep the warm-image suite under 15 seconds.
Keep one direct regression per meaningful invariant; use feature tests for combinations and `tests/http/application.test.ts` for HTTP/WS boundaries. Prefer controlled events or mock clocks to sleeps.

## Deployment and maintenance

Only for a requested deployment or new installation:

```sh
./scripts/init-caddy.sh --media-dirs
# Production
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d --no-build tinytavern caddy-prod
# Development
docker compose -f docker-compose.dev.yml build server client caddy-dev
docker compose -f docker-compose.dev.yml up -d --no-build --force-recreate server client caddy-dev
```

Services run as UID/GID `1000:1000`. Certificates are `certs/cert.pem` and `certs/key.pem`.
Image builds do not deploy. Dependency changes require rebuilding and deploying dev services; mounted configuration/package replacements require recreation too. A requested dev deployment recreates the Vite client to clear cached transforms.
For Caddy-only deployment, build that service and use `up -d --no-deps --no-build caddy-dev` or `caddy-prod`. Reload certificates through `docker compose -f <compose-file> exec <caddy-service> tinytavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile`.
Only Caddy publishes ports. Bun serves internal HTTP/WS; Caddy serves signed media and the production client, and proxies Vite in dev. Preserve private proxy-header validation and source-IP/origin/session checks.
Compose creates the Comfy network. Optional `.env` values `TINYTAVERN_COMFY_NETWORK` and `TINYTAVERN_COMFY_NETWORK_EXTERNAL=true` select an existing network.
Database backup: `docker compose exec tinytavern bun server/src/db/backup.ts /data/backups/<unique-name>.db`. This uses an online SQLite snapshot; never copy an active database directly. A full backup also needs media and `.secrets/`.

## Architecture and invariants

- Server modules are grouped under `server/src/`: `db/`, `http/`, `realtime/`, `conversations/`, `generation/`, `media/` (with `comfy/` integration), `characters/` and `settings/`. HTTP endpoints live in `routes/`; reusable route helpers live in `routes/shared/`. Keep direct module imports and register routes in the root `index.ts`.
- Shared contracts start in `shared/src/index.ts`; media contracts are in `shared/src/media.ts`. Persistent state is server-authoritative; clients retain drafts and navigation only.
- All application SQL uses memoized `stmt()` in `server/src/db/db.ts`. Keep SQLite writes synchronous. An `await` between validation and mutation breaks guard-and-act atomicity; revalidate every precondition after unavoidable awaits.
- Schema lives in `server/src/db/schema.ts`. Minimum supported version is 68; current version is 69. Update both fresh schema and migrations, including persisted JSON, file references and ownership. Never replay seeds on existing data.
- New route modules must be imported for side effects by `server/src/index.ts`. Entity CRUD uses `defineEntityRoutes`/`createEntityWriter`; extend their field specs rather than duplicating handlers.
- Preserve conversation active-leaf/mutation-revision guards and settings/job/draft revision guards. Protected default prompts/templates remain read-only. Settings transfer excludes credentials and resolves references by name, never imported IDs.
- Use `deleteMessageSubtrees`/`deleteConversationRows` for deletion; direct recursive cascades fail on deep trees. Repair the active path inside the transaction. `setActiveLeaf` repoints every ancestor's active child without touching conversation recency.
- Block deletion splices children upward and removes sibling swipes; swipe deletion removes that sibling's subtree. Copies own independent media files. Read `server/src/conversations/tree.ts` before changing these operations.
- Streaming buffers stay in memory and persist at completion/cancellation/failure or graceful shutdown. Guard callbacks by generation identity because continuation reuses message IDs. Preserve speculative-generation limits and cancellation on context/subscription changes.
- `treePatch` includes all node structure but only changed message bodies; apply parent changes too. Ordered `Message.media` is the sole live attachment array. Sign outgoing media DTOs only, never DB/export paths.
- Client components are grouped under `client/src/components/`: `chat/`, `tree/`, `gallery/`, `layout/`, `settings/` (including `tabs/`), `forms/` and `ui/`. Media-specific components live in `client/src/media/`.
- Client editors use imperative ref `.value`/`.checked`; custom Select/MacroTextarea honor that contract. Reuse shared controls, `DropdownSurface`, settings submission and Save/Discard/Cancel guards.
- Routed panes stay mounted beneath child panes to retain edits and scroll. Preserve leave guards, socket identity checks, reconnect resync and authoritative swipe completion. See `state/dialogStack.ts`, `pageLocation.ts`, `uiBack.ts`, `ws.ts` and `store.ts`.

## Media

- Use the shared job pipeline for chat, gallery, avatars and description. The HTTP entry point is `server/src/routes/mediaJobs.ts`; pipeline modules live in `server/src/media/`: `mediaJobs.ts`, `mediaJobStore.ts`, `mediaDrafts.ts`, `mediaWorker.ts`, `mediaRecipes.ts`, `mediaFiles.ts`, `mediaRemote.ts`. UI lives in `client/src/media/` and `client/src/components/gallery/`.
- Users supply Comfy API-format workflows; do not seed or search for production workflows. Inspect installed nodes under `/raid/workspaces/comfy/ComfyUI`. Comfy must support `DELETE /view` and targeted `POST /api/jobs/:id/cancel`.
- Operations and slots come from `MEDIA_OPERATIONS`; image editing uses one to three references. Do not restore the removed first-and-last-frame video operation. Media workflows have exactly one output node; videos are original AV1 WebM. Description outputs text through its own validation.
- Binding and exposed controls live in `shared/src/workflowInputs.ts`. Use a Comfy primitive Text node for `{{prompt}}` to preserve braces during export. Reserved loader filenames are `source.png`, `first_frame.png`, and `reference1.png`–`reference3.png`; annotated `_meta.title` exposes controls. Preserve graph wiring and captured workflow snapshots.
- Capture prompts, input associations and workflows per job/recipe. Chat preparation, including images from references, preserves the complete chat prefix; gallery preparation uses standalone prompts. Selecting a variation changes only the preview, never the working editor. Save attaches results atomically; closing started drafts leaves work running.
- Persist Comfy submission IDs before sending. If acceptance is uncertain, reconcile that ID rather than resubmit. Confirm remote cancellation before releasing inputs. Downloads become durable before result registration or remote deletion; retry ingestion uses the remote ledger ID.
- `media_owners` determines file lifetime. Reserve IDs with `reserveMediaFile`; originals use `media-<assetId>.<ext>`. Recipes and cleanup ledgers outlive jobs. Never delete sample inputs or another owner's files. Cleanup failures must not hide successful results.
- Deleting source media releases inactive reference pins and preserves a missing input slot; active jobs may keep inputs until completion. Conversation JSON remains version 1, including raster recipes/references but omitting video files. Validate transfers fully before writes and remove files on rollback.
