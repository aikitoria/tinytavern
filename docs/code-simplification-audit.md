Investigation of TinyTavern at commit `d4ae110`, 2026-09-08.

Implementation checklist (completed 2026-09-09 after implementation and validation):

- [x] 1. Separate Jobs component and route; retain navigation and old URLs.
- [x] 2. Share settings submission lifecycle and preserve edits during saves.
- [x] 3. Reuse compiled workflows and consolidate snapshot resolution.
- [x] 4. Share upstream delta decoding and timestamp inactivity watchdog.
- [x] 5. Use one ordered live attachment representation; retain transfer compatibility.
- [x] 6. Remove superseded Node/Vite TLS and SPA modes; retain isolated media serving.
- [x] 7. Consolidate speculation orchestration and remove startup callback coupling.
- [x] 8. Share temporary-job waiting, result consumption and cleanup.
- [x] 9. Share named-collection toolbar and naming behavior.
- [x] 10a. Adopt existing stream-scroll helper in remaining components.
- [x] 10b. Remove dead character settings navigation state.
- [x] 10c. Remove redundant draft-completion history normalization.
- [x] 10d. Share entity write SQL/field evaluation with bulk transfer.
- [x] 10e. Share gallery insertion from an existing asset.
- [x] 10f. Use reference thumbnails and share input-slot labels.
- [x] 11. Use numeric asset IDs in media filenames and migrate existing names at startup, preserving references and ownership.
- [x] Review historical `galleryOutput` / accepted-draft compatibility and retain or migrate deliberately.
- [x] Review integrated changes, update architecture documentation, format, typecheck, build, and run standalone plus isolated HTTP regressions.

The code has accumulated redundant implementations and transitional representations. The best opportunities are localized: remove work from the wrong component, finish using existing abstractions, and retire superseded runtime modes. The architecture does not warrant a wholesale rewrite.

The original investigation below was a static review across client settings, media UI, server media, server core, navigation, and deployment configuration, with four parallel reviewers. Findings below were checked against implementations, production call sites, repository instructions, and relevant tests. During that investigation, no application code, live services, or user data were changed. Tests and benchmarks were not run; performance effects describe identifiable work removed, not measured speedups. “Unused” refers to repository call sites and documented deployments, not telemetry from installations.

1. **Give Jobs its own component and route kind. High priority; concrete unnecessary work.**

   `openMediaJobs()` opens an image tool session with `showJobs: true` ([navigation.ts](../client/src/media/navigation.ts), line 75). The route parser fabricates the same operation and context ([pageLocation.ts](../client/src/state/pageLocation.ts), line 61). Consequently, every Jobs pane constructs the full editor's draft, asset store, reference state, baseline, workflow and prompt computations before choosing the Jobs JSX branch.

   In [MediaToolsModal.tsx](../client/src/media/MediaToolsModal.tsx), editor initialization starts at line 115, workflow filtering at 233, workflow compilation at 261, and control validation at 272. An effect at 283 also subscribes to the compiled controls independently of which JSX branch is visible. The UI branches only at line 793. With a configured image workflow, merely opening Jobs compiles that graph.

   Create a dedicated Jobs pane using the existing `MediaJobList`, pagination and open/remove actions. Remove `showJobs` from the editor session and model Jobs directly in navigation. Keep retained parent editors and Back/Forward behavior. This removes initialization and reactive dependencies as well as numerous editor-versus-Jobs conditions. It does not currently create an empty server job; the waste is client editor state and computation.

   Validate Jobs opened from gallery and an unsaved editor, pagination, reconnect, and Back/Forward retention. Existing coverage: `dialog-stack`, `page-location`, `media-job-cards`; add a focused mounted-component check that Jobs does not compile editor workflows.

