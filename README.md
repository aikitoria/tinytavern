# TinyTavern

TinyTavern is a self-hosted chat interface for OpenAI-compatible language model
APIs, with characters, personas, prompt templates, branching conversations, and
ComfyUI image and video tools.
Use it on desktop or mobile, with chats synchronized across devices.

## Features

- Edit messages or generate alternative replies without losing the original
  conversation. Browse branches in a zoomable tree map.
- Create characters and personas, organize characters into folders, and import
  or export SillyTavern PNG cards.
- Customize prompts and templates with macros, speaker names, steering
  instructions, and reasoning or message prefills.
- Connect multiple API endpoints with separate models and sampling settings.
  Choose a default endpoint or override it per conversation.
- Stream replies and reasoning, inspect the prompt sent to the model, continue
  replies, or ask the model to complete your draft.
- Generate the next alternative reply in the background so it is ready to swipe to.
- Search messages and titles. Duplicate conversations or export them with their
  branches and images. JSON exports omit video files but retain their messages and prompts.
- Create and edit images, generate short videos, and create avatars through ComfyUI.
  Choose reference images from the gallery and keep rendering in the background.
  Save results with their prompts and recipes for later reruns.

## Install

You need Docker with Compose, a TLS certificate, and an OpenAI-compatible API.
The containers run as UID/GID `1000:1000`; run the setup commands as that user,
or adjust the user and file ownership for your installation.

1. Place your certificate at `certs/cert.pem` and its private key at
   `certs/key.pem`.
2. Prepare the directories and start TinyTavern:

   ```sh
   ./scripts/init-caddy.sh --media-dirs
   docker compose -f docker-compose.yml up --build -d tinytavern caddy-prod
   ```

Open **`https://<host>:5487`**. Chats, settings, jobs, avatars, images, videos and
thumbnails are stored in `./data`. The server image includes Bun and FFmpeg; no
host Bun, Node.js or FFmpeg installation is needed.

To update after pulling new code, run `docker compose -f docker-compose.yml up --build -d tinytavern caddy-prod` again.

## First chat

1. Open **Settings > Endpoints** and add your API. Its base URL should include
   `/v1`. Choose a model, configure sampling, and select the endpoint as active.
2. Start a conversation with the built-in **Assistant** character.
3. Add or import characters as needed. Prompts, templates, and personas can be
   customized in Settings.

## Access

Set a password under **Settings > General** to require sign-in. No password is
configured by default. Sessions last 30 days; changing or removing the password
signs out all devices.

To restrict access by IP address, set `TINYTAVERN_IP_ALLOWLIST` in `.env`:

```dotenv
TINYTAVERN_IP_ALLOWLIST=127.0.0.1/32,::1/128,192.168.1.20/32,192.168.1.0/24
```

Separate addresses or CIDR ranges with commas, and include the devices that need
access. An unset or empty value allows all addresses. Apply changes with
`docker compose -f docker-compose.yml up -d tinytavern caddy-prod`.

## Settings import and export

Use **Import** and **Export** in a settings page's footer to transfer its settings
as JSON. Imports into an editor remain unsaved until you click **Save**. Saved
entities also have individual import/export controls; **Import all** and
**Export all** are below their list. Import all shows a review before merging the
records.

Named presets and workflows merge within their operation and reference-count
group. References match by name, first exactly and then case-insensitively; missing
or ambiguous matches leave the destination selection unchanged. Endpoint API keys
and the access password are excluded. Persona JSON includes its avatar. Characters
use PNG cards, including their TinyTavern prompt, template and folder references.

## Media tools

TinyTavern uses ComfyUI to create images, edit images from references, generate
short videos, and describe images. Rendering runs on the server and continues
when you close the tool or disconnect.

Open **Gallery → Tools** for **Create image**, **Edit image**, or **Create video**.
The chat tools menu offers **Create image from chat** and **Create video from
chat**. An image's tools menu can open Edit image with Reference 1 selected,
Create video with it as the first frame, or Reference for a video.

| Flow                                 | Image inputs                 | Result                    |
| ------------------------------------ | ---------------------------- | ------------------------- |
| Create image                         | None                         | Image                     |
| Edit image                           | One, two or three references | New image                 |
| Create video                         | None                         | AV1 WebM                  |
| Video from first frame               | One first frame              | AV1 WebM                  |
| Video from references                | One, two or three references | AV1 WebM                  |
| Describe image, from gallery details | One source image             | Text for the saved prompt |

### Configure ComfyUI

Set ComfyUI's URL in **Settings → Media rendering** to an address reachable from
TinyTavern's server container. You can use a published host/LAN address or connect
the ComfyUI container to the Compose-created `tinytavern_comfy` network and use its
hostname. The default URL is `http://comfy:8588`; change it to match your setup.

