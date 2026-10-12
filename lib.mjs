// What the daemon, the command and the settings menu all need to agree on.

import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
export const CONFIG_HOME = join(HOME, ".config", "heyclaude");
export const CONFIG = process.env.HEYCLAUDE_CONFIG ?? join(CONFIG_HOME, "config.json");
export const SPEECH = join(HOME, ".local", "share", "heyclaude");
export const VOICES = join(SPEECH, "voices");
export const PIPER = join(SPEECH, "piper", "piper");
export const MEMORY = process.env.HEYCLAUDE_MEMORY ?? join(SPEECH, "memory");
export const VOICE_REPO = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

// The settings a person is expected to change, and what they start as.
export const BASICS = {
  name: "Morgan",
  // How the assistant talks, in your own words; it goes into its instructions.
  style: "Talk the way a friend would: relaxed and warm, with contractions like I'd, you're and it's, everyday words, and nothing stiff or formal.",
  ollama: { url: "http://192.168.0.244:11434", model: "qwen3.6:35b-a3b" },
  oracleModel: "sonnet",
  // Kokoro sounds more natural; Piper is lighter and starts speaking sooner.
  engine: "kokoro",
  kokoroVoice: "af_heart",
  voice: "en_US-lessac-medium",
  wakeWord: "Hey Morgan",
  followUpSeconds: 6,
  // Finds earlier conversations by meaning. Changing it re-reads the whole transcript.
  embedModel: "nomic-embed-text",
  // Opens the chat window, as Hyprland writes a key: modifiers, then the key.
  hotkey: "SUPER, grave",
  // What the assistant may look at when asked: screen, clipboard, camera.
  sight: ["screen", "clipboard", "camera"],
};

export function loadConfig() {
  return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// The Oracle's Claude login lives in its own directories, apart from any
// other Claude login on this machine.
export function oracleEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC)/.test(key)) env[key] = value;
  }
  env.ANTHROPIC_CONFIG_DIR = join(CONFIG_HOME, "anthropic");
  env.CLAUDE_CONFIG_DIR = join(CONFIG_HOME, "claude");
  return env;
}

export const KOKORO = join(SPEECH, "kokoro-multi-lang-v1_0");
// In the model's own order: a voice's place in this list is its number.
export const KOKORO_VOICES = ("af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,"
  + "am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,"
  + "bm_daniel,bm_fable,bm_george,bm_lewis").split(",");

export const voiceFile = (name) => join(VOICES, `${name}.onnx`);

export function voiceRate(name) {
  try { return JSON.parse(readFileSync(`${voiceFile(name)}.json`, "utf8")).audio.sample_rate; } catch { return 22050; }
}

// Fetch a Piper voice by name (en_US-amy-medium lives at en/en_US/amy/medium/).
// Returns an error message, or null when the voice is in place.
export function fetchVoice(name) {
  const parts = name.match(/^(([a-z]+)_[A-Z]+)-(.+)-(x_low|low|medium|high)$/);
  if (!parts) return `${name} does not look like a Piper voice name (for example en_US-amy-medium)`;
  mkdirSync(VOICES, { recursive: true });
  const base = `${VOICE_REPO}/${parts[2]}/${parts[1]}/${parts[3]}/${parts[4]}/${name}.onnx`;
  for (const suffix of ["", ".json"]) {
    const file = voiceFile(name) + suffix;
    if (existsSync(file)) continue;
    console.log(`fetching ${name}.onnx${suffix}`);
    if (spawnSync("curl", ["-fL", "--progress-bar", "-o", file, base + suffix], { stdio: "inherit" }).status !== 0) {
      rmSync(file, { force: true });
      return `could not fetch ${name}; check the name against the samples page`;
    }
  }
  return null;
}

// Speak a line in a voice, here and now, without involving the daemon.
export function previewVoice(name, text) {
  const command = `'${PIPER}' --model '${voiceFile(name)}' --output-raw 2>/dev/null`
    + ` | pw-play --raw --rate ${voiceRate(name)} --channels 1 --format s16 -`;
  spawnSync("sh", ["-c", command], { input: text + "\n", stdio: ["pipe", "ignore", "ignore"] });
}

// Memory and transcripts are encrypted at rest with a key held in the login
// keyring. Each sealed piece is base64 of nonce, tag and AES-256-GCM ciphertext.
let key = null;

export function dataKey() {
  if (key) return key;
  const script = join(dirname(fileURLToPath(import.meta.url)), "keyring.py");
  const result = spawnSync("python3", [script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`the login keyring did not give up the data key: ${result.stderr.trim().split("\n").pop()}`);
  key = Buffer.from(result.stdout.trim(), "base64");
  if (key.length !== 32) throw new Error("the data key in the login keyring is not the right size");
  return key;
}

export function seal(text) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), nonce);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

export function unseal(sealed) {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const readSealed = (file) => unseal(readFileSync(file, "utf8").trim());
export const writeSealed = (file, text) => writeFileSync(file, seal(text) + "\n", { mode: 0o600 });

// Whether the assistant is given one of an MCP server's tools: a choice made
// for that tool by name wins; otherwise the server's blanket setting decides,
// which is read-only tools unless it says all.
export const readOnly = (tool) => Boolean(tool.annotations?.readOnlyHint);
export const toolAllowed = (spec, tool) => spec.tools?.[tool.name] ?? (spec.allow === "all" || readOnly(tool));

export function restartDaemon() {
  if (process.env.HEYCLAUDE_CONFIG) return; // a trial configuration, not the service's
  spawnSync("systemctl", ["--user", "restart", "heyclaude.service"]);
}
