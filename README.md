# heyclaude

Morgan: a voice and chat assistant for a Linux desktop (Hyprland, Noctalia,
PipeWire). A local model served by Ollama does the talking. When a question is
beyond it, it consults "the Oracle" — Claude, through the `claude` command on
its own subscription login — and relays the answer.

## What is where

| | |
|---|---|
| `daemon.mjs` | The assistant: microphone, wake word, speech in and out, the model loop, memory, sight, MCP tools. Runs as `heyclaude.service`. |
| `bin/heyclaude` | The command: `settings`, `chat`, `toggle`, `say`, `type`, `stop`, `new`, `interview`, `voice`, `login`, `status`, `watch`. |
| `settings.mjs` | `heyclaude settings`: menus for everything in `~/.config/heyclaude/config.json`. |
| `lib.mjs` | Paths, defaults, the Oracle's login, encryption. |
| `history.mjs` | Every exchange, sealed, with embeddings for finding earlier ones. |
| `admin.mjs` | What the settings window may ask of the daemon: `heyclaude admin {"op": ..., "args": ...}`. |
| `reminders.mjs` | Timers and reminders: working out when they are due. |
| `speaker.mjs` | Whose voice is speaking, from taught voiceprints. |
| `mcp.mjs` | A small MCP client (stdio and HTTP with a header key; no OAuth). |
| `wake.mjs` | The wake-word spotter. |
| `kokoro.mjs` | The Kokoro voice, kept loaded as a helper process. |
| `keyring.py` | Fetches the data key from the login keyring. |
| `noctalia/` | The Noctalia plugin: voice popup, chat window, settings window, bar icon. |
| `systemd/` | The user unit. |

## What it needs, beyond this repository

Under `~/.local/share/heyclaude/`, none of it committed here:

- `whisper.cpp/` built from source, and `models/ggml-base.en.bin` (speech to text)
- `piper/` and `voices/*.onnx` (the lighter voice)
- `kokoro-multi-lang-v1_0/` (the more natural voice)
- `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/` (wake word)
- `speaker/nemo_en_titanet_small.onnx` (telling voices apart)

Also: Node 22, `npm install` here, an Ollama server with a tool-calling chat
model and an embedding model, the `claude` command, `pw-record`, `pw-play`,
`pw-cli`, `ffmpeg`, `grim`, `wl-paste`, and python3 with GObject bindings for
libsecret.

## Installing

```bash
npm install
ln -s "$PWD/bin/heyclaude" ~/.local/bin/heyclaude
ln -s "$PWD/noctalia" ~/.local/share/noctalia/plugins/morgan
cp systemd/heyclaude.service ~/.config/systemd/user/
systemctl --user enable --now heyclaude.service
noctalia msg plugins enable jpmoo/morgan
heyclaude settings
```

The unit file assumes the repository is at `~/Documents/Scripts/heyclaude`.

## Where things are kept

- Settings: `~/.config/heyclaude/config.json` (not encrypted; holds any MCP access keys).
- The Oracle's Claude login: `~/.config/heyclaude/anthropic` and `~/.config/heyclaude/claude`, apart from any other Claude login on the machine.
- Memory topics, saved pictures and the transcript: `~/.local/share/heyclaude/memory` and `history`, encrypted with a key in the login keyring.

## License

GPL-3.0-only — see [LICENSE](LICENSE). Also available on other terms from the
owner, as Talaris is. Contributions need the [Contributor License
Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
