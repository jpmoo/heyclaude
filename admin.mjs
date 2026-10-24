// The daemon's side of the settings window: one request, one JSON answer.
// The window (and anything else) sends `admin {"op": ..., "args": {...}}`;
// what it may read and change is exactly what is listed here.

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASICS, CONFIG, KOKORO, KOKORO_VOICES, PIPER, VOICES, loadConfig, oracleEnv, readOnly, readSealed, saveConfig, toolAllowed, voiceFile, voiceRate, writeSealed } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = process.env.XDG_RUNTIME_DIR ?? "/tmp";

// Set a.b.c in an object, making the objects on the way.
function put(target, path, value) {
  const keys = path.split(".");
  let at = target;
  for (const key of keys.slice(0, -1)) at = at[key] = at[key] && typeof at[key] === "object" ? at[key] : {};
  if (value === undefined) delete at[keys.at(-1)]; else at[keys.at(-1)] = value;
}

// Which Claude account the Oracle is logged in as, from `claude auth status`
// under the Oracle's own login. Read in the background and kept a minute:
// opening the settings must not wait on another program each time.
let account = { text: "", at: 0, reading: null };
function oracleAccount(claude) {
  if (account.text && Date.now() - account.at < 60_000) return Promise.resolve(account.text);
  account.reading ??= new Promise((resolve) => {
    execFile(claude || "claude", ["auth", "status"], { env: oracleEnv(), encoding: "utf8", timeout: 8000 }, (error, stdout) => {
      let text;
      try {
        const status = JSON.parse(stdout);
        text = status.loggedIn ? `${status.email ?? "Logged in"}${status.subscriptionType || status.authMethod ? ` (${status.subscriptionType ?? status.authMethod})` : ""}` : "Not logged in";
      } catch {
        text = error?.code === "ENOENT" ? "Claude is not installed" : "Claude did not say";
      }
      account = { text, at: Date.now(), reading: null };
      resolve(text);
    });
  });
  return account.reading;
}

