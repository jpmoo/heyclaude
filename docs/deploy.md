# Putting Morgan's brain on the home server

Step by step, with the laptop as the first client. The plan behind it is in
[server-and-satellites.md](server-and-satellites.md).

On the server, `heyclaude` means `./bin/heyclaude` run from the checkout: it
reads the checkout's `.env`, so it talks to the server and not to anything else.

## 1. The checkout

Beside the other web apps, as the account they run under:

```bash
git clone https://github.com/jpmoo/heyclaude.git
```

```bash
cd heyclaude && npm ci && cp .env.example .env
```

`.env` holds only the port (8790) and the address to listen on. Its presence is
what makes this checkout the server; everything Morgan keeps goes in `data/`.

## 2. Claude, for the Oracle

Install Claude Code for the account, as on the laptop, so that `claude` is on
its path. Then log the Oracle in, with its own login kept apart from anything
else on the machine:

```bash
./bin/heyclaude login
```

On a machine with no browser it prints a link to open elsewhere and asks for the
code it shows. `./bin/heyclaude account` should then name the personal account.

## 3. What Morgan knows, moved from the laptop

On the laptop, stop Morgan so nothing changes while it is copied:

```bash
systemctl --user stop heyclaude
```

Then copy memory, the transcript and the settings across (`home-server` and the
checkout path are yours to fill in):

```bash
rsync -a ~/.local/share/heyclaude/memory/ home-server:heyclaude/data/memory/
```

```bash
rsync -a ~/.local/share/heyclaude/history/ home-server:heyclaude/data/memory/history/
```

```bash
scp ~/.config/heyclaude/config.json home-server:heyclaude/data/config.json
```

Then the key that unlocks it all. On the laptop:

```bash
heyclaude key export
```

and on the server, pasting that one line when asked:

```bash
./bin/heyclaude key import
```

It is kept in `data/memory.key`, readable only by the account. Nothing on the
laptop is deleted; it stays as it was, for running Morgan there again.

## 4. The service

Copy `systemd/heyclaude-server.service` to
`/etc/systemd/system/heyclaude.service`, fill in the account and the checkout
path where it says, then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now heyclaude
```

```bash
journalctl -u heyclaude -n 20 --no-pager
```

It should say it is serving clients on port 8790 and that HermesNotes is
connected. From now on `./restart.sh` in the checkout updates it, as with the
other apps.

## 5. Reaching it from away (optional)

In the Caddyfile's `:8083` site, before its catch-all `handle`:

```caddy
  handle_path /heyclaude* {
    reverse_proxy 127.0.0.1:8790
  }
```

At home the laptop goes straight to `home-server:8790` and doesn't need this.

## 6. A key for the laptop

On the server:

```bash
./bin/heyclaude access add laptop
```

It prints the key once, as a `heyclaude connect` line to run on the laptop. The
server keeps only its hash; `./bin/heyclaude access list` shows the keys and
when each was last used, and `./bin/heyclaude access remove laptop` cuts one off.

## 7. The laptop as a client

On the laptop, with the line the server printed (or the same in Settings →
Connections → "Where Morgan lives"):

```bash
heyclaude connect home-server:8790 hc_… laptop
```

```bash
heyclaude status
```

`status` should say `"role":"client"` with the server's address. The plugin, the
window and voice work as before; the answers now come from the server.

To go back to running everything on the laptop:

```bash
heyclaude disconnect
```

## Updating the server

On the server, in the checkout:

```bash
./restart.sh
```

It pulls, reinstalls, checks and restarts the service (asking for your sudo
password), and brings the old version back up if any step fails. Restart the
laptop's Morgan afterwards so both sides match: `systemctl --user restart heyclaude`.

## As a client

Looking at the laptop's screen, clipboard or camera, and finding, listing and
reading files in its folders, are done by the laptop when the server asks for
them; the server does the describing and the thinking. Attaching a file to a
message works too: the laptop reads it and sends what it holds.