2. **Share settings submission lifecycle. High priority; duplication has caused behavioral divergence.**

   Three implementations own revision tracking, dirty baselines, save/discard, errors, saved indicators and navigation guards: [mediaSettingsDraft.tsx](../client/src/components/tabs/mediaSettingsDraft.tsx), line 16; [GeneralTab.tsx](../client/src/components/tabs/GeneralTab.tsx), line 27; and [imageGeneration.tsx](../client/src/images/imageGeneration.tsx), line 537.

   The media controller blocks overlapping saves and returns success only if the current draft matches the submitted snapshot. General leaves Save enabled, awaits persistence, then clears all overrides and password edits at lines 58–62. Edits entered during that request can therefore be cleared without being saved. Image settings also lack submission locking and return true after saving an earlier snapshot even if the draft changed meanwhile. These are code-path observations, not browser reproductions.

   Extract a small settings submission controller for locking, submitted-snapshot tracking, revision advancement, errors and guard integration. Keep each page's field storage, validation, password handling and transfer adapters local. Preserve edits made after submission and make the navigation result reflect remaining dirty state. A universal form framework would add unnecessary scope.

   Validate delayed saves with intervening edits, overlapping clicks, 409 responses and Save/Discard/Cancel navigation. The current media controller is useful precedent, not a complete drop-in replacement for the other field models.

3. **Reuse compiled workflow snapshots. High priority; repeated synchronous parsing and graph traversal.**

   [mediaJobs.ts](../server/src/mediaJobs.ts), line 127, resolves and validates a workflow through `mediaWorkflowError`, which compiles it. `startMediaJob` compiles it again for control validation at line 588. [mediaWorker.ts](../server/src/mediaWorker.ts) separately compiles the captured graph for progress at line 215 and submission at line 465. Default/snapshot resolution is also repeated in `workflowForJob`, `draftConfiguration` and `startMediaJob`.

   [compileMediaWorkflow](../shared/src/media.ts), line 307, scans the source, parses JSON and traverses the graph to validate keys, bind loaders and discover controls. The current API encourages callers to discard this work and repeat it. Workflow JSON can be large, and route-time compilation occupies the server's single thread.

   Have workflow resolution return its validated configuration and compiled representation. Reuse that immutable representation for controls, progress and expansion. If reuse crosses jobs, bound the cache by retained size and key it by actual graph source, with operation/reference validation retained separately; a workflow ID alone is insufficient because workflows are editable. Expansion must continue producing a fresh graph per job. Restart can rebuild derived state from persisted snapshots.

   Validate workflow edits under the same ID, captured reruns after defaults change, exposed controls, concurrent jobs and restart. Relevant suites: `media-workflow`, `workflow-inputs`, `media-workflow-defaults`, `media-restart`, `media-latency`.

4. **Share upstream stream mechanics and the efficient inactivity watchdog. High priority; unnecessary work on the streaming path.**

   [generation.ts](../server/src/generation.ts) has two inactivity watchdogs: standalone completion at line 378 updates an activity timestamp, while foreground chat at line 548 clears and allocates a timeout on every raw response chunk. Both use the same inactivity limit. The two paths also decode OpenAI delta JSON independently, around lines 419 and 635, with different runtime type checking and handling of finish/refusal fields.

   Extract a small timestamp-based watchdog and callback-based delta decoder. Reuse the existing callback SSE frame reader. Keep foreground name-prefix stripping, retries, persistence and cancellation identity checks in their caller; keep standalone completeness/refusal policy in its caller. There is no need for a universal generation lifecycle or an additional buffered event pipeline.

   This removes per-chunk timer churn and duplicated protocol parsing policy. Its latency/GC impact is unmeasured. Preserve idle error classification used by retry logic, raw-chunk activity updates, reasoning variants, partial-prefix flushing and completion semantics. Existing suites include `sse`, `server-completion`, `generation-persistence`, `prompt-reasoning`, and isolated E2E retries/generation failures.

