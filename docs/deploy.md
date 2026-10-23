# Putting Morgan's brain on the home server

Step by step, with the laptop as the first client. The plan behind it is in
[server-and-satellites.md](server-and-satellites.md).

On the server, `heymorgan` means `./bin/heymorgan` run from the checkout: it
reads the checkout's `.env`, so it talks to the server and not to anything else.

## 1. The checkout

Beside the other web apps, as the account they run under:

```bash
git clone https://github.com/jpmoo/heymorgan.git
```

```bash
cd heymorgan && npm ci && cp .env.example .env
```

`.env` holds only the port (8790) and the address to listen on. Its presence is
what makes this checkout the server; everything Morgan keeps goes in `data/`.

## 2. Claude, for the Oracle

Install Claude Code for the account, as on the laptop, so that `claude` is on
its path. Then log the Oracle in, with its own login kept apart from anything
else on the machine:

```bash
./bin/heymorgan login
```

On a machine with no browser it prints a link to open elsewhere and asks for the
code it shows. `./bin/heymorgan account` should then name the personal account.

## 3. What Morgan knows, moved from the laptop

On the laptop, stop Morgan so nothing changes while it is copied:

```bash
systemctl --user stop heymorgan
```

Then copy memory, the transcript and the settings across (`home-server` and the
checkout path are yours to fill in):

```bash
rsync -a ~/.local/share/heymorgan/memory/ home-server:heymorgan/data/memory/
```

```bash
rsync -a ~/.local/share/heymorgan/history/ home-server:heymorgan/data/memory/history/
```

```bash
scp ~/.config/heymorgan/config.json home-server:heymorgan/data/config.json
```

Then the key that unlocks it all. On the laptop:

```bash
heymorgan key export
```

and on the server, pasting that one line when asked:

```bash
./bin/heymorgan key import
```

It is kept in `data/memory.key`, readable only by the account. Nothing on the
laptop is deleted; it stays as it was, for running Morgan there again.

## 4. The service

Copy `systemd/heymorgan-server.service` to
`/etc/systemd/system/heymorgan.service`, fill in the account and the checkout
path where it says, then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now heymorgan
```

```bash
journalctl -u heymorgan -n 20 --no-pager
```

It should say it is serving clients on port 8790 and that HermesNotes is
connected. From now on `./restart.sh` in the checkout updates it, as with the
other apps.

## 5. Reaching it from away (optional)

In the Caddyfile's `:8083` site, before its catch-all `handle`:

```caddy
  handle_path /heymorgan* {
    reverse_proxy 127.0.0.1:8790
  }
  # Morgan's address before the rename, kept for clients set up with it.
  handle_path /heyclaude* {
    reverse_proxy 127.0.0.1:8790
  }
```

At home the laptop goes straight to `home-server:8790` and doesn't need this.

## 6. A key for the laptop

On the server:

```bash
./bin/heymorgan access add laptop
```

It prints the key once, as a `heymorgan connect` line to run on the laptop. The
server keeps only its hash; `./bin/heymorgan access list` shows the keys and
when each was last used, and `./bin/heymorgan access remove laptop` cuts one off.

## 7. The laptop as a client

On the laptop, with the line the server printed (or the same in Settings →
Connections → "Where Morgan lives"):

```bash
heymorgan connect home-server:8790 hc_… laptop
```

```bash
heymorgan status
```

`status` should say `"role":"client"` with the server's address. The plugin, the
window and voice work as before; the answers now come from the server.

To go back to running everything on the laptop:

```bash
heymorgan disconnect
```

## Updating the server

On the server, in the checkout:

```bash
./restart.sh
```

It pulls, reinstalls, checks and restarts the service (asking for your sudo
password), and brings the old version back up if any step fails. Restart the
laptop's Morgan afterwards so both sides match: `systemctl --user restart heymorgan`.

## Switching from heyclaude (once, 2026-10-23)

Morgan's code was called heyclaude until 2026-10-23 (`docs/rename.md`). A server
installed before then has `/etc/systemd/system/heyclaude.service`; it is
switched over once, in this order, from the checkout. Clients keep working
throughout: the port, the keys and the memory key file do not change.

Point the checkout at the renamed repository:

```bash
git remote set-url origin https://github.com/jpmoo/heymorgan.git
```

Update and restart it, still under the old unit. The first start moves
`~/.config/heyclaude` and `~/.local/share/heyclaude`, if there are any, to
`heymorgan`, leaving links behind:

```bash
./restart.sh
```

Look at the unit before changing it: `[Install]` should be its last section.

```bash
cat /etc/systemd/system/heyclaude.service
```

Stop the old unit, rename it, and give it its new description, the folders it
may write (the parents, since the first start moves folders there) and the old
name as an alias:

```bash
sudo systemctl disable --now heyclaude.service
```

```bash
sudo mv /etc/systemd/system/heyclaude.service /etc/systemd/system/heymorgan.service
```

```bash
sudo sed -i -e "s|^Description=.*|Description=heymorgan — Morgan's brain, serving its clients|" -e "s|^ReadWritePaths=.*|ReadWritePaths=$PWD -$HOME/.config -$HOME/.local/share|" -e '$a Alias=heyclaude.service' /etc/systemd/system/heymorgan.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now heymorgan.service
```

If `sudo -l` lists a rule for `systemctl restart heyclaude.service` without a
password, add the same for `heymorgan.service`: settings that need a restart
ask for it under the new name.

In the Caddyfile, add the `/heymorgan*` route beside `/heyclaude*` (section 5)
and reload Caddy.

Then check:

```bash
systemctl status heymorgan --no-pager
```

```bash
journalctl -u heymorgan -n 30 --no-pager
```

It should be active, with `heymorgan serving clients on port 8790` in the log,
a `home: connected` line in the laptop's log (`heymorgan log`), and
`./bin/heymorgan status` answering on the server.

## As a client

Looking at the laptop's screen, clipboard or camera, and finding, listing and
reading files in its folders, are done by the laptop when the server asks for
them; the server does the describing and the thinking. Attaching a file to a
message works too: the laptop reads it and sends what it holds.
