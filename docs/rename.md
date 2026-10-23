# Renaming heyclaude to heymorgan

**Carried out on 2026-10-23,** with Jeff's go-ahead ("Do the rename plan"):
steps 1–7 in one change, the laptop switched over the same day. The server is
switched by hand, with the commands in `docs/deploy.md` ("Switching from
heyclaude"). What is left is "The order", item 5: a later release that drops
the old names.

Jeff took the proposals below as they stand: **heymorgan** for every name a
machine reads, the app id `io.github.jpmoo.heymorgan`, the keyring entry left as
it is, and the old names kept for one release. The plan is kept as it was
written, as the record of why.

The assistant is called Morgan; the code has been `heyclaude` throughout.
Talaris is about to depend on Morgan (its face is Talaris's; its brain stays
here), and the names Talaris builds against should be the lasting ones. So the
rest of the rename comes before Talaris writes code against the socket, or very
soon after.

## Which name: heymorgan, not morgan

With the repository and folder called heymorgan, the proposal is that every name
a machine reads (command, unit, socket, folders, environment, package) becomes
**heymorgan** too, and **Morgan** stays the name people see (the assistant, the
window's title, the plugin's label):

- **One name for the project.** The repository, the folder, the command, the
  unit, the socket and the folders all say the same thing; nothing has to be
  remembered as "the repo is X but the service is Y".
- **It is distinctive.** `morgan` is a common word and a common name: a
  `MORGAN_DEBUG` or `~/.config/morgan` belonging to something else is
  conceivable; `HEYMORGAN_*` and `~/.config/heymorgan` are not.
- **It reads as the wake phrase,** "Hey Morgan", as heyclaude did.
- **The change is mechanical:** `heyclaude` → `heymorgan`, `HEYCLAUDE_` →
  `HEYMORGAN_`, so it is easy to do completely and to check (`grep -ri
  heyclaude` should find only the deliberate fallbacks).

The cost is a longer command to type. A `morgan` link to the command is cheap
to add for typing, if Jeff wants one; nothing would depend on it.

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
| GitHub repository | `jpmoo/heyclaude` | `jpmoo/heymorgan` (**decided**; GitHub redirects the old URL) |
| Laptop checkout | `~/Documents/Scripts/heyclaude` | `~/Documents/Scripts/heymorgan` (**decided**) |
| Command | `bin/heyclaude` → `~/.local/bin/heyclaude` | `bin/heymorgan` → `~/.local/bin/heymorgan`; `heyclaude` kept as a link to it |
| User unit (laptop) | `heyclaude.service` | `heymorgan.service`, with `Alias=heyclaude.service` |
| System unit (server) | `systemd/heyclaude-server.service`, installed as `heyclaude.service` | `systemd/heymorgan-server.service`, installed as `heymorgan.service`, same alias |
| Command socket | `$XDG_RUNTIME_DIR/heyclaude.sock` | `$XDG_RUNTIME_DIR/heymorgan.sock`; `heyclaude.sock` also answered for a while |
| Kokoro helper socket | `heyclaude-tts.sock` | `heymorgan-tts.sock` (private; no transition needed) |
| Server's own socket | `data/heyclaude.sock` | `data/heymorgan.sock` |
| Settings and logins | `~/.config/heyclaude/` | `~/.config/heymorgan/` |
| Models, memory, history | `~/.local/share/heyclaude/` | `~/.local/share/heymorgan/` |
| Client file | `~/.config/heyclaude/client.json` | `~/.config/heymorgan/client.json` (same contents; the name `client.json` stays) |
| Environment | `HEYCLAUDE_*` (below) | `HEYMORGAN_*`, with `HEYCLAUDE_*` still read |
| Keyring entry | schema `dev.heyclaude.Key`, `service=heyclaude` | **unchanged**, or copied once: see step 4 |
| App id (window) | `dev.heyclaude.Morgan` | `io.github.jpmoo.heymorgan` (see Decisions) |
| Noctalia plugin | `jpmoo/morgan`, depends on `heyclaude` | id unchanged; depends on `heymorgan`; calls `~/.local/bin/heymorgan` |
| npm package name | `heyclaude` | `heymorgan` |
| MCP client name | `heyclaude` 0.1 | `heymorgan` |
| PipeWire nodes | `heyclaude.mic`, `heyclaude.ec.capture` | `heymorgan.mic`, `heymorgan.ec.capture` (the description shown in sound settings can say "Morgan microphone") |
| Temporary files | `heyclaude-*.wav`, `-look-`, `-keep-`, `-view-`, `-keywords-` | `heymorgan-*` |
| Window's single-instance name | `heyclaude-window`, `heyclaude-window-trial` | `heymorgan-window`, `heymorgan-window-trial` |
| Caddy route | `/heyclaude*` → 8790 | `/heymorgan*` added beside it; `/heyclaude*` kept |
| Access keys | `hc_…` | **unchanged**: issued keys stay valid, and new ones keep the prefix |

The environment variables, each read as `HEYMORGAN_X ?? HEYCLAUDE_X`:
`ROLE`, `CONFIG`, `CLIENT_FILE`, `MIRROR`, `DATA`, `MEMORY`, `KEY_FILE`,
`SOCKET`, `DEBUG`, `TRIALRUN`, and the window's `WINDOW_OPEN`, `WINDOW_RUN`,
`WINDOW_SETTLE`, `WINDOW_SHOT`, `WINDOW_WAIT`. `PORT` and `HOST` are not
prefixed and do not change.

## The steps

Each step is one commit, and leaves both the laptop and the server working.
Step 7 (the repository and folder) is independent of the others and is being
done first.

### 1. Read both names (code only, nothing moves)

- One helper in `env.mjs`, `setting("ROLE")`, that returns `HEYMORGAN_ROLE` or
  else `HEYCLAUDE_ROLE`; every `process.env.HEYCLAUDE_*` read goes through it.
  `window.py` and the test scripts get the same fallback.
- One place for the paths: `CONFIG_HOME` and the data folder are defined once (in
  `lib.mjs`) and used everywhere. Today `daemon.mjs`, `speaker.mjs`, `wake.mjs`,
  `kokoro.mjs` and `settings.mjs` each build `~/.local/share/heyclaude` for
  themselves; they import it instead.
- Paths resolve to `~/.config/heymorgan` if it exists, otherwise
  `~/.config/heyclaude`; likewise for `~/.local/share`. Nothing is moved yet.

After this commit, nothing has changed on disk and both names are honored.

### 2. Answer on both sockets

The daemon listens on `heymorgan.sock` and also on `heyclaude.sock` (two
listeners, one handler; both deleted on shutdown). Clients — `bin/`,
`window.py`, the Noctalia plugin — try `heymorgan.sock` first and fall back to
`heyclaude.sock`. `docs/protocol.md` goes to **1.1**: the new path is added, the
old one is documented as deprecated. Talaris is told to use `heymorgan.sock`
from the start.

Dropping `heyclaude.sock` later is a breaking change, and makes the protocol
**2.0**.

### 3. The command and the units

- `bin/heymorgan` is the command; `bin/heyclaude` becomes a link to it, so
  `~/.local/bin/heyclaude` keeps working, and with it the Escape binding the
  daemon sets in Hyprland and any script Jeff has.
- The Escape binding, the hotkey, and the plugin's calls switch to
  `~/.local/bin/heymorgan`. Install adds that link.
- `systemd/heymorgan.service` replaces `heyclaude.service`, with
  `[Install] Alias=heyclaude.service`, so `systemctl --user restart heyclaude`
  (and the code that still says it, on an older checkout) reaches the same
  unit. Its `ExecStart` names `%h/Documents/Scripts/heymorgan`. The code that
  restarts the daemon (`lib.mjs`'s `restartDaemon`, `daemon.mjs`'s
  `restartSoon`, `restart.sh`) says `heymorgan.service`, and `restart.sh` looks
  for either name.
- `systemd/heymorgan-server.service` replaces `heyclaude-server.service`,
  likewise aliased; its `ReadWritePaths` lists both the old and the new folders
  until step 5 is done on the server.

**Switching the laptop's unit over** (done once, by hand, from the checkout; the
daemon is down for a few seconds):