5. **Use one live attachment representation. Medium priority; substantial cleanup with a wider contract change.**

   [Message](../shared/src/index.ts), line 49, contains both `images: string[]` and optional `media: MediaAsset[]`; the comment explicitly calls the former a compatibility view. [toMessage](../server/src/db.ts), line 1513, always constructs both. Attachment triggers create corresponding asset rows even for old-format imports ([mediaSchema.ts](../server/src/mediaSchema.ts), line 98).

   Client code selects a URL from `images`, then searches `media` for that URL ([imageGeneration.tsx](../client/src/images/imageGeneration.tsx), lines 802 and 903). Server recipe selection repeats the pattern. Public serialization maps and signs both arrays ([mediaUrls.ts](../server/src/mediaUrls.ts), line 45). Signing is cached: the duplication is traversal, URL storage and wire data, not necessarily two HMAC computations.

   Make the live contract use one required, ordered asset array and a selected index. Keep `images_json` storage and version-1 conversation import/export as boundary adapters; a storage migration is not a prerequisite. Explicitly preserve slot/index behavior for missing asset records. The current `flatMap` can shorten `media`, so replacing URL lookup with direct indexing without resolving that case would be unsafe.

   Validate image/video alternatives, deletion, copying, signed URLs, recipe selection, tree snapshots/patches and old JSON imports. This is best done as a coordinated contract refactor after smaller changes.

6. **Retire unused direct-serving deployment modes. Medium priority; the clearest superseded generality.**

   [server/src/index.ts](../server/src/index.ts), line 238, still implements native TLS, certificate watching, first-byte protocol sniffing and same-port HTTP redirects. Line 219 supports serving a compiled SPA through `CLIENT_DIST`. [client/vite.config.ts](../client/vite.config.ts) carries a parallel direct-TLS/proxy mode.

   Neither documented Compose stack supplies the Node TLS or SPA variables; Caddy owns public TLS and production static files. The production Node image does not contain the compiled client. Development always sets `CADDY_FRONTEND=1`. These alternate deployment modes expand the maintenance surface without serving the documented installation paths.

   Remove the obsolete Node TLS/SPA modes and simplify Vite around the supported Caddy setup. Treat Node media serving separately: isolated E2E tests actively use its image/avatar endpoints, including authentication checks (`tests/e2e/auth.ts`, lines 53–55 and 121). Preserve that test dependency explicitly, or replace it with isolated Caddy integration coverage before removing it. Do not delete the entire non-Caddy branch indiscriminately. No deployment is needed for this investigation.

7. **Put speculative generation orchestration in the existing speculation module. Medium priority; artificial module coupling.**

   Retry and cleanup state lives in [speculation.ts](../server/src/speculation.ts), line 9, but `cancelBackgroundSwipe`, `prepareNextSwipe` and `prepareActiveSwipe` live in [routes/conversations.ts](../server/src/routes/conversations.ts), line 80. A nullable mutable callback connects the halves; its only implementation is installed in [index.ts](../server/src/index.ts), line 316.

   Move the orchestration into `speculation.ts`, make refill local and move the small conversation lookup out of the side-effect-registering route module as needed. Routes and startup should consume the same owner of speculative behavior. Preserve microtask timing, subscription checks, retry limits, promotion and allowed overlap. This improves dependency structure; it is not a reason to simplify the actual concurrency rules. Validate the existing speculation lifecycle and parallel-speculation E2E scenarios.

8. **Fold temporary-job waiting and result consumption. Medium priority; duplicated resource lifecycle.**

   [mediaImageAdapter.ts](../server/src/mediaImageAdapter.ts), line 94, and [mediaDescription.ts](../server/src/mediaDescription.ts), line 58, independently implement observer registration, terminal-state resolution, abort/cancel, worker wakeup and cleanup. Their initial abort checks already differ.

   `renderImageAsset` has only one caller, `renderImageBuffer`; its production consumer is avatar rendering through the alias in `comfy.ts`. That consumer needs bytes and releases the result immediately afterward. A common temporary-job helper can wait, consume the result while ownership is held, and release in `finally`, with per-caller progress/result callbacks. This also lets the asset-lease wrapper disappear if no caller needs it independently.

   Keep ownership until the raster read completes and keep deferred cleanup when cancellation has not yet stopped execution. Validate abort before registration, disconnect during execution, failure, successful byte/text consumption and restart. Relevant suites: `media-description`, `media-ownership`, `media-restart`, plus avatar E2E.

