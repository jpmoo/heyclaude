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
// home server are configured. A ~/.config/heymorgan/client.json naming a
// server makes a client. HEYMORGAN_ROLE says outright, for trials.
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

// Morgan was heyclaude until 2026-10-23 (docs/rename.md). Its settings are
// HEYMORGAN_*, and a HEYCLAUDE_* that is still set somewhere is read as the
// same thing; everything after this reads only the new names.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("HEYCLAUDE_")) process.env[`HEYMORGAN_${name.slice("HEYCLAUDE_".length)}`] ??= value;
}

// The folders kept under the old name are moved to the new one the first time
// this runs, each with one rename (the speech models are several GB, and are
// never copied), and a link is left at the old place for anything that still
// says heyclaude. With both there, nothing is moved and the new one is used.
function folder(parent) {
  const now = join(parent, "heymorgan");
  const before = join(parent, "heyclaude");
  let old = null;
  try { old = lstatSync(before); } catch { /* never had one */ }
  if (old?.isDirectory() && !existsSync(now)) {
    try {
      renameSync(before, now);
      symlinkSync(now, before);
      console.error(`moved ${before} to ${now}`);
    } catch (error) {
      console.error(`could not move ${before} to ${now}: ${error.message}`);
    }
  } else if (old?.isDirectory()) {
    console.error(`both ${before} and ${now} are there: using ${now}, and leaving ${before} as it is`);
  }
  return existsSync(now) || !existsSync(before) ? now : before;
}

export const CONFIG_HOME = folder(join(homedir(), ".config"));
export const SHARE = folder(join(homedir(), ".local", "share"));

// A configuration named outright is a trial run beside the real one (see tests/trial.sh).
export const TRIAL = Boolean(process.env.HEYMORGAN_CONFIG);

const dotenv = join(ROOT, ".env");
if (existsSync(dotenv)) {
  for (const line of readFileSync(dotenv, "utf8").split("\n")) {
    const found = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (found && !(found[1] in process.env)) process.env[found[1]] = found[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

export const CLIENT_FILE = process.env.HEYMORGAN_CLIENT_FILE ?? join(CONFIG_HOME, "client.json");
let client = {};
try { client = JSON.parse(readFileSync(CLIENT_FILE, "utf8")); } catch { /* none: not a client */ }
// { server: "host:port" or "https://host/heymorgan", key: "hc_..." }
export const CLIENT = client;

export const ROLE = process.env.HEYMORGAN_ROLE ?? (process.env.PORT ? "server" : client.server ? "client" : "local");

// A client's settings are the server's, mirrored here as they change; the
// laptop's own config.json is left as it was, for running Morgan locally again.
export const MIRROR = process.env.HEYMORGAN_MIRROR ?? join(CONFIG_HOME, "mirror.json");
if (ROLE === "client" && existsSync(MIRROR)) process.env.HEYMORGAN_CONFIG ??= MIRROR;

if (ROLE === "server") {
  const data = process.env.HEYMORGAN_DATA ?? join(ROOT, "data");
  process.env.HEYMORGAN_DATA = data;
  process.env.HEYMORGAN_CONFIG ??= join(data, "config.json");
  process.env.HEYMORGAN_MEMORY ??= join(data, "memory");
  // The memory key, which on the laptop is in the login keyring; a server has none.
  process.env.HEYMORGAN_KEY_FILE ??= join(data, "memory.key");
  // The server's own command socket, for `heymorgan` run on the server.
  process.env.HEYMORGAN_SOCKET ??= join(data, "heymorgan.sock");
}
