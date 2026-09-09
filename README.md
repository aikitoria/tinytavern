# TinyTavern

A self-hosted chat interface for OpenAI-compatible APIs, with branching conversations
and ComfyUI image and video generation. Works on desktop and mobile.

- Edit messages, swipe through alternative replies, and explore a conversation tree.
- Create characters and personas, including SillyTavern PNG card import/export.
- Customize prompts, templates, models, and sampling settings.
- Generate images and videos in the background; review variations and save them to a gallery.
- Sync chats across devices, search history, and import/export conversations.

## Install

Requires Docker with Compose, a TLS certificate, and an OpenAI-compatible API.
Containers run as UID/GID `1000:1000`; use that user for setup or adjust ownership.

1. Put your certificate in `certs/cert.pem` and private key in `certs/key.pem`.
2. Run:

   ```sh
   ./scripts/init-caddy.sh --media-dirs
   docker compose -f docker-compose.yml up --build -d tinytavern caddy-prod
   ```

Open **https://<host>:5487**. Data is stored in `./data`; preserve it and `.secrets`.
To update, pull the latest code and rerun the Compose command above.

## Get started

1. Add your API under **Settings → Endpoints** (base URL including `/v1`), choose a model, and select it as active.
2. Start a chat with **Assistant**, or create/import a character.
3. Set a password under **Settings → General** if you want sign-in. No password is configured by default.

For images and videos, set a reachable ComfyUI URL and paste API-format workflows
under **Settings → Media rendering**, then open **Gallery → Tools**.

Development commands and architectural rules live in [AGENTS.md](AGENTS.md).