9. **Extract the repeated named-collection toolbar. Medium priority; UI consistency and maintenance.**

   Prompt, workflow and older image-preset editors independently implement the selector, New/Duplicate/Rename/Delete, deferred rename focus and collision-free naming: [MediaPromptsTab.tsx](../client/src/components/tabs/MediaPromptsTab.tsx), line 89; [MediaRenderingTab.tsx](../client/src/components/tabs/MediaRenderingTab.tsx), line 55; [imageGeneration.tsx](../client/src/images/imageGeneration.tsx), line 382. Their copy naming and Enter-to-finish behavior have drifted.

   Share the toolbar/inline-name component and unique-name helper. Keep collection mutations and default/deletion rules in the callers: old image presets use names/indexes while newer records use IDs. The benefit is consistent behavior and fewer places to change controls, with little expected latency impact. Do not turn this into a configurable CRUD framework.

10. **Finish adopting existing helpers and delete small dead paths. Low-risk follow-up work.**

    - Stream following is implemented in [PromptGenerationStatus.tsx](../client/src/components/PromptGenerationStatus.tsx), line 12, and [MediaJobCard.tsx](../client/src/media/MediaJobCard.tsx), line 78, despite the tested [createStreamScroll](../client/src/streamScroll.ts) already serving the tool editor. Reuse it with appropriate stream identity and visibility. The card currently does not recheck visibility in its queued frame. Keep chat scrolling separate: it has different layout/input semantics.
    - `settingsCharacterId` has no non-null writer: it is initialized/reset in `store.ts` and still read by `CharactersTab.tsx` at lines 49 and 94. Direct character navigation now uses routed `settingsEntity`/`settingsDetail`. Delete the obsolete field and mount branch.
    - `buildDraftCompletionMessages` re-normalizes an entire history at [draftCompletionPrompt.ts](../server/src/draftCompletionPrompt.ts), line 43, although its only production caller passes `buildChatMessages` output. Append the instruction using the existing `appendChatMessage` rules and preserve that assembled prefix. Adjust synthetic unnormalized-input tests to exercise the real boundary; preserve `DraftSuffixFilter` and final revision checks.
    - Bulk entity import calls `cfg.toDto(current)` once per field and reconstructs insert/update SQL in its loop ([entityTransfer.ts](../server/src/routes/entityTransfer.ts), lines 111 and 118). Convert once per record and reuse the writer/SQL already described by the CRUD field specification. Keep bulk validation, transaction and avatar rollback local.
    - Gallery insertion from an existing asset repeats in `mediaJobResults.ts` and `mediaDrafts.ts`, with related field mappings in the upload/copy routes. A concrete asset-to-gallery insert helper is enough; acceptance and automatic completion remain distinct operations.
    - The compact reference row loads an original image ([MediaToolsModal.tsx](../client/src/media/MediaToolsModal.tsx), line 1002), while job cards and source rows prefer thumbnails. Use the available thumbnail with original fallback. Reuse the duplicated input-slot label table too; a new component is only useful if it also removes meaningful repeated markup.

Some apparent excess should remain. The durable worker's submission reconciliation and remote ledger address ambiguous acceptance, process failure and file ownership. Independent cleanup prevents a successful result from being hidden by remote deletion errors. Dialog-frame retention and guards preserve unsaved work; WebSocket identity checks and resume replacement address suspended browser connections. Gallery virtualization, viewport-sized tree edges, shared visibility observation and bounded preview caches have concrete resource costs to control. The existing entity editor/route abstractions and imperative Select/MacroTextarea contract have real callers.

Historical compatibility requires a separate decision from dead code. `galleryOutput` has no current producer, but persisted job snapshots might carry its label; preserve that label through migration before removing its fallback. The `accepted` draft state has an explicit startup-cleanup regression for historical records. Old conversation JSON and shared URLs are documented inputs. No runtime telemetry was gathered, so rarely encountered safeguards have not been classified as unnecessary merely because current UI flows do not normally produce them.

