# Renaming heyclaude to Morgan

**A plan, not yet carried out.** Written 2026-10-23; nothing below has been
done. It needs Jeff's go-ahead, and the GitHub repository is not to be renamed
until then.

The assistant has been called Morgan for a while; the project, its command, its
service, its files and its socket are still `heyclaude`. Talaris is about to
depend on Morgan (its face is Talaris's; its brain stays here), and the names
Talaris builds against should be the lasting ones. So the rename comes before
Talaris writes code against the socket, or very soon after.

## What has to keep working

- **Jeff's laptop**, as it is today: `heyclaude.service` enabled under the
  user's systemd, `~/.local/bin/heyclaude` linked to the checkout, the Noctalia
  plugin linked in as `morgan`, the window's desktop file and icon installed,
  `~/.config/heyclaude/` holding `config.json`, `client.json` (the laptop is a
  **client** of the home server), `mirror.json` and the Oracle's `claude` login,
  and `~/.local/share/heyclaude/` holding the speech models, memory, history
  and the working folder.
- **The home server**: a system service from `systemd/heyclaude-server.service`
  running the checkout at `~/heyclaude`, its data in the checkout's `data/`,
  reached by clients on port 8790 and through Caddy under `/heyclaude`.
- **The memory key** in the login keyring. This is the one thing that can be
  lost for good: see step 4.

## Names, old and new

| What | Now | After |
|---|---|---|
| GitHub repository | `jpmoo/heyclaude` | `jpmoo/morgan` (GitHub redirects the old URL) |
| Laptop checkout | `~/Documents/Scripts/heyclaude` | `~/Documents/Scripts/morgan` |
| Command | `bin/heyclaude` → `~/.local/bin/heyclaude` | `bin/morgan` → `~/.local/bin/morgan`; `heyclaude` kept as a link to it |
| User unit (laptop) | `heyclaude.service` | `morgan.service`, with `Alias=heyclaude.service` |
| System unit (server) | `systemd/heyclaude-server.service`, installed as `heyclaude.service` | `systemd/morgan-server.service`, installed as `morgan.service`, same alias |
| Command socket | `$XDG_RUNTIME_DIR/heyclaude.sock` | `$XDG_RUNTIME_DIR/morgan.sock`; `heyclaude.sock` also answered for a while |
| Kokoro helper socket | `heyclaude-tts.sock` | `morgan-tts.sock` (private; no transition needed) |
| Server's own socket | `data/heyclaude.sock` | `data/morgan.sock` |
| Settings and logins | `~/.config/heyclaude/` | `~/.config/morgan/` |
| Models, memory, history | `~/.local/share/heyclaude/` | `~/.local/share/morgan/` |
| Client file | `~/.config/heyclaude/client.json` | `~/.config/morgan/client.json` (same contents; the name `client.json` stays) |
| Environment | `HEYCLAUDE_*` (below) | `MORGAN_*`, with `HEYCLAUDE_*` still read |
| Keyring entry | schema `dev.heyclaude.Key`, `service=heyclaude` | **unchanged**, or copied once: see step 4 |
| App id (window) | `dev.heyclaude.Morgan` | `io.github.jpmoo.Morgan` (see Decisions) |
| Noctalia plugin | `jpmoo/morgan`, depends on `heyclaude` | id unchanged; depends on `morgan`; calls `~/.local/bin/morgan` |
| npm package name | `heyclaude` | `morgan` |
| MCP client name | `heyclaude` 0.1 | `morgan` |
| PipeWire nodes | `heyclaude.mic`, `heyclaude.ec.capture` | `morgan.mic`, `morgan.ec.capture` |
| Temporary files | `heyclaude-*.wav`, `-look-`, `-keep-`, `-view-`, `-keywords-` | `morgan-*` |
| Window's single-instance name | `heyclaude-window`, `heyclaude-window-trial` | `morgan-window`, `morgan-window-trial` |
| Caddy route | `/heyclaude*` → 8790 | `/morgan*` added beside it; `/heyclaude*` kept |
| Access keys | `hc_…` | **unchanged**: issued keys stay valid, and new ones keep the prefix |

The environment variables, each read as `MORGAN_X ?? HEYCLAUDE_X`:
`ROLE`, `CONFIG`, `CLIENT_FILE`, `MIRROR`, `DATA`, `MEMORY`, `KEY_FILE`,
`SOCKET`, `DEBUG`, `TRIALRUN`, and the window's `WINDOW_OPEN`, `WINDOW_RUN`,
`WINDOW_SETTLE`, `WINDOW_SHOT`, `WINDOW_WAIT`. `PORT` and `HOST` are not
prefixed and do not change.

## The steps

Each step is one commit, and leaves both the laptop and the server working.

### 1. Read both names (code only, nothing moves)

- One helper in `env.mjs`, `setting("ROLE")`, that returns `MORGAN_ROLE` or else
  `HEYCLAUDE_ROLE`; every `process.env.HEYCLAUDE_*` read goes through it.
  `window.py` and the test scripts get the same fallback.
- One place for the paths: `CONFIG_HOME` and the data folder are defined once (in
  `lib.mjs`) and used everywhere. Today `daemon.mjs`, `speaker.mjs`, `wake.mjs`,
  `kokoro.mjs` and `settings.mjs` each build `~/.local/share/heyclaude` for
  themselves; they import it instead.
- Paths resolve to `~/.config/morgan` if it exists, otherwise
  `~/.config/heyclaude`; likewise for `~/.local/share`. Nothing is moved yet.

After this commit, nothing has changed on disk and both names are honored.

### 2. Answer on both sockets

The daemon listens on `morgan.sock` and also on `heyclaude.sock` (two listeners,
one handler; both deleted on shutdown). Clients — `bin/`, `window.py`, the
Noctalia plugin — try `morgan.sock` first and fall back to `heyclaude.sock`.
`docs/protocol.md` goes to **1.1**: the new path is added, the old one is
documented as deprecated. Talaris is told to use `morgan.sock` from the start.

Dropping `heyclaude.sock` later is a breaking change, and makes the protocol
**2.0**.

### 3. The command and the units

- `bin/morgan` is the command; `bin/heyclaude` becomes a link to it, so
  `~/.local/bin/heyclaude` keeps working, and with it the Escape binding the
  daemon sets in Hyprland and any script Jeff has.
- The Escape binding, the hotkey, and the plugin's calls switch to
  `~/.local/bin/morgan`. Install adds that link.
- `systemd/morgan.service` replaces `heyclaude.service` (its `ExecStart` still
  pointing at the checkout where it is; step 7 moves that), with
  `[Install] Alias=heyclaude.service`, so `systemctl --user restart heyclaude`
  (and the code that still says it, on an older checkout) reaches the same
  unit. The code that restarts the daemon (`lib.mjs`'s `restartDaemon`,
  `daemon.mjs`'s `restartSoon`, `restart.sh`) says `morgan.service`, and
  `restart.sh` looks for either name.
- `systemd/morgan-server.service` replaces `heyclaude-server.service`, likewise
  aliased; its `ReadWritePaths` lists both the old and the new folders until
  step 5 is done on the server.

**Switching the laptop's unit over** (done once, by hand, from the new
checkout; the daemon is down for a few seconds):

```bash
systemctl --user disable --now heyclaude.service
```

```bash
rm ~/.config/systemd/user/heyclaude.service
```

```bash
cp systemd/morgan.service ~/.config/systemd/user/ && systemctl --user daemon-reload
```

```bash
systemctl --user enable --now morgan.service
```

The old unit file has to go before enabling: the alias is made as a link named
`heyclaude.service`, which a real file of that name would block. The server is
the same with `sudo systemctl` and `/etc/systemd/system/`.

### 4. The memory key: keep finding it

`keyring.py` looks the key up by the schema `dev.heyclaude.Key` and the
attributes `service=heyclaude, kind=data-key`, and **creates a new key if it
finds none.** Changing those names without care would make a fresh key on the
next start, and everything in memory and the transcript, sealed with the old
one, would no longer open.

So: **leave the schema and attributes as they are.** They are never shown to
anyone, and a name in a keyring is not worth the risk. If Jeff wants them
renamed all the same, the change is: look up the new name; if absent, look up
the old one and store a copy under the new name, leaving the old in place; and
create a key only if neither exists. Before trying it, `heyclaude key export`
and keep the line somewhere safe.

The server's key is a file, `data/memory.key`, and does not move.

### 5. The folders, moved once

On start, before anything else reads them, `env.mjs` moves each old folder to
its new place if the new one does not exist yet:

- `~/.config/heyclaude` → `~/.config/morgan`
- `~/.local/share/heyclaude` → `~/.local/share/morgan`

Each is a single `rename()` (same filesystem, so it is instant and all or
nothing; the speech models are several GB and must not be copied). Then a link
is left at the old path pointing to the new one, so an older checkout, the trial
scripts, or anything else that still says `heyclaude` keeps finding everything.
If both exist (a half-done move, or a fresh install beside an old one), nothing
is moved and the new one is used, with a line in the log saying so.

`client.json` and `mirror.json` move with their folder. Their contents name the
server and the key, not any path, so nothing in them changes. The Oracle's
Claude login (`claude/`) moves with it too; `morgan account` afterwards should
still name the personal account, and if it does not, `morgan login` puts it
back.

On the server, `data/` is inside the checkout and is not touched. Its
`~/.config/heyclaude` and `~/.local/share/heyclaude`, if any, move as above.

The links at the old paths are removed in a later release, once nothing has
used them for a while.

### 6. The window, the plugin, the docs

- The window's app id becomes `io.github.jpmoo.Morgan`: the desktop file and the
  icon are renamed, `window.py` sets the new id, and install puts them in place.
  The old `dev.heyclaude.Morgan.desktop` and its icon are deleted from
  `~/.local/share/applications` and `~/.local/share/icons` by hand (or by
  install), or the launcher shows Morgan twice. Any Hyprland window rule that
  matches the old class has to be changed at the same time.
- The Noctalia plugin keeps its id `jpmoo/morgan` (already the right name, and
  changing it would make it a different plugin to Noctalia). Its `dependencies`, description and command path change.
  Once Talaris is Morgan's face the plugin may simply be retired.
- `README.md`, `docs/*`, `tests/*`, `restart.sh`, comments and messages say
  `morgan`. `docs/deploy.md` gets the server's steps (below).

### 7. The repository

Only after Jeff's go-ahead:

- Rename `jpmoo/heyclaude` to `jpmoo/morgan` on GitHub. GitHub redirects the old
  URL for clones, fetches and the web, but `git remote set-url` on each checkout
  is still tidier.
- On the laptop, move the checkout to `~/Documents/Scripts/morgan` and leave a
  link at the old path, because the user unit's `ExecStart`,
  `~/.local/bin/heyclaude`, the plugin's link, the desktop file's `Exec=`, and
  Talaris's notes all point there. Then repoint
  each one and remove the link.
- On the server, the checkout can stay at `~/heyclaude` (only the unit names it)
  or be moved the same way, with the unit's paths changed in the same step.

## The order, for Jeff's two machines

1. Merge steps 1–6 (one release). Nothing moves until the daemon restarts.
2. **Server first**: pull, `restart.sh`, switch the system unit (step 3), add
   the `/morgan*` route in Caddy beside `/heyclaude*`. Clients keep working
   throughout: the link, the port and the keys are unchanged.
3. **Laptop**: `heyclaude key export` (kept somewhere safe), pull, switch the
   user unit (step 3). The first start moves the folders. Check
   `morgan status` names the server, `morgan log` shows no errors, and memory
   answers a question it should know.
4. Repository rename and checkout move (step 7), when convenient.
5. A later release drops `heyclaude.sock` (protocol 2.0), the `HEYCLAUDE_*`
   fallbacks, the `heyclaude` command link and the old-path links.

## Going back

Until step 5's folders have moved, going back is checking out the old commit and
restarting. After they have, the old code still works through the links left at
the old paths, and the alias means `heyclaude.service` still names the running
unit. To undo the move outright: stop the service, remove the link, and rename
each folder back.

## Decisions for Jeff

- **The app id.** `io.github.jpmoo.Morgan` follows the convention for projects
  hosted on GitHub with no domain of their own. If there is a domain Talaris and
  Morgan will share, that is better, and should match whatever Talaris uses.
- **The environment prefix.** `MORGAN_` is short and plain; it is also a common
  word, so a clash is possible, if unlikely. `MORGAN_ASSISTANT_` is the safer and
  uglier alternative.
- **When the old names stop working.** Proposed: one release after both
  machines and Talaris have moved, with the protocol going to 2.0 then.
- **The keyring entry.** Proposed: never renamed (step 4).

## Also found

`noctalia/plugin.toml` says `license = "MIT"`, while the repository is now
GPL-3.0-only. Either the plugin is meant to be MIT (if Noctalia's plugin
registry asks for it, say), in which case the README and `CONTRIBUTING.md`
should say that folder is an exception, or the line should read `GPL-3.0-only`.
