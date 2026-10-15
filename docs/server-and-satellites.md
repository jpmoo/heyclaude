# Morgan as a server, with devices as clients

A plan, not yet built. It covers moving Morgan's brain to the home server, its
speech to the AI server, and turning every device — the laptop first, then a Pi
in an old Echo Dot — into a client.

## Why

- **One assistant, not several.** Memory, threads, reminders and the Oracle's
  context live in one place. A conversation started at the desk can be finished
  from the kitchen.
- **It matches the other projects.** Brigid and Hermes live on the home server
  and call the AI server for inference. Morgan is the odd one out, running on
  the laptop.
- **Secrets in one spot.** The memory key, the Oracle's Claude login and the MCP
  keys are set up once, on a machine you control. A client holds nothing worth
  stealing.

## Where each piece runs

| Home server (its project checkout, system service) | AI server (next to Ollama) | Each client |
|---|---|---|
| The daemon: turns, the sorter, guards, routing | Qwen (already there) | Microphone and speaker |
| Memory, documents, pictures, transcripts, threads | Embeddings (already there) | Wake word |
| Reminders and timers | **Speech to text** (faster-whisper on the GPU) | Echo cancellation |
| MCP connections (Hermes and the rest) | **Speaker recognition** (the voiceprint model) | Status lights, or the window or panel |
| The Oracle (`claude`, its own login) | **Text to speech** (Kokoro) | Its own abilities: see below |
| The memory key, sealed storage | | A "can't reach home" sound |

The daemon calls the speech services over HTTP, as it already calls Ollama. The
AI server has 128 GB, so speech sits beside Qwen without crowding it.

### How the home server runs it

Like the other web apps there: it runs in its own project checkout, wherever
those live on the home server, as a system service under the same account, with
`restart.sh` in the checkout to update it. Its data lives in the checkout's
`data/` folder (kept out of git), and a `.env` in the checkout says only where to
listen:

```
PORT=8790
HOST=0.0.0.0
```

Everything else — the name, the voice, Ollama's address and model, the Oracle's
model, MCP servers, folders, thresholds — is still set from the laptop: the
settings window and `heyclaude settings` work as now, but what they change is
saved on the server, in its config file (`data/config.json` in the checkout), and
taken up there. The laptop keeps one setting of its own: where its server is.

### Reaching it from away

At home, clients go straight to the server's LAN address on 8790. From away, the
laptop goes through Tailscale to Caddy on 8083, under the project's name (not
the assistant's, which is a setting):

```caddy
  handle_path /heyclaude* {
    reverse_proxy 127.0.0.1:8790
  }
```

inside the `:8083` site, before its catch-all `handle`. `handle_path` strips the
prefix, and `reverse_proxy` passes the WebSocket upgrade through. If 8083 is
reached by Tailscale **Funnel** (the public internet) rather than **Serve** (the
tailnet only), every request without a valid device token must be refused,
settings included; with Serve the tokens are a second lock.

### The laptop's own setting

`~/.config/heyclaude/client.json`:

```json
{ "server": "home-server:8790" }
```

Set from the settings window (a "Morgan's home" field on the Connections tab) or
`heyclaude settings`. Left empty, the laptop runs the whole of Morgan itself, as
it does today; that stays possible during the move and after it, for a laptop
away from home with no Tailscale.

### Clients are thin, not dumb

Each client says what it can do when it connects, and the daemon calls those
abilities as tools, on the device that has them:

| Client | Abilities |
|---|---|
| Laptop (Noctalia plugin, window, terminal) | typing, the chat views, screen, clipboard, camera, files in allowed folders, hotkey, Escape |
| Dot (Pi Zero 2 W) | voice, the light ring, the button |