Recommended implementation order: settings save correctness and Jobs separation first; workflow reuse and stream mechanics next; existing-helper adoption and dead-state removal alongside those changes. Then address deployment remnants, speculation ownership and temporary-job consumption. The live attachment contract is the broadest change and deserves its own review. Run focused regressions for each change, followed by the repository's typecheck, standalone suite and fully isolated HTTP E2E suite. Keep all live stacks untouched.

Implementation outcome, 2026-09-08:

All checklist items are implemented. Jobs now has a separate routed component; settings pages share submission and navigation handling that retains intervening edits and handles invalidations overtaking save responses. Workflow compilation uses an exact-source cache bounded by entry count and source size, while expansion still creates an independent graph. Stream decoding and inactivity tracking are shared without per-chunk timer allocation. The live attachment contract has one ordered asset array; database storage and version-1 transfers retain their boundary adapters. Speculation, temporary-job consumption, named-collection controls, entity writes and gallery insertion now have shared owners. The remaining small helper adoptions and dead-path removals are complete.

Original files now use `media-<assetId>.<ext>`; their ID is allocated in SQLite before writing. Thumbnail filenames use `thumb-<assetId>-<revision>.jpg`. Avatar filenames retain character/persona IDs, and their cache versions, temporary suffixes and thumbnail names are numeric too. Copies preserve supported source extensions, including legacy `.jpeg`. At the user’s request, migration 64 supersedes the initial UUID naming scheme and migrates existing files and avatar versions. It preserves asset IDs, attachment order, gallery source links, ownership and character associations. Hard links avoid copying media bytes; directory synchronization precedes the atomic reference transaction, and startup sweeping removes old names and abandoned links. Missing physical files retain their references. Historical `galleryOutput.characterName` labels and accepted-draft startup cleanup remain deliberately supported; replacing them would add migration machinery without removing meaningful complexity.

Validation: server/client typecheck, production client build, all 53 standalone regression suites, and all 557 assertions in the isolated HTTP E2E suite passed. Review also caught and fixed the settings invalidation/save-completion race, with browser Solid runtime coverage. The first integrated E2E run stopped at a timing-sensitive mid-stream speculation assertion while standalone tests were running; the full rerun without concurrent test load passed. The runner retained an open handle after reporting success, so its throwaway container was stopped explicitly. No performance benchmark or manual browser session was run. Vite retains its existing large-chunk advisory.

`CLAUDE.md` documents the resulting architecture. Live stacks were not deployed, manually restarted or used for tests. Migration 64 runs on application startup, including a development hot reload. Changes remain uncommitted.

Migration follow-up validation, 2026-09-09: schema upgrades from versions 1–62, the actual 61→62 startup, crash/rollback/collision recovery, stable attachment order and ownership, worker restart and thumbnail regressions all passed. Server/client typecheck and repository formatting passed. The full isolated HTTP suite passed all 557 assertions after migration registration; its wrapper exits only after awaiting the complete suite, avoiding the previously retained test-process handle.

Numeric filename follow-up, 2026-09-09: all 56 standalone suites passed, including upgrades from versions 1–64, numeric media/avatar migrations, collision and crash recovery, reservation cleanup, copies/imports, durable jobs and thumbnail refresh. One test fixture still assumed its old literal filename; it now checks the returned asset path. Full server/client typecheck, formatting, and all 557 isolated HTTP assertions passed. Media filenames no longer allocate UUIDs; original names use asset IDs, and derivative names use their owner ID and numeric revision.

Avatar thumbnail follow-up, 2026-09-09: runtime names now use `thumb-character-<id>-<avatarVersion>-<revision>.jpg` and `thumb-persona-<id>-<avatarVersion>-<revision>.jpg`. Migration 65 shortens existing prefixes with durable hard links, retaining source URLs and revisions. Startup cleanup recognizes both prefixes.