To reuse an existing Docker network instead, set these values in the ignored
`.env` file before starting or updating TinyTavern:

```dotenv
TINYTAVERN_COMFY_NETWORK=your-comfy-network
TINYTAVERN_COMFY_NETWORK_EXTERNAL=true
```

Without these overrides, Compose creates the network automatically; no external
network is required for installation. Both dev and production use the same
configuration.

The Comfy instance must provide `DELETE /view` for file cleanup and `POST /api/jobs/:id/cancel` for targeted
job cancellation. These are APIs provided by the Comfy installation used with
this project.

Paste workflows exported with ComfyUI's **Save (API Format)** into the matching
operation. Each operation supports multiple named workflows. Selecting one makes
it the default for that operation. Reference counts have separate groups, so you
can save different workflows for one, two and three images.

Image and video workflows must return media from exactly one output node.
Multiple media output nodes are a workflow error. Videos must be AV1 in WebM;
TinyTavern keeps the original file. A VHS Video Combine output is supported.
Describe image has no saved workflow by default; configure it separately to
enable prompt generation in gallery details.

### Prompts and reference inputs

Put `{{prompt}}` in a Comfy **Text** node under **utilities → primitive** and connect
it to the workflow's prompt input. This preserves the braces during API export.
Select sample files in **Load Image** or **Load Image (as Mask)** using these names:

| Operation              | Sample filenames                                     |
| ---------------------- | ---------------------------------------------------- |
| Edit image             | `reference1.png` through `reference3.png`, as needed |
| Video from first frame | `first_frame.png`                                    |
| Video from references  | `reference1.png` through `reference3.png`, as needed |
| Describe image         | `source.png`                                         |

TinyTavern recognizes these basenames, including subfolders and Comfy's optional
` [input]` suffix. At render time it uploads the selected images and binds the
returned filenames. Uploads use unique job filenames in Comfy's input root;
your sample files stay untouched and no per-job directory is created. Other
filenames and linked inputs retain their configured values. Other loader nodes
can use explicit `{{first_frame}}`, `{{reference1}}`–`{{reference3}}`, or
`{{source}}` bindings for the corresponding operation.

Numeric `seed` and `noise_seed` inputs, including directly linked integer
constants, receive the job's fresh seed automatically. Connected computations
keep their wiring. Use `{{seed}}` only if you need the seed elsewhere in the graph.
Output filename prefixes can stay as configured in Comfy; `{{job_id}}` is available
if you want a job-specific prefix. Output nodes must return file metadata so
TinyTavern can retrieve and clean up their files.

### Expose workflow controls

Rename supported Comfy **Int**, **Float**, **Text**, **Text (Multiline)**, or
**Boolean** constant nodes before exporting. KJNodes equivalents are also
supported. Keep node titles in the API export's `_meta.title`.

```text
Resolution [input: order=0]
Duration (seconds) [input: min=1, max=10, step=0.5, order=1]
Hybrid Model [input: order=2]
Same Aspect Ratio 1 [input: order=3]
Negative prompt [input]
```

The text before `[input]` becomes the label. All supported nodes accept an integer
`order`: lower numbers appear first, followed by nodes without an order. Ties keep
their node order. Numeric controls accept `min`, `max`, and positive `step`;
steps start at `min`, or zero when no minimum is set. The default step is 1 for
integers and 0.1 for floats. The node's literal value supplies the initial value
and must satisfy those limits.

Text uses a single-line field; Text (Multiline) uses a textarea. Booleans use
checkboxes and can feed a switch for conditional workflow branches. Text and
Boolean nodes accept only `order`. Convert duration to the appropriate frame
count inside the workflow. Explicitly exposed seed constants retain the value
you choose.

A **Resolution Selector** named `Resolution [input]` exposes its aspect ratio and
megapixels together. Megapixels defaults to the node's saved value with a range
of 0.1–16 and a step of 0.1; optional `min`, `max`, and `step` narrow that range.
The `multiple` input and width/height connections stay as configured in Comfy.
Opening a tool from an image selects the nearest supported aspect ratio when
this control is available. A hint beside the control shows example output sizes.

Workflow controls are saved with each variation and rerun recipe. You can keep
iterating in Comfy and paste fresh API exports without editing their JSON.

### Prepare a prompt

Enter an instruction and use **Prepare prompt**, or enter the **Final prompt**
directly and render it. Message menus and each code block's **…** menu also offer
**Use as image prompt** and **Use as video prompt**, copying their text into the
final prompt field for a result that will return to chat.

Chat and gallery preparation use different settings:

