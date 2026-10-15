// Which part this copy of Morgan plays, settled before anything else looks.
//
//   local   the whole of Morgan on this machine (the laptop, as it has been)
//   server  the brain only, on the home server: no microphone, no desktop; it
//           listens on PORT for clients, and keeps its data in the checkout's
//           data/ folder
//   client  ears and mouth only: it hands what is said to a server and speaks
//           what comes back; the plugin, the window and the command talk to it
//           as they always have
//
// A .env in the checkout giving PORT makes a server, as the other apps on the
// home server are configured. A ~/.config/heyclaude/client.json naming a
// server makes a client. HEYCLAUDE_ROLE says outright, for trials.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

// A configuration named outright is a trial run beside the real one (see tests/trial.sh).
export const TRIAL = Boolean(process.env.HEYCLAUDE_CONFIG);

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split("\n")) {
    const found = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (found && !(found[1] in process.env)) process.env[found[1]] = found[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

export const CLIENT_FILE = process.env.HEYCLAUDE_CLIENT_FILE ?? join(homedir(), ".config", "heyclaude", "client.json");
let client = {};
try { client = JSON.parse(readFileSync(CLIENT_FILE, "utf8")); } catch { /* none: not a client */ }
// { server: "host:port" or "https://host/heyclaude", key: "hc_..." }
export const CLIENT = client;

export const ROLE = process.env.HEYCLAUDE_ROLE ?? (process.env.PORT ? "server" : client.server ? "client" : "local");

// A client's settings are the server's, mirrored here as they change; the
// laptop's own config.json is left as it was, for running Morgan locally again.
export const MIRROR = process.env.HEYCLAUDE_MIRROR ?? join(homedir(), ".config", "heyclaude", "mirror.json");
if (ROLE === "client" && existsSync(MIRROR)) process.env.HEYCLAUDE_CONFIG ??= MIRROR;

if (ROLE === "server") {
  const data = process.env.HEYCLAUDE_DATA ?? join(ROOT, "data");
  process.env.HEYCLAUDE_DATA = data;
  process.env.HEYCLAUDE_CONFIG ??= join(data, "config.json");
  process.env.HEYCLAUDE_MEMORY ??= join(data, "memory");
  // The memory key, which on the laptop is in the login keyring; a server has none.
  process.env.HEYCLAUDE_KEY_FILE ??= join(data, "memory.key");
  // The server's own command socket, for `heyclaude` run on the server.
  process.env.HEYCLAUDE_SOCKET ??= join(data, "heyclaude.sock");
}
