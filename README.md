# TinyTavern

TinyTavern is a self-hosted chat interface for OpenAI-compatible language model
APIs, with characters, personas, prompt templates, and branching conversations.
Use it on desktop or mobile, with chats synchronized across devices.

<p align="center">
  <img src="docs/chat.jpg" alt="Chat with an image generated through ComfyUI" width="850">
</p>

<p align="center">
  <img src="docs/tree-map.png" alt="Zoomable map of a conversation's branches" width="850">
</p>

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
  branches and images.
- Generate images and avatars through ComfyUI. Save images and their prompts to
  a gallery, revise them, and generate new versions independently of the source chat.

## Install

You need Docker with Compose, a TLS certificate, and an OpenAI-compatible API.
The containers run as UID/GID `1000:1000`; run the setup commands as that user,
or adjust the user and file ownership for your installation.

1. Place your certificate at `certs/cert.pem` and its private key at
   `certs/key.pem`.
2. Ensure the Docker network `my-bridge-network` exists. Create it if needed:

   ```sh
   docker network create my-bridge-network
   ```

3. Prepare the directories and start TinyTavern:

   ```sh
   ./scripts/init-caddy.sh --media-dirs
   docker compose up --build -d
   ```

Open **`https://<host>:5487`**. Chats, settings, avatars, and generated images are
stored in `./data`.

To update after pulling new code, run `docker compose up --build -d` again.

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
`docker compose up -d`.

## Image generation

Connect ComfyUI to `my-bridge-network` and set its URL under
**Settings > Tools > Image Generation**. The default URL is `http://comfy:8588`;
use the hostname and port of your ComfyUI container.

Export a workflow using ComfyUI's **Save (API Format)** and paste it into the
image-generation settings. Replace the sampler seed with `{{seed}}` and the
positive prompt text with `{{prompt}}`. You can save multiple workflows and
choose which one to use.

Use `/image` in a chat to generate an image. Character and persona editors also
have an avatar-generation button. Save images to the gallery to keep them after
deleting their source conversations.

## Backups

When upgrading an installation from before the TinyTavern rename, back up both
databases and stop the old containers before changing files. Rename the database
in each data directory to `tinytavern.db`, keeping any `-wal` and `-shm` sidecars
with it under the same new basename. Preserve the media directories, `.secrets`,
and certificates, and rename the allowlist variable in `.env` to
`TINYTAVERN_IP_ALLOWLIST` before recreating the stacks. Browser sessions and local
view preferences use new keys, so sign in again after upgrading. To import a
conversation JSON exported before the rename, change its top-level `format`
field to `tinytavern-conversation`.

Create a database backup while TinyTavern is running:

```sh
docker compose exec tinytavern node server/src/backup.ts /data/backups/tinytavern-$(date +%F).db
```

The command refuses to overwrite an existing backup. Do not copy the live
`tinytavern.db` file directly: that can miss changes still in its write-ahead log.
For a complete backup including avatars and images, stop TinyTavern and copy
`./data`.

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