| Settings page         | Used for                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| Chat image prompts    | Chat image tools and `/image`, `/imagechar`, `/imageface`                |
| Chat video prompts    | Video prompt preparation launched from chat                              |
| Gallery image prompts | Standalone image creation and all image editing                          |
| Gallery video prompts | Standalone video prompt preparation                                      |
| Avatar prompts        | Character and persona avatar preparation                                 |
| Media rendering       | Comfy connection, saved workflows, workflow defaults and avatar workflow |

Chat tools retain the complete structured conversation as their prompt prefix,
then append the selected `[System Note]` steering instruction. They inherit the
chat template's reasoning prefill. For chat images, filling in an instruction
selects the corresponding preset set; changing sets keeps a same-named preset
when available, otherwise it selects the default. Gallery preparation has its own
system/user templates and reasoning/message prefills. Image editing always uses
standalone preparation, including when its result returns to chat.

Prompt preparation shows a spinner and the streamed reasoning, including the
reasoning prefill actually sent to the endpoint. The final prompt field replaces
that preview when text arrives. Reasoning is not included in the media prompt or
saved recipe.

Templates can use `{{first_frame_prompt}}` and `{{reference1_prompt}}` through
`{{reference3_prompt}}` where their operation has those slots. Each value is the
selected image's saved prompt. For example:

```text
{{#if first_frame_prompt}}
The first frame was generated with this prompt:
{{first_frame_prompt}}
{{/if}}
```

Unused slots and images without a saved prompt have empty values. Prompt text is
captured with the selection and kept in the job and rerun recipe. Later edits to
the source's saved prompt do not change existing captures; choosing a new input
captures its current prompt. The workflow receives the actual selected images.

### Review variations and rerun

Tool pages keep results in a draft. Generate variations, compare them with
Previous/Next, then choose **Add to chat** or **Save to gallery**. You can save
multiple results and keep generating in the same draft. **Finish** closes the
draft and removes its unsaved results while keeping everything you saved.

Selecting a variation changes the preview and leaves your working prompt and
controls intact. **Result details** shows that variation's captured workflow,
seed, controls, instruction and prompt. Use its **Copy** or **Use in editor**
actions to reuse the saved text.

Closing a draft before starting any preparation or rendering discards it. Once
work has started, closing saves the draft and leaves generation running.
**Discard draft** cancels the work and removes it. Open **Gallery → Jobs** to
resume a draft or cancel an active job.

Saved media retains its original instruction, final prompt, workflow and controls
for **Rerun**, even after its job has been deleted. Accepted chat images also use
the normal image swipe controls: moving forward past the last image renders
another alternative into the same message. Videos rerun through the media tool.
Saving a chat attachment to the gallery creates an independent file copy.

Rendering shows the current node, completed graph nodes, and the current node's
steps. Image and video jobs request Comfy's `taesd` previews. Video jobs enable
VHS's animated latent preview; TinyTavern plays its JPEG frames at their original
resolution. Finished videos autoplay with sound and loop where the browser allows
it. A fullscreen button shows the video's resolution.

There is no overall rendering time limit by default. An optional job timeout is
configured in Media rendering; prompt streaming uses an inactivity timeout, so a
long reasoning stream stays active while data keeps arriving. Submitted Comfy jobs
recover after a TinyTavern server restart. If downloading a completed result fails,
you can retry retrieval for 24 hours without generating it again.

Jobs outside a review draft are deleted after their results are saved. Review
variations remain until you finish or discard their draft; failed jobs remain
available for inspection or deletion. Comfy uploads and outputs are deleted once no
longer needed; failed deletions retry independently of visible job history.
Cancellation targets only that job and waits for Comfy to stop before releasing
its inputs. VHS metadata PNG sidecars and retained intermediate files are disabled
for TinyTavern submissions.

## Gallery

The gallery holds uploaded images and saved image/video results. Filter by
character, search prompts, and open an item for its prompt, source images and
rerun controls. **Tools** and **Jobs** are in the gallery grid header; details has
its own navigation and actions.

Use **Characters** in details to select one or more characters, then click **Save**.
Generated media inherits the combined characters of its input images and chat
context. An item tagged with two characters appears under either character's
filter and shows both names. Removing a character association does not delete
the media.

Edit **Saved prompt** on uploaded or generated media, then use **Save** or
**Discard**. The saved text becomes available to later reference-prompt macros.
Under **Source images**, deleting an input from the gallery leaves a **Deleted
image** slot. Its image is not retained for reruns; select a replacement before
rendering again. Its captured prompt text remains saved.

### Generate an image's saved prompt