export function createAdmin(d) {
  const sample = () => `Hello, I'm ${d.cfg.name}. This is how I would sound.`;

  const ops = {
    // ------------------------------------------------------------ settings
    "config.get": async () => ({
      name: d.cfg.name, userName: d.cfg.userName, style: d.cfg.style,
      ollama: { url: d.cfg.ollama.url, model: d.cfg.ollama.model }, embedModel: d.cfg.embedModel,
      oracleModel: d.cfg.oracle.model,
      // Read where the Oracle runs: on a client, config.get is answered by the server.
      oracleAccount: await oracleAccount(d.cfg.oracle?.claude),
      wakeWord: d.cfg.wakeWord, interruptWord: d.interruptWord(), followUpSeconds: d.cfg.followUpSeconds,
      endSilenceMs: d.cfg.endSilenceMs, hotkey: d.cfg.hotkey, sight: d.cfg.sight, folders: d.cfg.folders,
      knownVoicesOnly: d.cfg.knownVoicesOnly, voiceThreshold: d.cfg.voiceThreshold, similarFloor: d.cfg.similarFloor,
      // The zone in use: the one chosen, or this machine's own when none is.
      timeZone: d.cfg.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),

    // values: { "ollama.url": "...", followUpSeconds: 4 }. null goes back to the default.
    "config.set": ({ values = {} }) => {
      const saved = loadConfig();
      let restart = false;
      for (let [path, value] of Object.entries(values)) {
        // These four can be switched off, which is saved as null; the window
        // sends an emptied box as "". For anything else, null means the default.
        const optional = ["wakeWord", "interruptWord", "hotkey", "userName"].includes(path);
        if (optional && value === "") value = null;
        put(saved, path, value === null && !optional ? undefined : value);
        if (d.LIVE.includes(path)) d.cfg[path] = path in saved ? saved[path] : d.defaults[path];
        else restart = true;
      }
      saveConfig(saved);
      if (restart) d.restartSoon();
      return { restart };
    },

    // ------------------------------------------------------------ memory
    // ------------------------------------------------------------ where Morgan lives
    // Here, or on a server this machine is a client of. Changing it starts this machine's Morgan again.
    "client.get": () => d.client.get(),
    "client.set": ({ server = "", key = "", device = "" } = {}) => {
      server = String(server).trim();
      key = String(key).trim();
      if (server && !key && !d.client.get().hasKey) throw new Error("A server needs a key: run `heymorgan access add <device>` on the server.");
      if (key && !key.startsWith("hc_")) throw new Error("That is not a key the server issued (they start hc_).");
      d.client.set({ server, key, device: String(device).trim() });
      d.restartSoon();
      return { restart: true };
    },

    // ------------------------------------------------------------ the log
    "log.recent": ({ count = 200 } = {}) => ({
      lines: d.logLines.slice(-Math.min(Number(count) || 200, 500)).map((line) => ({
        ...line, at: new Date(line.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }),
      })),
    }),

    // The gardener: what it changed, day by day; one change undone; a tidying now.
    "memory.garden.report": () => ({ days: d.garden.report() }),
    "memory.garden.undo": ({ id }) => d.garden.undo(String(id)),
    "memory.garden.run": async () => ({ changes: (await d.garden.run())?.actions.length ?? 0, days: d.garden.report() }),

    "memory.list": () => ({
      topics: d.topics().map((topic) => ({ name: topic.name, description: topic.description, notes: topic.notes })),
      documents: d.documents().map((kept) => ({ title: kept.title, source: kept.source, t: kept.t, size: kept.text.length })),
      pictures: d.pictures().map((picture) => ({ label: picture.label, note: picture.note, t: picture.t })),
    }),
    "memory.note.add": ({ topic, text }) => edit(topic, (found) => { found.notes.push(clean(text)); }),
    "memory.note.set": ({ topic, index, text }) => edit(topic, (found) => { found.notes[index] = clean(text); }),
    "memory.note.delete": ({ topic, index }) => edit(topic, (found) => { found.notes.splice(index, 1); }),
    "memory.note.move": ({ topic, index, to }) => {
      const target = d.readTopic(to);
      if (!target) throw new Error(`there is no topic called ${to}`);
      let note;
      edit(topic, (found) => { [note] = found.notes.splice(index, 1); });
      target.notes.push(note);
      d.writeTopic(target);
      return {};
    },
    "memory.topic.add": ({ name, description = "" }) => {
      if (!d.slug(name)) throw new Error("a topic needs a name");
      if (d.readTopic(name)) throw new Error(`there is already a topic called ${name}`);
      d.writeTopic({ name, description, notes: [] });
      return {};
    },
    "memory.topic.rename": ({ topic, name, description }) => {
      const found = d.readTopic(topic);
      if (!found) throw new Error(`there is no topic called ${topic}`);
      if (d.slug(name) !== d.slug(topic)) {
        if (d.readTopic(name)) throw new Error(`there is already a topic called ${name}`);
        rmSync(d.topicPath(topic));
      }
      d.writeTopic({ name: name || found.name, description: description ?? found.description, notes: found.notes });
      return {};
    },
    "memory.topic.delete": ({ topic }) => { rmSync(d.topicPath(topic), { force: true }); return {}; },
    "memory.document.get": ({ title }) => {
      const kept = d.documents().find((entry) => entry.title === title);
      if (!kept) throw new Error(`there is no kept document called ${title}`);
      return { title: kept.title, source: kept.source, t: kept.t, text: kept.text.slice(0, 20_000), more: Math.max(0, kept.text.length - 20_000) };
    },
    "memory.document.delete": ({ title }) => { rmSync(d.documentPath(title), { force: true }); return {}; },
    // A picture is written out, unsealed, only for as long as it takes to look at it.
    "memory.picture.view": ({ label }) => {
      const picture = d.pictures().find((entry) => entry.label === label);
      if (!picture) throw new Error(`there is no picture of ${label}`);
      const file = join(RUNTIME, `heymorgan-view-${Date.now()}.jpg`);
      writeFileSync(file, Buffer.from(picture.data, "base64"), { mode: 0o600 });
      setTimeout(() => rmSync(file, { force: true }), 120_000).unref();
      // The picture as well as where it was put: on a server, the file is on the
      // server, and the client showing it writes one of its own.
      return { path: file, data: picture.data };
    },
    "memory.picture.delete": ({ label }) => { rmSync(d.picturePath(label), { force: true }); return {}; },

    // ------------------------------------------------------------ reminders
    "reminders.list": () => ({ reminders: d.reminders.list() }),
    "reminders.cancel": ({ id }) => { d.reminders.cancel(id); return { reminders: d.reminders.list() }; },

    // ------------------------------------------------------------ voice out
    "voice.list": () => ({
      kokoroInstalled: existsSync(join(KOKORO, "model.onnx")),
      engine: d.cfg.engine, kokoroVoice: d.cfg.kokoroVoice, kokoroSpeed: d.cfg.kokoroSpeed, piperVoice: d.cfg.voice,
      kokoro: KOKORO_VOICES,
      piper: existsSync(VOICES) ? readdirSync(VOICES).filter((file) => file.endsWith(".onnx")).map((file) => file.slice(0, -5)).sort() : [],
    }),
    "voice.preview": ({ engine, voice }) => {
      if (engine === "kokoro") {
        spawn("node", [join(HERE, "kokoro.mjs"), "--say", String(Math.max(0, KOKORO_VOICES.indexOf(voice))), String(d.cfg.kokoroSpeed), sample()], { stdio: "ignore", detached: true }).unref();
      } else {
        const command = `'${PIPER}' --model '${voiceFile(voice)}' --output-raw 2>/dev/null | pw-play --raw --rate ${voiceRate(voice)} --channels 1 --format s16 -`;
        const player = spawn("sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        player.stdin.end(sample() + "\n");
        player.unref();
      }
      return {};
    },

    // ------------------------------------------------------------ voices heard
    "voices.status": () => d.voicesStatus(),
    "voices.enroll": ({ name }) => { d.enroll(name); return {}; },
    "voices.forget": ({ name }) => { d.forgetVoice(name); return d.voicesStatus(); },

    // ------------------------------------------------------------ connections
    "ollama.models": async ({ url }) => {
      const response = await fetch(`${(url || d.cfg.ollama.url).replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const models = (await response.json()).models.map((model) => ({ name: model.name, gb: Number((model.size / 1e9).toFixed(1)) }));
      const embedding = (name) => /embed|bert|bge|e5|minilm/i.test(name);
      return { chat: models.filter((model) => !embedding(model.name)), embedding: models.filter((model) => embedding(model.name)) };
    },
    "oracle.account": () => {
      const result = spawnSync("claude", ["auth", "status"], { env: oracleEnv(), encoding: "utf8" });
      try {
        const status = JSON.parse(result.stdout);
        return { loggedIn: Boolean(status.loggedIn), email: status.email ?? null, plan: status.subscriptionType ?? null };
      } catch {
        return { loggedIn: false, email: null, plan: null, error: "claude did not answer" };
      }
    },
    "mcp.list": () => {
      const servers = loadConfig().mcpServers ?? {};
      return {
        servers: Object.entries(servers).map(([name, spec]) => {
          const known = d.mcpAll.get(name);
          return {
            name,
            target: spec.url ?? [spec.command, ...(spec.args ?? [])].join(" "),
            allow: spec.allow === "all" ? "all" : "read",
            hasKey: Boolean(spec.headers?.Authorization),
            connected: Boolean(known?.tools),
            error: known?.error ?? null,
            tools: (known?.tools ?? []).map((tool) => ({ name: tool.name, readOnly: readOnly(tool), on: toolAllowed(spec, tool) })),
          };
        }),
      };
    },
    "mcp.add": ({ name, url, key, command }) => {
      name = String(name ?? "").replace(/[^A-Za-z0-9-]/g, "");
      if (!name) throw new Error("the server needs a short name of letters and digits");
      const spec = {};
      if (url) {
        spec.url = String(url).trim();
        if (key) spec.headers = { Authorization: `Bearer ${String(key).trim()}` };
      } else if (command) {
        [spec.command, ...spec.args] = String(command).trim().split(/\s+/);
      } else throw new Error("give a URL or a command");
      return server(name, () => spec);
    },
    "mcp.remove": ({ name }) => server(name, () => undefined),
    "mcp.allow": ({ name, allow }) => server(name, (spec) => { if (allow === "all") spec.allow = "all"; else delete spec.allow; return spec; }),
    "mcp.tool": ({ name, tool, on }) => server(name, (spec) => {
      const known = d.mcpAll.get(name)?.tools?.find((entry) => entry.name === tool);
      spec.tools = { ...spec.tools, [tool]: Boolean(on) };
      // A choice that only repeats the default is not worth keeping.
      if (known && Boolean(on) === (spec.allow === "all" || readOnly(known))) delete spec.tools[tool];
      if (!Object.keys(spec.tools).length) delete spec.tools;
      return spec;
    }),
    "mcp.reconnect": async () => { await d.reconnectMcp(); return ops["mcp.list"](); },
  };

  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

  function edit(topic, change) {
    const found = d.readTopic(topic);
    if (!found) throw new Error(`there is no topic called ${topic}`);
    change(found);
    found.notes = found.notes.filter(Boolean);
    d.writeTopic(found);
    return {};
  }

  // Change one server's entry in the saved settings, then reconnect to them all.
  async function server(name, change) {
    const saved = loadConfig();
    const servers = { ...saved.mcpServers };
    const next = change(servers[name] ?? {});
    if (next === undefined) delete servers[name]; else servers[name] = next;
    saveConfig({ ...saved, mcpServers: servers });
    await d.reconnectMcp();
    return ops["mcp.list"]();
  }

  return async function admin(op, args = {}) {
    if (!ops[op]) return { ok: false, error: `unknown: ${op}` };
    try {
      return { ok: true, ...(await ops[op](args)) };
    } catch (error) {
      return { ok: false, error: error.message.split("\n")[0] };
    }
  };
}
