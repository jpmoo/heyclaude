// heyclaude settings: numbered menus over config.json. Every change is saved
// as it is made; the daemon is restarted once, on the way out.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  BASICS, CONFIG, KOKORO, KOKORO_VOICES, MEMORY, PIPER, VOICES, VOICE_REPO,
  fetchVoice, loadConfig, oracleEnv, readOnly, toolAllowed, previewVoice, readSealed, restartDaemon, saveConfig, voiceFile, writeSealed,
} from "./lib.mjs";
import { McpClient } from "./mcp.mjs";

const PICTURES = join(MEMORY, "pictures");

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

let config = loadConfig();
let changed = false;

function save() {
  saveConfig(config);
  changed = true;
}

// ---------------------------------------------------------------- asking

// Lines are queued as they arrive, so typed-ahead and piped answers are kept.
const lines = [];
let waiting = null;
let input;

function listen() {
  // A terminal gets proper line editing: arrow keys, backspace, history.
  input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  input.on("line", (line) => {
    if (waiting) { const resolve = waiting; waiting = null; resolve(line); } else lines.push(line);
  });
  input.on("close", () => { if (waiting) { const resolve = waiting; waiting = null; resolve(null); } else lines.push(null); });
}

// `prefill` puts text on the line to be edited, where the terminal allows it.
function ask(prompt, fallback = "", prefill = "") {
  input.setPrompt(fallback ? `${prompt} ${dim(`[${fallback}]`)} ` : `${prompt} `);
  input.prompt();
  if (prefill && process.stdin.isTTY && !lines.length) input.write(prefill);
  const answer = lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => { waiting = resolve; });
  return answer.then((line) => {
    if (line === null) { process.stdout.write("\n"); finish(); }
    return line.trim() || fallback;
  });
}

// A numbered menu. Returns the chosen item's key, or null for "back".
async function menu(title, items, back = "back") {
  for (;;) {
    console.log(`\n${bold(title)}`);
    items.forEach((item, index) => console.log(`  ${String(index + 1).padStart(2)}. ${item.label}${item.value ? dim(`  ${item.value}`) : ""}`));
    console.log(`   0. ${back}`);
    const answer = await ask(">");
    if (answer === "0" || answer === "" || answer === "q") return null;
    const item = items[Number(answer) - 1];
    if (item) return item.key;
    console.log("Not one of the choices.");
  }
}

const yes = async (prompt) => /^y/i.test(await ask(`${prompt} (y/n)`, "n"));

// Hand the terminal to another program, then take it back.
function foreground(command, args, options = {}) {
  input.close();
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  listen();
  return result;
}

// ---------------------------------------------------------------- assistant

async function assistant() {
  for (;;) {
    const choice = await menu("Assistant", [
      { key: "name", label: "Its name", value: config.name ?? BASICS.name },
      { key: "user", label: "Your name", value: config.userName ?? "not set" },
      { key: "style", label: "Manner of speaking", value: config.style ?? BASICS.style },
      { key: "interview", label: "Start the orientation interview" },
      { key: "memory", label: "Memory", value: `${topicFiles().length} topics, ${documentFiles().length} documents` },
    ]);
    if (!choice) return;
    if (choice === "name") {
      const old = config.name ?? BASICS.name;
      config.name = await ask("Name:", old);
      // The wake phrase follows the name unless it was set to something else.
      if ((config.wakeWord ?? BASICS.wakeWord) === `Hey ${old}`) config.wakeWord = `Hey ${config.name}`;
      save();
    } else if (choice === "user") {
      config.userName = (await ask("What should it call you?", config.userName ?? "")) || null;
      save();
    } else if (choice === "style") {
      console.log("Describe how it should talk, in a sentence or two. Blank keeps the current wording; - goes back to the default.");
      const style = await ask("Manner:");
      if (style === "-") delete config.style;
      else if (style) config.style = style;
      save();
    } else if (choice === "interview") {
      if (changed) { restartDaemon(); changed = false; spawnSync("sleep", ["1.5"]); }
      spawnSync(process.argv[1], ["interview"], { stdio: "ignore" });
      console.log(`The interview has begun: answer aloud, or run ${bold("heyclaude chat")} to answer by typing.`);
    } else if (choice === "memory") {
      await memory();

    }
  }
}

const DOCUMENTS = join(MEMORY, "documents");
const documentFiles = () => (existsSync(DOCUMENTS) ? readdirSync(DOCUMENTS).filter((file) => file.endsWith(".document")).sort() : []);