```bash
systemctl --user disable --now heyclaude.service
```

```bash
rm ~/.config/systemd/user/heyclaude.service
```

```bash
cp systemd/heymorgan.service ~/.config/systemd/user/ && systemctl --user daemon-reload
```

```bash
systemctl --user enable --now heymorgan.service
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

- `~/.config/heyclaude` → `~/.config/heymorgan`
- `~/.local/share/heyclaude` → `~/.local/share/heymorgan`

Each is a single `rename()` (same filesystem, so it is instant and all or
nothing; the speech models are several GB and must not be copied). Then a link
is left at the old path pointing to the new one, so an older checkout, the trial
scripts, or anything else that still says `heyclaude` keeps finding everything.
If both exist (a half-done move, or a fresh install beside an old one), nothing
is moved and the new one is used, with a line in the log saying so.

`client.json` and `mirror.json` move with their folder. Neither holds a path
into Morgan's own folders, so nothing in them changes. The Oracle's Claude login
(`claude/`) moves with it too; `heymorgan account` afterwards should still name
the personal account, and if it does not, `heymorgan login` puts it back.

On the server, `data/` is inside the checkout and is not touched. Its
`~/.config/heyclaude` and `~/.local/share/heyclaude`, if any, move as above.

The links at the old paths are removed in a later release, once nothing has
used them for a while.

### 6. The window, the plugin, the docs

- The window's app id becomes `io.github.jpmoo.heymorgan`: the desktop file and
  the icon are renamed, `window.py` sets the new id, and install puts them in
  place. The old `dev.heyclaude.Morgan.desktop` and its icon are deleted from
  `~/.local/share/applications` and `~/.local/share/icons` by hand (or by
  install), or the launcher shows Morgan twice. Any Hyprland window rule that
  matches the old class has to be changed at the same time. The desktop file's
  `Name=` stays Morgan.
- The Noctalia plugin keeps its id `jpmoo/morgan` (changing it would make it a
  different plugin to Noctalia). Its `dependencies`, description and command
  path change. Once Talaris is Morgan's face the plugin may simply be retired.
- `README.md`, `docs/*`, `tests/*`, `restart.sh`, comments and messages say
  `heymorgan`. `docs/deploy.md` gets the server's steps (below).

### 7. The repository and the folder (decided; done separately)

- **The GitHub repository** `jpmoo/heyclaude` → `jpmoo/heymorgan`. GitHub
  redirects the old URL for clones, fetches, pushes and the web; each checkout's
  `origin` is pointed at the new URL all the same (`git remote set-url origin
  https://github.com/jpmoo/heymorgan.git`), the server's included.
- **The laptop's checkout** `~/Documents/Scripts/heyclaude` →
  `~/Documents/Scripts/heymorgan`. These point into it and are repointed in the
  same move: `heyclaude.service`'s `ExecStart` (then `daemon-reload` and a
  restart), the `~/.local/bin/heyclaude` link, the
  `~/.local/share/noctalia/plugins/morgan` link, and
  `dev.heyclaude.Morgan.desktop`'s `Exec=` (both the repository's copy in
  `window/` and the installed one). Also: the path in the README's "The unit
  file assumes…" line, `docs/deploy.md` (`git clone …/heyclaude.git`), and
  Talaris's `DESIGN.md`, which names the repository and the socket.
- **The server's checkout** can stay at `~/heyclaude` (only its unit names it)
  or be moved the same way, with the unit's paths and `ReadWritePaths` changed
  in the same step.

## The order, for Jeff's two machines

1. Repository and folder (step 7): being done now.
2. Merge steps 1–6 (one release). Nothing moves until the daemon restarts.
3. **Server first**: pull, `restart.sh`, switch the system unit (step 3), add
   the `/heymorgan*` route in Caddy beside `/heyclaude*`. Clients keep working
   throughout: the link, the port and the keys are unchanged.
4. **Laptop**: `heyclaude key export` (kept somewhere safe), pull, switch the
   user unit (step 3). The first start moves the folders. Check
   `heymorgan status` names the server, `heymorgan log` shows no errors, and
   memory answers a question it should know.
5. A later release drops `heyclaude.sock` (protocol 2.0), the `HEYCLAUDE_*`
   fallbacks, the `heyclaude` command link and the old-path links.

## Going back

Until step 5's folders have moved, going back is checking out the old commit and
restarting. After they have, the old code still works through the links left at
the old paths, and the alias means `heyclaude.service` still names the running
unit. To undo the move outright: stop the service, remove the link, and rename
each folder back.

## Decisions for Jeff

- **heymorgan or morgan** for the command, unit, socket, folders and
  environment. Proposed: heymorgan, for the reasons above; optionally a
  `morgan` link to the command for typing.
- **The app id.** `io.github.jpmoo.heymorgan` follows the convention for
  projects hosted on GitHub with no domain of their own, and matches the
  repository. If there is a domain Talaris and Morgan will share, that is better,
  and should match whatever Talaris uses.
- **When the old names stop working.** Proposed: one release after both
  machines and Talaris have moved, with the protocol going to 2.0 then.
- **The keyring entry.** Proposed: never renamed (step 4).

## Also found

`noctalia/plugin.toml` says `license = "MIT"`, while the repository is now
GPL-3.0-only. Either the plugin is meant to be MIT (if Noctalia's plugin
registry asks for it, say), in which case the README and `CONTRIBUTING.md`
should say that folder is an exception, or the line should read `GPL-3.0-only`.