Configure a workflow in **Media rendering → Describe image**, using `source.png`
in Load Image, the instruction in Generate Text, and one Preview as Text output.
Then click **Generate** beside Save and Discard in image details. TinyTavern uploads
the image, displays node/token progress, and puts the returned text into the editor.
Edit it if needed and click **Save**. Generate does not save the prompt by itself;
Cancel or closing details stops the description job and cleans up its upload.

### Thumbnails and playback

Gallery tiles use JPEG thumbnails for images and videos. Hover over a video for
half a second to play it inline, muted and looping; moving away restores the
thumbnail. Chat and detail players load the original WebM and show its decoded
first frame before playback.

**Settings → General → Thumbnails → Thumbnail size** sets the maximum dimension
(default 512 px, range 64–2048). Changing it rebuilds thumbnails in the background,
keeping existing ones visible until replacements are ready. Originals remain
unchanged, and thumbnails are deleted with their media. Avatar previews are 128 px;
original avatars remain available for editing and PNG export.

Conversation JSON exports include images, recipes and reference images, and keep
all messages and branches. They omit video files. Download videos individually
from the player when needed.

## Page navigation

Page URLs remember the open chat, gallery item and filters, settings section, and
media job with its return page. Reloading restores that view, and reconnecting
refreshes an open job's progress. Closing a tool opened from gallery details
returns to that item with the chat still behind it. Opening Jobs returns to an
already open jobs list, preserving its position and avoiding duplicate pages.

Mouse Back first uses the current UI's Back/Close action, starting with open menus
and viewers. Once no UI remains to close, browser navigation proceeds normally.
Settings navigation keeps the Save/Discard/Cancel guard; cancelling Back or
Forward preserves the browser history entry.

## Backups

The current database baseline is schema 68. New installations create it directly.
Older databases and backups require an upgrade-capable older build before this
version can open them; see [database schema notes](docs/database-schema.md).

Create a database backup while TinyTavern is running:

```sh
docker compose exec tinytavern bun server/src/backup.ts /data/backups/tinytavern-$(date +%F).db
```

The command creates a consistent online SQLite snapshot and atomically publishes it, refusing to overwrite an existing backup. Do not copy the live
`tinytavern.db` file directly: an active transaction can leave an inconsistent copy.
For a complete backup including avatars, images, videos and recipe references,
stop TinyTavern and copy `./data`. Preserve `.secrets` and certificates separately.

## Certificate renewal

After replacing `certs/cert.pem` and `certs/key.pem`, reload the certificate:

```sh
docker compose exec caddy-prod tinytavern-caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
```

## Shortcuts and commands

- **Enter** sends and **Shift+Enter** inserts a newline. On touch layouts, Enter
  inserts a newline; use the send button to send.
- **Up** in an empty composer edits the last message. **Ctrl/Cmd+Enter** in a
  message editor submits the edit as a new branch; **Escape** cancels.
- **Left/Right** switches between alternatives for the last image or assistant
  reply. Moving right past the end generates another. Horizontal swipes do the
  same on touch screens.
- `/char <name>` changes the assistant speaker. `/del <n>` removes messages from
  the end, including their alternatives and descendants. `/delchat` deletes the
  conversation.
- `/image`, `/imagechar`, and `/imageface` use the corresponding image prompt
  preset. Each accepts an optional instruction after the command.

## Development commands

Bun 1.4.2 Alpine runs the backend, Vite, tools and tests. Dependencies are pinned
in `bun.lock`; no Node runtime or host dependency installation is needed.

Start the development stack with the same certificates and keys as above:

```sh
./scripts/init-caddy.sh --media-dirs
docker compose -f docker-compose.dev.yml build server client caddy-dev
docker compose -f docker-compose.dev.yml up -d --no-build --force-recreate server client caddy-dev
```

Open **`https://<host>:5173`**. Development stores its data in `./data-dev`,
separately from production. Both stacks share a Compose project; never use
`--remove-orphans`, which can remove the other stack.

Run development checks without affecting either stack:

```sh
./scripts/run-in-container.sh check
./scripts/run-in-container.sh format
./scripts/run-in-container.sh build
./scripts/run-isolated-tests.sh
```

These commands copy source into disposable containers with no host mounts.
Tests always run the complete suite with isolated tmpfs databases. Formatting and
client builds copy their output back on success. After changing package versions,
run `./scripts/run-in-container.sh install` to update the lockfile, then rebuild
the development images before deploying them. Development source mounts are
read-only; server/shared edits trigger graceful application restarts, while Vite
handles client and shared-source hot reload with a container-local cache.
Recreate the affected development services after changing mounted configuration
files, including `client/vite.config.ts`; container file mounts can otherwise
retain the previous file when an editor replaces it.