// One kept document: read, rename or delete. The file it was copied from is
// somewhere else and is never touched.
async function documentMenu(file) {
  for (;;) {
    const kept = JSON.parse(readSealed(join(DOCUMENTS, file)));
    const choice = await menu(`${kept.title} ${dim(`kept ${new Date(kept.t).toLocaleDateString()} from ${kept.source}`)}`, [
      { key: "view", label: "Read it" }, { key: "rename", label: "Rename it" }, { key: "delete", label: "Delete it" },
    ]);
    if (!choice) return;
    if (choice === "view") console.log(`\n${kept.text.trim()}`);
    if (choice === "rename") {
      const title = await ask("Title:", kept.title, kept.title);
      if (!title || title === kept.title) continue;
      const renamed = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}.document`;
      rmSync(join(DOCUMENTS, file));
      writeSealed(join(DOCUMENTS, renamed), JSON.stringify({ ...kept, title }));
      file = renamed;
    }
    if (choice === "delete") {
      rmSync(join(DOCUMENTS, file));
      console.log(`Deleted from memory. The original at ${kept.source} is untouched.`);
      return;
    }
  }
}

const topicFiles = () => (existsSync(MEMORY) ? readdirSync(MEMORY).filter((file) => file.endsWith(".topic")).sort() : []);

// A topic file is its name, its description, a blank line, then "- note" lines.
function readTopic(file) {
  const [title = "", description = "", ...rest] = readSealed(join(MEMORY, file)).split("\n");
  return { name: title.replace(/^#\s*/, ""), description, notes: rest.filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) };
}

function writeTopic(file, topic) {
  writeSealed(join(MEMORY, file), [`# ${topic.name}`, topic.description, "", ...topic.notes.map((note) => `- ${note}`), ""].join("\n"));
}

// Everything kept about the user in one place: topics of notes, whole
// documents, and pictures.
async function memory() {
  for (;;) {
    const files = topicFiles();
    const documents = documentFiles();
    const pictures = existsSync(PICTURES) ? readdirSync(PICTURES).filter((file) => file.endsWith(".picture")) : [];
    if (!files.length && !documents.length && !pictures.length) return console.log("Nothing is remembered yet.");
    const file = await menu(`Memory ${dim(MEMORY)}`, [
      ...files.map((name) => {
        const topic = readTopic(name);
        return { key: name, label: topic.name, value: `${topic.notes.length} notes` };
      }),
      ...documents.map((name) => {
        const kept = JSON.parse(readSealed(join(DOCUMENTS, name)));
        return { key: `document:${name}`, label: kept.title, value: `whole document, ${kept.text.length} characters, from ${kept.source}` };
      }),
      ...(pictures.length ? [{ key: "pictures", label: "Pictures", value: `${pictures.length} kept for recognising people and things` }] : []),
    ]);
    if (!file) return;
    if (file === "pictures") await sightMenu();
    else if (file.startsWith("document:")) await documentMenu(file.slice(9));
    else await topicMenu(file);
  }
}

async function topicMenu(file) {
  for (;;) {
    const topic = readTopic(file);
    const choice = await menu(`${topic.name} ${dim(topic.description)}`, [
      ...topic.notes.map((note, index) => ({ key: `note:${index}`, label: note })),
      { key: "add", label: dim("Add a note") },
      { key: "describe", label: dim("Change the name or description") },
      { key: "delete", label: dim("Delete the whole topic") },
    ]);
    if (!choice) return;
    if (choice === "add") {
      const note = await ask("New note:");
      if (note) topic.notes.push(note);
    } else if (choice === "describe") {
      topic.name = await ask("Name:", topic.name);
      topic.description = await ask("What belongs in it:", topic.description);
    } else if (choice === "delete") {
      if (await yes(`Delete ${topic.name} and its ${topic.notes.length} notes?`)) { rmSync(join(MEMORY, file)); return; }
      continue;
    } else {
      const index = Number(choice.slice(5));
      const what = await menu(topic.notes[index], [
        { key: "edit", label: "Edit" }, { key: "move", label: "Move to another topic" }, { key: "delete", label: "Delete" },
      ]);
      if (what === "move") {
        const to = await menu("Move to", topicFiles().filter((name) => name !== file).map((name) => ({ key: name, label: readTopic(name).name })));
        if (!to) continue;
        const target = readTopic(to);
        target.notes.push(topic.notes[index]);
        writeTopic(to, target);
        topic.notes.splice(index, 1);
      } else if (what === "delete") {
        topic.notes.splice(index, 1);
      } else if (what === "edit") {
        const text = await ask("Edit the note:\n", "", topic.notes[index]);
        if (!text || text === topic.notes[index]) continue;
        topic.notes[index] = text;
      } else continue;
    }
    writeTopic(file, topic);
  }
}

// ---------------------------------------------------------------- Ollama

const ollama = () => ({ ...BASICS.ollama, ...config.ollama });

async function ollamaModels(url) {
  const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).models
    .filter((model) => !/embed|bert/i.test(model.name))
    .map((model) => ({ name: model.name, size: `${(model.size / 1e9).toFixed(1)} GB` }));
}