"Look at my screen" goes to the laptop; "pulse the ring" goes to the Dot. A
request for an ability no connected client has is answered plainly ("I can't see
anything from here"), never guessed at.

## One spoken exchange

1. **The client listens locally.** 16 kHz mono, through echo cancellation and
   the wake-word spotter. Nothing leaves the device until the wake word fires or
   the button is pressed.
2. **The client streams.** It sends `wake`, then audio in 20 ms frames, and
   lights "listening".
3. **The server decides when you have stopped.** Voice-activity detection
   (Silero VAD) on the incoming stream; after `endSilenceMs` of quiet it closes
   the utterance and tells the client to stop sending.
4. **The server transcribes and checks the voice** (faster-whisper, then the
   voiceprint), on the AI server's GPU.
5. **Morgan answers, as now.** The text goes to the turn handler: the sorter,
   then Qwen, consulting the Oracle or a service when the sorter says so. The
   client is sent `thinking`, and the ring sweeps.
6. **The server speaks in sentences.** Each finished sentence goes to Kokoro and
   its audio streams back down the same connection, so the first sentence plays
   while the rest is still being written.
7. **The client plays it and goes back to idle.**

Typed turns from the window or the panel skip steps 1–4 and 6.

## The protocol

One WebSocket per client, to the home server (over the LAN at home, Tailscale
from away), kept open.

**Opening:** `hello { device, key, kind: "laptop" | "dot", can: [...] }`. The
server answers `welcome { name, wakeWord, state }`, or closes the connection.

### API keys

The server app issues the keys that let client apps in; nothing reaches Morgan
without one.

- **Issued by the server, one per device.** On the home server,
  `heyclaude access add laptop` prints a new key once (`hc_` and 32 random bytes,
  base64url). The server keeps only its hash, with the device's name, when it was
  made and when it was last used, in `data/access.json`. (`heyclaude key` is the
  memory key's command, so these are `heyclaude access`.)
- **Entered on the device**, beside "Morgan's home" in its settings, and kept in
  its `client.json`.
- **Listed and revoked** with `heyclaude access list` and
  `heyclaude access remove kitchen-dot` on the server, or from the settings window
  of a laptop that is already connected (a Keys card on the Connections tab).
  A revoked key's connection is closed at once.
- **The first key is made on the server**, from its terminal; after that, keys
  can be made from the laptop.
- **Checked on every connection and every request**, settings included. Without
  a valid key the answer is a refusal and nothing else.

The memory key that seals what Morgan remembers is a different thing, and never
leaves the server.

**Binary frames, both ways:** 16-bit PCM, 16 kHz mono, 20 ms per frame. That is
about 256 kbps. Opus can come later, if a client is ever used off the home
network.

**Client → server:**

| Message | When |
|---|---|
| `wake { score }` | The wake word fired (the score is for arbitration). |
| `button` | The button was pressed: the same as a wake. |
| `type { text, files? }` | A typed turn. |
| `interrupt` | The user cut in. The client has already stopped playing. |
| `played { id }` | A sentence finished playing (keeps the server's notion of "speaking" true). |
| `ability.result { id, result }` | The answer to an `ability` request. |
| `stand-down` | Acknowledges that another device won the wake. |

**Server → client:**

| Message | When |
|---|---|
| `state { state }` | `idle`, `listening`, `thinking`, `consulting`, `speaking`: drives the lights and the views. |
| `stop-sending` | End of the utterance. |
| `say { id, text }` + binary audio | One sentence, with its audio. |
| `ability { id, name, args }` | Use something only this client has. |
| `event { ... }` | Everything the views show now (cards, the Oracle's answer, the calendar replies). Today's `watch` stream, unchanged in content. |
| `stand-down` | Another device took this wake. |
| `error { message }` | Something went wrong. |

### Three decisions

- **Echo cancellation stays on the client.** It needs the exact signal going to
  the speaker at the moment it plays.
- **Barge-in is local.** The client stops playback the instant it hears the
  interrupt word, then sends `interrupt`; the server cancels the rest of the
  speech and, if asked, the turn. Waiting for a round trip feels broken.
- **Every client has a fallback.** A short "I can't reach home" sound on the
  device, played when the server can't be reached. A silent device is worse than
  one that admits a fault.

### Two devices, one wake word

When the laptop and the Dot both hear "Hey Morgan", the server takes `wake`s
for 300 ms, keeps the one with the higher score, and sends `stand-down` to the
rest. The answer plays on the device that won. Typed turns never arbitrate.

A reminder or timer going off is different: every connected client that can
speak says it, at once (decided: that is wanted). A turn's answer plays only on
the device it was asked on.

## Corrections to the analysis this plan grew from

Two notes went into this plan: mine, and a review of it. These are settled:

- **A Pi 5 doesn't fit a Dot.** Its diagonal (about 102 mm) is more than the
  3rd-generation Dot's 99 mm, before a cooler. The Dot gets a **Pi Zero 2 W**,
  with a 3A+ as the fallback.
- **Split, don't port.** The Zero 2 W has 512 MB; the daemon, `claude` and the
  MCP servers won't fit beside each other on it. Hence this plan.
- **The Dot's LEDs can't be reused** (they are on the board being removed), but
  its light ring diffuser can: a small NeoPixel ring goes behind it.

And two corrections to the review:

- **Step 5 goes to Qwen, not to the Oracle.** The Oracle is consulted only when
  the sorter sends a question to it.
- **Wake word: keep the open-vocabulary spotter.** openWakeWord needs a model
  trained for each phrase; the sherpa-onnx spotter in use now takes any phrase
  ("Hey Morgan", and the name is a setting) and has ARM builds. Whether it keeps
  up on a Zero 2 W has to be measured; openWakeWord with a trained "Hey Morgan"
  is the fallback.

## Where it stands

Built and tested on the laptop (`tests/remote.sh` runs a trial server and client
side by side): the three roles, the server's port and access keys, the client
relaying commands and events, spoken turns answered on the server and spoken on
the client, the settings mirrored from the server, the "can't reach home" line,
and the "Where Morgan lives" settings. Deploying it is in [deploy.md](deploy.md).

Not yet: sight and the laptop's folders as abilities the server asks the laptop
for; speech on the AI server (Phase 1); wake arbitration (Phase 3); the Dot.

## Phases

Each phase ends with Morgan working, and with a check that says so.

### Phase 0 — groundwork (now)

- `restart.sh`, in the shape of Brigid's: stop, pull, install, check, start, and
  bring the old one back up if any step fails. It restarts the user service on
  the laptop today and the system service on the home server later.
- A system-service unit for the home server in `systemd/`, as Brigid's
  `deploy/brigid.service`, reading `.env` for the port; and `.env.example`.

*Done when* `./restart.sh` on the laptop leaves Morgan running.

### Phase 1 — speech on the AI server

- A small speech service beside Ollama: `POST /transcribe`, `POST /voiceprint`,
  `POST /speak` (sentence in, audio out). Python, faster-whisper and Kokoro on
  the GPU, the voiceprint model on either.
- The laptop daemon, still local, calls it instead of whisper.cpp, Kokoro and
  the voiceprint model on the laptop. A setting switches back.
- With 128 GB on the AI server, Whisper can be a larger model than `base.en`
  (`small.en` or `medium.en`) if it stays quick; measure both.

*Done when* a spoken turn on the laptop is transcribed, recognised and spoken by
the AI server, and `tests/steps.py` shows no slower a first word than now.

### Phase 2 — the brain to the home server

- Clone the project on the home server, beside the other web apps, and run it
  there as a system service whose working directory is the checkout.
- Move the data: memory, documents, pictures, history, reminders, and the
  laptop's `config.json`, which becomes the server's `data/config.json`. The
  memory key leaves the laptop's login keyring for a file readable only by the
  service's account, or a systemd credential, on the server.
- The settings operations (`admin`) go over the connection, so the settings
  window and `heyclaude settings` edit the server's config from the laptop.
- The laptop gains its one setting, "Morgan's home" (`host:port`).
- Log the Oracle in there, once, with its own config directories, as now.
- Add the WebSocket endpoint and the protocol above, alongside the existing
  control socket while the laptop moves over.
- Make the laptop a client: a small client process does the microphone, wake,
  echo cancellation and playback, and offers screen, clipboard, camera, files,
  hotkey and Escape as abilities. The plugin, window and `heyclaude` command talk
  to the server through it.

*Done when* the laptop works as it does today with the daemon on the home server,
including sight, files, reminders and the calendar view, and nothing secret is
left on the laptop.

### Phase 3 — more than one client

- Wake arbitration, `stand-down`, and the answer playing where it was asked.
- The "can't reach home" fallback on every client.
- A second client to prove it: the laptop and a phone browser page, or a second
  machine.

*Done when* two clients in one room give one answer, and pulling the home server
off the network makes each client say so.

### Phase 4 — the Dot

- The enclosure: a 3rd-generation Echo Dot (99 mm).
- The build: Pi Zero 2 W, Adafruit Voice Bonnet (two mics, speaker amplifier,
  button, three LEDs), a NeoPixel ring behind the Dot's diffuser on the bonnet's
  3-pin connector, the Dot's speaker or an Adafruit 40 mm one, and power.
- The Dot client: the same client as the laptop's minus the desktop abilities,
  plus the ring (the sweep while thinking, a glow while listening) and the
  button.
- PipeWire echo cancellation on the Zero, and the wake spotter measured there.
- No Tailscale on the Zero: the Dot lives on the home network and reaches the
  home server by its LAN address, set as its "Morgan's home".

*Done when* "Hey Morgan" in the kitchen gets an answer from the Dot, and a
conversation started there can be carried on in the window.

## Open questions

- The home server's name on Tailscale, and the port (8790 above is a
  placeholder).
- Whether the sherpa-onnx spotter keeps up on a Zero 2 W.
- Whether the laptop's client should be its own small service, or the plugin's
  service entry, which already follows the event stream.
