# TinyTavern

TinyTavern is a chat app you run yourself. Connect a local model or an OpenAI-compatible
service, talk with characters, and create images and videos through ComfyUI.

Edit messages, try alternative replies, and explore different paths through a conversation.
Your chats and gallery stay together, whether you open them on your phone or desktop.

## Run it

You’ll need Docker with Compose and an HTTPS certificate.
Place the certificate in `certs/cert.pem` and its private key in `certs/key.pem`, then run:

```sh
./scripts/init-caddy.sh --media-dirs
docker compose -f docker-compose.yml up --build -d tinytavern caddy-prod
```

Open **https://<host>:5487** in your browser, using your server’s address in place of `<host>`.

## Start chatting

1. Open **Settings → Model connections**. Add your model’s API URL (including `/v1`),
   enter an API key if needed, choose a model, and save the connection.
2. Start a new chat with **Assistant** and send a message.
3. For character chats, create a character or import a SillyTavern PNG card under **Settings → Characters**.

To require sign-in, set a password under **Settings → General**.

## Make images and videos

Set your ComfyUI address under **Settings → Generation settings**, then add a workflow
exported in API format under **Settings → Workflows**.
Open **Gallery → Tools → Generate media**, choose a workflow, and add any input images.
Prepare a prompt or write your own, then click **Generate**. Review the variations and **Save** your favorites.

Text workflows return text you can copy or reuse as a prompt. When generating from a chat,
**Add** saves the text as a message. Avatar generation uses the same model connection settings
and skips prompt preparation for workflows without a prompt input.

## Updates and backups

To update, pull the latest code and rerun the Compose command above.
Keep `data/` and `.secrets/`; they hold your saved work and access keys.
Setup details, backup commands, and development guidance are in [AGENTS.md](AGENTS.md).