async function ollamaMenu() {
  for (;;) {
    const choice = await menu("Ollama", [
      { key: "url", label: "Server", value: ollama().url },
      { key: "model", label: "Model", value: ollama().model },
      { key: "embed", label: "Embedding model", value: config.embedModel ?? BASICS.embedModel },
      { key: "test", label: "Test" },
    ]);
    if (!choice) return;
    if (choice === "url") {
      const url = (await ask("Server address:", ollama().url)).replace(/\/+$/, "");
      try {
        const models = await ollamaModels(url);
        console.log(`Reached it: ${models.length} chat models.`);
        config.ollama = { ...config.ollama, url };
        save();
      } catch (error) {
        console.log(`Could not reach ${url}: ${error.message}`);
        if (await yes("Keep it anyway?")) { config.ollama = { ...config.ollama, url }; save(); }
      }
    } else if (choice === "model") {
      try {
        const models = await ollamaModels(ollama().url);
        const model = await menu("Models on the server", models.map((entry) => ({ key: entry.name, label: entry.name, value: entry.size })));
        if (model) { config.ollama = { ...config.ollama, model }; save(); }
      } catch (error) {
        console.log(`Could not list models: ${error.message}`);
      }
    } else if (choice === "embed") {
      try {
        const response = await fetch(`${ollama().url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        const models = (await response.json()).models.map((model) => model.name).sort();
        // Embedding models first; the rest are listed because a name does not always say.
        const likely = (name) => /embed|bert|bge|e5|minilm/i.test(name);
        const model = await menu("Embedding model", [...models.filter(likely), ...models.filter((name) => !likely(name))].map((name) => ({
          key: name, label: name, value: likely(name) ? "" : "probably not an embedding model",
        })));
        if (!model) continue;
        const probe = await fetch(`${ollama().url}/api/embed`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({ model, input: ["hello"] }),
        });
        const size = probe.ok ? (await probe.json()).embeddings?.[0]?.length : 0;
        if (!size) { console.log(`${model} did not return an embedding, so it was not chosen.`); continue; }
        config.embedModel = model.replace(/:latest$/, "");
        save();
        console.log(`${model} it is (${size} numbers per passage). Every past exchange is re-read with it when the assistant restarts.`);
        console.log("A different model scores differently, so automatic recall may bring back too much or too little until the threshold is retuned.");
      } catch (error) {
        console.log(`Could not list models: ${error.message}`);
      }
    } else if (choice === "test") {
      await ollamaTest();
    }
  }
}

async function ollamaTest() {
  const { url, model } = ollama();
  process.stdout.write(`Asking ${model} to say hello... `);
  const started = Date.now();
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model, stream: false, think: false,
        messages: [{ role: "user", content: "Say hello in five words or fewer." }],
        // The daemon needs tool calling; a model without it fails here, not later.
        tools: [{ type: "function", function: { name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} } } }],
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    console.log(`"${body.message.content.trim()}" in ${((Date.now() - started) / 1000).toFixed(1)}s. Tool calling is supported.`);
  } catch (error) {
    console.log(`failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------- the Oracle

function oracleAccount() {
  const result = spawnSync("claude", ["auth", "status"], { env: oracleEnv(), encoding: "utf8" });
  try {
    const status = JSON.parse(result.stdout);
    return status.loggedIn ? `${status.email ?? "logged in"} (${status.subscriptionType ?? status.authMethod})` : "not logged in";
  } catch {
    return "claude is not installed or did not answer";
  }
}

async function oracleMenu() {
  for (;;) {
    const choice = await menu("The Oracle (Claude)", [
      { key: "login", label: "Log in", value: oracleAccount() },
      { key: "logout", label: "Log out" },
      { key: "model", label: "Model", value: config.oracle?.model ?? BASICS.oracleModel },
    ]);
    if (!choice) return;
    if (choice === "login") {
      console.log("This login is the Oracle's own; any other Claude login on this machine is left alone.");
      foreground("claude", ["auth", "login", "--claudeai"], { env: oracleEnv() });
      changed = true;
    } else if (choice === "logout") {
      if (await yes("Log the Oracle out?")) { foreground("claude", ["auth", "logout"], { env: oracleEnv() }); changed = true; }
    } else if (choice === "model") {
      const model = await menu("Model", [
        { key: "haiku", label: "haiku", value: "fastest" },
        { key: "sonnet", label: "sonnet", value: "balanced" },
        { key: "opus", label: "opus", value: "most capable, uses the most of your plan" },
      ]);
      if (model) { config.oracle = { ...config.oracle, model }; save(); }
    }
  }
}

// ---------------------------------------------------------------- voices

const installedVoices = () => (existsSync(VOICES) ? readdirSync(VOICES).filter((file) => file.endsWith(".onnx")).map((file) => file.slice(0, -5)).sort() : []);
const currentVoice = () => config.voice ?? BASICS.voice;
const haveKokoro = () => existsSync(join(KOKORO, "model.onnx"));
const engine = () => (haveKokoro() ? config.engine ?? BASICS.engine : "piper");
const kokoroVoice = () => config.kokoroVoice ?? BASICS.kokoroVoice;

// af_heart: a for American or b for British, f or m for a woman's or a man's voice.
function kokoroLabel(name) {
  const [kind, who] = name.split("_");
  return `${who[0].toUpperCase()}${who.slice(1)}  ${dim(`${kind[0] === "a" ? "American" : "British"} ${kind[1] === "f" ? "woman" : "man"}`)}`;
}

function previewKokoro(name) {
  const script = join(import.meta.dirname, "kokoro.mjs");
  spawnSync("node", [script, "--say", String(KOKORO_VOICES.indexOf(name)), String(config.kokoroSpeed ?? 1), sample()], { stdio: "ignore" });
}

async function kokoroMenu() {
  for (;;) {
    const name = await menu("Kokoro voices", KOKORO_VOICES.map((voice) => ({
      key: voice, label: kokoroLabel(voice), value: voice === kokoroVoice() ? "current" : "",
    })));
    if (!name) return;
    for (;;) {
      console.log(`Playing ${name}...`);
      previewKokoro(name);
      const choice = await menu(name, [{ key: "use", label: "Use this voice" }, { key: "again", label: "Play it again" }]);
      if (choice === "again") continue;
      if (choice === "use") { config.kokoroVoice = name; config.engine = "kokoro"; save(); }
      break;
    }
  }
}
const sample = () => `Hello, I am ${config.name ?? BASICS.name}. This is how I would sound.`;

async function voiceMenu() {
  if (!existsSync(PIPER) && !haveKokoro()) return console.log("No speech engine is installed, so there are no voices to choose.");
  for (;;) {
    const choice = await menu("Voice", [
      ...(haveKokoro() ? [
        { key: "engine", label: "Engine", value: engine() === "kokoro" ? "Kokoro (more natural)" : "Piper (lighter, quicker to start)" },
        { key: "kokoro", label: "Kokoro: choose a voice", value: kokoroVoice() },
        { key: "speed", label: "Kokoro: speaking speed", value: String(config.kokoroSpeed ?? 1) },
      ] : []),
      { key: "installed", label: "Piper: choose from installed voices", value: currentVoice() },
      { key: "browse", label: "Piper: browse and download more" },
      { key: "name", label: "Piper: download by name" },
    ]);
    if (!choice) return;
    if (choice === "engine") { config.engine = engine() === "kokoro" ? "piper" : "kokoro"; save(); }
    if (choice === "kokoro") await kokoroMenu();
    if (choice === "speed") {
      config.kokoroSpeed = Math.min(1.6, Math.max(0.6, Number(await ask("Speed, where 1 is normal (0.6 to 1.6):", String(config.kokoroSpeed ?? 1))) || 1));
      save();
    }
    if (choice === "installed") {
      const name = await menu("Installed voices", installedVoices().map((voice) => ({
        key: voice, label: voice, value: voice === currentVoice() ? "current" : "",
      })));
      if (name) await tryVoice(name);
    } else if (choice === "browse") {
      await browseVoices();
    } else if (choice === "name") {
      console.log("Samples of every voice: https://rhasspy.github.io/piper-samples/");
      const name = await ask("Voice name (for example en_GB-alba-medium):");
      if (name) await tryVoice(name);
    }
  }
}

async function browseVoices() {
  let catalog;
  try {
    const response = await fetch(`${VOICE_REPO}/voices.json`, { signal: AbortSignal.timeout(15_000) });
    catalog = Object.values(await response.json());
  } catch (error) {
    return console.log(`Could not fetch the voice list: ${error.message}`);
  }
  const language = (await ask("Language code:", "en")).toLowerCase();
  const voices = catalog
    .filter((voice) => voice.language.code.toLowerCase().startsWith(language) && voice.quality !== "x_low")
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!voices.length) return console.log(`No voices for "${language}".`);
  const have = new Set(installedVoices());
  for (;;) {
    const megabytes = (voice) => Math.round(Object.entries(voice.files).find(([path]) => path.endsWith(".onnx"))[1].size_bytes / 1e6);
    const name = await menu(`Voices (${voices[0].language.name_english})`, voices.map((voice) => ({
      key: voice.key,
      label: voice.key,
      value: `${voice.language.country_english}, ${voice.num_speakers > 1 ? `${voice.num_speakers} speakers, ` : ""}`
        + (have.has(voice.key) ? "installed" : `${megabytes(voice)} MB`),
    })));
    if (!name) return;
    if (await tryVoice(name)) have.add(name);
  }
}

// Fetch a voice if need be, play it, and offer to keep it. True if it is installed.
async function tryVoice(name) {
  const problem = fetchVoice(name);
  if (problem) { console.log(problem); return false; }
  for (;;) {
    console.log(`Playing ${name}...`);
    previewVoice(name, sample());
    const choice = await menu(name, [
      { key: "use", label: "Use this voice" },
      { key: "again", label: "Play it again" },
      { key: "delete", label: "Delete it" },
    ]);
    if (choice === "again") continue;
    if (choice === "use") { config.voice = name; save(); }
    if (choice === "delete") {
      if (name === currentVoice()) console.log("That is the voice in use; choose another first.");
      else { rmSync(voiceFile(name), { force: true }); rmSync(`${voiceFile(name)}.json`, { force: true }); return false; }
    }
    return true;
  }
}

// ---------------------------------------------------------------- names

async function namesMenu() {
  for (;;) {
    const said = config.pronunciations ?? {};
    const choice = await menu("Names and unusual words", [
      ...Object.entries(said).map(([word, spelling]) => ({ key: `say:${word}`, label: `Say "${word}"`, value: `as "${spelling}"` })),
      { key: "add", label: "Fix how a word is said" },
      { key: "hear", label: "Words to listen for", value: config.sttPrompt ?? "the defaults" },
    ]);
    if (!choice) return;
    if (choice === "hear") {
      console.log("Names and terms you use, so they are recognised when you say them. A plain list, in any order.");
      config.sttPrompt = await ask("Words:", config.sttPrompt ?? "Morgan, the Oracle");
      save();
      continue;
    }
    const word = choice === "add" ? await ask("The word as it is written:") : choice.slice(4);
    if (!word) continue;
    await respell(word);
  }
}

// Try spellings aloud until one sounds right.
async function respell(word) {
  const said = { ...config.pronunciations };
  const canHear = existsSync(PIPER);
  if (canHear) { console.log(`This is how "${word}" is said now...`); previewVoice(currentVoice(), `${said[word] ?? word}.`); }
  console.log("Spell it the way it sounds, for example nock-TAH-lee-ah. Blank keeps what you last heard; - removes the fix.");
  for (;;) {
    const spelling = await ask("Sounds like:");
    if (spelling === "-") delete said[word];
    else if (spelling) {
      said[word] = spelling;
      if (canHear) { previewVoice(currentVoice(), `${spelling}.`); continue; }
    }
    config.pronunciations = said;
    save();
    return;
  }
}

// ---------------------------------------------------------------- MCP servers

const describeServer = (spec) => `${spec.url ?? [spec.command, ...(spec.args ?? [])].join(" ")}  (${spec.allow === "all" ? "all tools" : "read-only tools"})`;

async function mcpMenu() {
  for (;;) {
    const servers = config.mcpServers ?? {};
    const choice = await menu(`MCP servers ${dim(`used by ${config.name ?? BASICS.name} directly`)}`, [
      ...Object.entries(servers).map(([name, spec]) => ({ key: `edit:${name}`, label: name, value: describeServer(spec) })),
      { key: "add", label: "Add a server" },
    ]);
    if (!choice) return;
    if (choice === "add") {
      const name = (await ask("A short name for it (letters and digits):")).replace(/[^A-Za-z0-9-]/g, "");
      if (!name) continue;
      const spec = await editServer({});
      if (spec) { config.mcpServers = { ...servers, [name]: spec }; save(); await testServer(name, spec); }
    } else {
      await serverMenu(choice.slice(5));
    }
  }
}

async function serverMenu(name) {
  for (;;) {
    const spec = config.mcpServers[name];
    const choice = await menu(`${name} ${dim(describeServer(spec))}`, [
      { key: "test", label: "Test: connect and list its tools" },
      { key: "edit", label: "Edit" },
      { key: "allow", label: "Tools allowed by default", value: spec.allow === "all" ? "all, including ones that change things" : "read-only" },
      { key: "tools", label: "Choose tools one by one", value: `${Object.keys(spec.tools ?? {}).length} set by hand` },
      { key: "remove", label: "Remove" },
    ]);
    if (!choice) return;
    if (choice === "test") await testServer(name, spec);
    if (choice === "tools") await toolsMenu(name, spec);
    if (choice === "edit") {
      const next = await editServer(spec);
      if (next) { config.mcpServers[name] = next; save(); }
    }
    if (choice === "allow") {
      if (spec.allow === "all") delete spec.allow;
      else if (await yes(`Give ${config.name ?? BASICS.name} every tool, including ones that send, change or delete? Each such use still waits for your yes`)) spec.allow = "all";
      save();
    }
    if (choice === "remove" && await yes(`Remove ${name}?`)) {
      delete config.mcpServers[name];
      save();
      return;
    }
  }
}

async function editServer(old) {
  const kind = old.url ? "remote" : old.command ? "local" : await menu("Kind of server", [
    { key: "remote", label: "Remote", value: "a URL, optionally with an access key" },
    { key: "local", label: "Local", value: "a command run on this machine" },
  ]);
  if (!kind) return null;
  const spec = old.allow ? { allow: old.allow } : {};
  if (kind === "remote") {
    spec.url = await ask("URL:", old.url);
    if (!spec.url) return null;
    const had = old.headers?.Authorization;
    const key = await ask(`Access key, sent as a Bearer token${had ? " (blank keeps the saved one, - removes it)" : " (blank for none)"}:`);
    if (key && key !== "-") spec.headers = { Authorization: `Bearer ${key}` };
    else if (had && key !== "-") spec.headers = old.headers;
  } else {
    const line = await ask("Command, with its arguments:", [old.command, ...(old.args ?? [])].filter(Boolean).join(" "));
    if (!line) return null;
    [spec.command, ...spec.args] = line.split(/\s+/);
    if (old.env) spec.env = old.env;
  }
  return spec;
}

async function listTools(name, spec) {
  const client = new McpClient(name, spec);
  try {
    return await Promise.race([
      client.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 20 seconds")), 20_000)),
    ]);
  } finally {
    client.stop();
  }
}

// Each tool on or off, whatever the server's default says.
async function toolsMenu(name, spec) {
  let tools;
  process.stdout.write(`Connecting to ${name}... `);
  try { tools = await listTools(name, spec); console.log(`${tools.length} tools.`); } catch (error) { return console.log(`failed: ${error.message}`); }
  for (;;) {
    const choice = await menu(`${name}: tools ${dim("choose one to switch it; ones that change things always wait for your yes")}`, tools.map((tool) => ({
      key: tool.name,
      label: `${toolAllowed(spec, tool) ? "on " : dim("off")} ${tool.name}`,
      value: `${readOnly(tool) ? "reads" : "changes things"}${tool.name in (spec.tools ?? {}) ? ", set by hand" : ""}`,
    })));
    if (!choice) return;
    const tool = tools.find((entry) => entry.name === choice);
    spec.tools = { ...spec.tools, [choice]: !toolAllowed(spec, tool) };
    // A choice that only repeats the default is not worth keeping.
    const { [choice]: mine, ...others } = spec.tools;
    if (mine === (spec.allow === "all" || readOnly(tool))) spec.tools = others;
    if (!Object.keys(spec.tools).length) delete spec.tools;
    save();
  }
}

async function testServer(name, spec) {
  process.stdout.write(`Connecting to ${name}... `);
  const client = new McpClient(name, spec);
  try {
    const tools = await Promise.race([
      client.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 20 seconds")), 20_000)),
    ]);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint);
    console.log(`connected: ${tools.length} tools, ${readOnly.length} marked read-only.`);
    for (const tool of tools) {
      const usable = toolAllowed(spec, tool);
      console.log(`  ${usable ? "+" : dim("-")} ${tool.name}${usable ? (readOnly(tool) ? "" : dim("  (changes things: asks you first)")) : dim("  (off)")}`);
    }
    if (tools.length && !readOnly.length && spec.allow !== "all") {
      console.log(`This server marks nothing read-only, so nothing is usable until "Tools allowed" is set to all.`);
    }
  } catch (error) {
    console.log(`failed: ${error.message}`);
    if (/HTTP 401|HTTP 403/.test(error.message)) console.log("It wants a sign-in this cannot do. Servers like that are reached through the Oracle instead.");
  } finally {
    client.stop();
  }
}

// ---------------------------------------------------------------- files

async function filesMenu() {
  for (;;) {
    const folders = config.folders ?? [];
    const choice = await menu(`Folders ${config.name ?? BASICS.name} may read ${dim("markdown, text, code, PDFs and pictures; never written to")}`, [
      ...folders.map((folder) => ({ key: `drop:${folder}`, label: folder, value: existsSync(folder.replace(/^~/, process.env.HOME)) ? "" : "not found" })),
      { key: "add", label: dim("Add a folder") },
    ]);
    if (!choice) return;
    if (choice === "add") {
      const folder = (await ask("Folder, for example ~/Documents/Notes:")).replace(/\/+$/, "");
      if (!folder) continue;
      const real = folder.replace(/^~/, process.env.HOME);
      if (!existsSync(real) || !statSync(real).isDirectory()) { console.log("That is not a folder on this machine."); continue; }
      if (real === process.env.HOME && !(await yes("That is your whole home folder, with everything in it. Allow it?"))) continue;
      config.folders = [...new Set([...folders, folder])];
      save();
    } else if (await yes(`Stop ${config.name ?? BASICS.name} reading ${choice.slice(5)}?`)) {
      config.folders = folders.filter((folder) => folder !== choice.slice(5));
      save();
    }
  }
}

// ---------------------------------------------------------------- sight

async function sightMenu() {
  const LABEL = { screen: "The screen", clipboard: "The clipboard", camera: "The camera" };
  for (;;) {
    const sight = config.sight ?? BASICS.sight;
    const kept = existsSync(PICTURES) ? readdirSync(PICTURES).filter((file) => file.endsWith(".picture")) : [];
    const choice = await menu(`What ${config.name ?? BASICS.name} may look at ${dim("only when you ask; pictures are kept only when you say so")}`, [
      ...Object.keys(LABEL).map((source) => ({ key: source, label: LABEL[source], value: sight.includes(source) ? "allowed" : "off" })),
      { key: "kept", label: "Pictures kept for recognising people and things", value: String(kept.length) },
    ]);
    if (!choice) return;
    if (choice === "kept") {
      if (!kept.length) { console.log("No pictures are kept."); continue; }
      const read = (file) => JSON.parse(readSealed(join(PICTURES, file)));
      const file = await menu("Kept pictures", kept.map((name) => {
        const picture = read(name);
        return { key: name, label: picture.label, value: `${picture.note ? `${picture.note}, ` : ""}${new Date(picture.t).toLocaleDateString()}` };
      }));
      if (!file) continue;
      const answer = await menu(read(file).label, [{ key: "view", label: "View it" }, { key: "delete", label: "Delete it" }]);
      if (answer === "view") {
        // Shown from memory-backed storage, and removed as soon as the viewer closes.
        const shown = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", `heyclaude-view-${process.pid}.jpg`);
        writeFileSync(shown, Buffer.from(read(file).data, "base64"), { mode: 0o600 });
        foreground("sh", ["-c", `(command -v imv >/dev/null && imv '${shown}') || (command -v eog >/dev/null && eog '${shown}') || xdg-open '${shown}'; sleep 1`]);
        await ask("Press Enter when you have seen it.");
        rmSync(shown, { force: true });
      }
      if (answer === "delete") rmSync(join(PICTURES, file));
      continue;
    }
    config.sight = sight.includes(choice) ? sight.filter((source) => source !== choice) : [...sight, choice];
    save();
  }
}

// ---------------------------------------------------------------- listening

async function listeningMenu() {
  for (;;) {
    const wake = "wakeWord" in config ? config.wakeWord : BASICS.wakeWord;
    const choice = await menu("Listening", [
      { key: "wake", label: "Wake phrase", value: wake ?? "off: the microphone opens only on heyclaude toggle" },
      { key: "off", label: wake ? "Turn the wake phrase off" : "Turn the wake phrase on" },
      { key: "interrupt", label: "Word that interrupts an answer", value: ("interruptWord" in config ? config.interruptWord : config.name ?? BASICS.name) ?? "off" },
      { key: "follow", label: "Seconds to wait for a reply after an answer", value: String(config.followUpSeconds ?? BASICS.followUpSeconds) },
      { key: "silence", label: "Quiet that ends your turn, in milliseconds", value: String(config.endSilenceMs ?? 900) },
      { key: "hotkey", label: "Key that opens the chat window", value: ("hotkey" in config ? config.hotkey : BASICS.hotkey) ?? "none" },
    ]);
    if (!choice) return;
    if (choice === "wake") config.wakeWord = await ask("Wake phrase:", wake ?? `Hey ${config.name ?? BASICS.name}`);
    if (choice === "off") config.wakeWord = wake ? null : `Hey ${config.name ?? BASICS.name}`;
    if (choice === "interrupt") {
      console.log(`Say it while ${config.name ?? BASICS.name} is talking or thinking to cut in. On its own it stops the answer; followed by more, it asks the new thing.`);
      const word = await ask("Word (- for none):", ("interruptWord" in config ? config.interruptWord : config.name ?? BASICS.name) ?? "");
      config.interruptWord = word === "-" || !word ? null : word;
    }
    if (choice === "hotkey") {
      console.log("Written the way Hyprland writes a key: modifiers, a comma, the key. For example SUPER, grave or SUPER SHIFT, M.");
      const key = await ask("Key (- for none):", ("hotkey" in config ? config.hotkey : BASICS.hotkey) ?? "");
      config.hotkey = key === "-" || !key ? null : key;
    }
    if (choice === "follow") config.followUpSeconds = Math.max(0, Number(await ask("Seconds (0 for none):", "6")) || 0);
    if (choice === "silence") config.endSilenceMs = Math.max(300, Number(await ask("Milliseconds:", "900")) || 900);
    save();
  }
}

// ---------------------------------------------------------------- main

function finish() {
  if (changed) {
    restartDaemon();
    console.log("Saved, and the assistant has been restarted.");
  }
  process.exit(0);
}

export async function run() {
  listen();
  for (;;) {
    const wake = "wakeWord" in config ? config.wakeWord : BASICS.wakeWord;
    const choice = await menu(`heyclaude settings ${dim(CONFIG)}`, [
      { key: "assistant", label: "Assistant", value: config.name ?? BASICS.name },
      { key: "memory", label: "Memory", value: `${topicFiles().length} topics, ${documentFiles().length} documents` },
      { key: "ollama", label: "Ollama", value: `${ollama().model} at ${ollama().url}` },
      { key: "oracle", label: "The Oracle", value: oracleAccount() },
      { key: "voice", label: "Voice", value: engine() === "kokoro" ? `${kokoroVoice()} (Kokoro)` : `${currentVoice()} (Piper)` },
      { key: "names", label: "Names and unusual words", value: `${Object.keys(config.pronunciations ?? {}).length} fixed` },
      { key: "mcp", label: "MCP servers", value: Object.keys(config.mcpServers ?? {}).join(", ") || "none" },
      { key: "listening", label: "Listening and hotkey", value: wake ? `"${wake}"` : "wake phrase off" },
      { key: "files", label: "Files", value: (config.folders ?? []).join(", ") || "no folders" },
      { key: "sight", label: "Sight", value: (config.sight ?? BASICS.sight).join(", ") || "off" },
    ], "quit");
    if (!choice) finish();
    await { assistant, memory, ollama: ollamaMenu, oracle: oracleMenu, voice: voiceMenu, names: namesMenu, mcp: mcpMenu, listening: listeningMenu, files: filesMenu, sight: sightMenu }[choice]();
  }
}
