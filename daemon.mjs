#!/usr/bin/env node
// heyclaude daemon: microphone -> speech-to-text -> Morgan -> text-to-speech.
//
// Morgan is a local model served by Ollama and answers everything it can.
// When a question is beyond it, Morgan calls consult_oracle, which asks Claude
// (one long-lived `claude -p` process on its own login) and hands the answer
// back for Morgan to relay. A Unix socket takes commands (toggle, say, stop,
// new, status, watch) and streams events.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watchFile, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpClient } from "./mcp.mjs";
import { BASICS, KOKORO, KOKORO_VOICES, STARTER_TOPICS, readOnly, readSealed, toolAllowed, writeSealed } from "./lib.mjs";
import { fileURLToPath } from "node:url";
import { Transcript, describe, describeThread } from "./history.mjs";
import * as wake from "./wake.mjs";
import { createAdmin } from "./admin.mjs";
import * as reminders from "./reminders.mjs";
import { calculate } from "./calc.mjs";
import * as voiceprint from "./speaker.mjs";

const HOME = homedir();
const CONFIG_HOME = join(HOME, ".config", "heyclaude");
const RUNTIME = process.env.XDG_RUNTIME_DIR ?? "/tmp";
const SOCKET = process.env.HEYCLAUDE_SOCKET ?? join(RUNTIME, "heyclaude.sock");
const WORKDIR = join(HOME, ".local", "share", "heyclaude", "work");
const MEMORY = process.env.HEYCLAUDE_MEMORY ?? join(HOME, ".local", "share", "heyclaude", "memory");

// Where install.sh puts whisper.cpp, Piper and their models.
const SPEECH = join(HOME, ".local", "share", "heyclaude");
const WHISPER = join(SPEECH, "whisper.cpp", "build", "bin", "whisper-cli");
const PIPER = join(SPEECH, "piper", "piper");

// At login this can start before the desktop does. Screenshots, the clipboard
// and the hotkey all need to know which desktop session to talk to, so wait
// for one to appear and take its details from the sockets it leaves behind.
for (let waited = 0; waited < 90; waited += 2) {
  process.env.WAYLAND_DISPLAY ||= readdirSync(RUNTIME).find((name) => /^wayland-\d+$/.test(name)) ?? "";
  const hypr = join(RUNTIME, "hypr");
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE && existsSync(hypr)) {
    process.env.HYPRLAND_INSTANCE_SIGNATURE = readdirSync(hypr).find((name) => existsSync(join(hypr, name, ".socket2.sock"))) ?? "";
  }
  if (process.env.WAYLAND_DISPLAY && process.env.HYPRLAND_INSTANCE_SIGNATURE) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}

const defaults = {
  name: BASICS.name,
  userName: BASICS.userName,
  style: BASICS.style,
  ollama: { ...BASICS.ollama, think: false, keepAlive: "30m" },
  oracle: {
    claude: "claude",
    model: BASICS.oracleModel,
    // The smaller model the quick Oracle runs on.
    quickModel: "haiku",
    // The only built-in tools the Oracle has: no shell, no file edits, no
    // subagents. MCP tools are added by name in allowedTools; anything else
    // that needs approval is refused, because nobody is there to approve it.
    tools: ["WebSearch", "WebFetch"],
    allowedTools: ["WebSearch", "WebFetch"],
  },
  // MCP servers Morgan can use directly, by name: { command, args, env } for a
  // local one or { url, headers } for a remote one. "allow" is "read" (only
  // tools the server marks read-only; the default) or "all".
  mcpServers: {},
  // Spoken when Morgan turns to the Oracle without saying anything first.
  consultLine: "Let me consult the Oracle.",
  // Shell commands. record writes raw 16 kHz mono 16-bit audio to stdout. {file}
  // is the utterance as a wav; stt prints its transcript on stdout.
  // {target} names the echo-cancelled microphone when there is one.
  record: "pw-record {target} --raw --rate 16000 --channels 1 --format s16 -",
  // Take the assistant's own voice out of what the microphone hears, so that
  // it can be interrupted by voice without hearing itself.
  echoCancel: true,
  // Said while the assistant is busy, this stops it: "Morgan" cuts an answer
  // off and waits for you; "Morgan, what about tomorrow" asks the new thing.
  // Defaults to the assistant's name; null leaves only the key and the button.
  interruptWord: undefined,
  // Listening ends by itself after this much quiet following speech, gives up
  // if nobody speaks, and never runs longer than the maximum.
  endSilenceMs: 900,
  noSpeechSeconds: 8,
  maxUtteranceSeconds: 60,
  // Said aloud, this starts a turn: "Hey Morgan, what time is it?" The
  // microphone then stays open and speech is transcribed on this machine to
  // look for the phrase; anything else is thrown away. null turns it off,
  // leaving `heyclaude toggle`.
  wakeWord: BASICS.wakeWord,
  // How the wake word is listened for: "spotter" is a small model that hears
  // only that; "transcribe" writes down everything said and looks for it,
  // which costs far more in a room full of talk. The spotter falls back to
  // transcribing when it cannot be loaded or cannot spell the phrase.
  wakeEngine: "spotter",
  // Once a voice has been taught (heyclaude settings), speech in any other
  // voice is ignored. The score is how like the taught voice it must be, from
  // 0 to 1; short remarks are held to a lower bar, there being less to go on.
  knownVoicesOnly: true,
  voiceThreshold: 0.4,
  wakeThreshold: 0.25,
  // Spoken when the wake word is heard with nothing after it.
  wakeReply: "Yes?",
  // After a spoken answer, keep listening this long for a reply with no wake
  // word needed. 0 turns it off.
  followUpSeconds: BASICS.followUpSeconds,
  // What may be looked at when the user asks, and the camera to use. A picture
  // goes to the Ollama server and is then deleted; only its description is kept.
  // Folders whose files the assistant may list, search and read by itself.
  // A file attached in the chat window is read wherever it is.
  folders: [],
  sight: BASICS.sight,
  camera: "/dev/video0",
  // {prompt} is sttPrompt: words whisper should expect, so names come out right.
  stt: existsSync(WHISPER)
    ? `'${WHISPER}' -m '${SPEECH}/models/ggml-base.en.bin' -f {file} -nt -np -t 6 --prompt {prompt}`
    : null,
  // The assistant's name and the wake phrase are added to these by themselves.
  sttPrompt: "The Oracle, Hyprland, Noctalia, Hermes Notes, Talaria.",
  // A Piper voice, by name: `heyclaude voice` lists and fetches them.
  // "kokoro" (more natural) or "piper" (lighter). Kokoro falls back to Piper
  // if it cannot be started.
  engine: BASICS.engine,
  kokoroVoice: BASICS.kokoroVoice,
  kokoroSpeed: 1,
  voice: BASICS.voice,
  // Words the voice gets wrong, each with a spelling it says right:
  // { "Noctalia": "nock-tah-lia" }. Applied to what is spoken, not what is shown.
  pronunciations: {},
  // tts reads one sentence on stdin and writes it as raw 16-bit mono audio on
  // stdout ({voice} is the voice's .onnx file); play plays that from stdin.
  tts: existsSync(PIPER) ? `'${PIPER}' --model {voice} --output-raw` : null,
  play: "pw-play --raw --rate {rate} --channels 1 --format s16 -",
  // A conversation left alone this long is over: what was learned in it is
  // filed into memory, and the next utterance starts a fresh one.
  idleResetMinutes: 10,
  // Every exchange is kept and embedded with this model, on the Ollama server.
  // Earlier exchanges scoring at least recallScore against what was just said
  // are shown to the model unasked; it can search for more.
  // Up to this many characters of memory are shown to the model whole on
  // every turn. Past it, the notes that bear on the turn are picked out by
  // meaning: up to notesShown of them scoring at least noteScore.
  memoryInFull: 4000,
  notesShown: 14,
  noteScore: 0.5,
  // Sort each question by kind before answering, and pass facts about the
  // world to the Oracle. The local model cannot tell what it does not know;
  // it can tell what kind of question it has been asked.
  router: true,
  embedModel: BASICS.embedModel,
  // Opens the chat window. Set by the daemon at runtime, so no Hyprland
  // configuration file is touched; null leaves the keyboard alone.
  hotkey: BASICS.hotkey,
  recallScore: 0.58,
  threadScore: 0.55,
};

const configPath = process.env.HEYCLAUDE_CONFIG ?? join(CONFIG_HOME, "config.json");
const user = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const cfg = {
  ...defaults,
  ...user,
  ollama: { ...defaults.ollama, ...user.ollama },
  oracle: { ...defaults.oracle, ...user.oracle },
};
// Unless one has been chosen, the wake phrase goes with the name.
if (!("wakeWord" in user)) cfg.wakeWord = `Hey ${cfg.name}`;

// Settings that are looked at each time they are used take effect as soon as
// the file is saved, without waiting for the settings menu to be closed and
// the daemon restarted. (Voices, servers and the microphone still need that.)
const LIVE = ["knownVoicesOnly", "voiceThreshold", "userName", "folders", "sight", "pronunciations", "style", "followUpSeconds", "endSilenceMs", "recallScore", "consultLine", "wakeReply"];
watchFile(configPath, { interval: 1000 }, () => {
  try {
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    for (const key of LIVE) cfg[key] = key in saved ? saved[key] : defaults[key];
  } catch { /* half-written, or gone: keep what we have */ }
});

const voiceFile = join(SPEECH, "voices", `${cfg.voice}.onnx`);
let voiceRate = 22050;
try { voiceRate = JSON.parse(readFileSync(`${voiceFile}.json`, "utf8")).audio.sample_rate; } catch { /* Piper's usual rate */ }

// What changes from one turn to the next: said with the turn, at the end of
// what the model reads, and not in its instructions at the start. The server
// keeps its reading of everything up to the first thing that differs, so
// with this in the instructions every turn was read again from the top, and a
// long conversation, or one with a document in it, was read whole each time.
const turnNotes = () => [
  quiet
    ? "This turn was typed, and your answer will be read on screen, not heard: use markdown where it helps (lists, bold, code blocks, links), and be as long as the question deserves, no longer."
    : "This turn was spoken, and your answer will be heard: plain spoken sentences, no markdown, lists, headings, code, emoji or URLs. Be brief, usually one to three sentences, and say more only when asked.",
  `It is ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}. The dates: ${reminders.calendar()}.`,
  interviewing ? INTERVIEW_PROMPT : "",
  seen.trim(),
  remembered.length || recalled.length
    ? `From earlier conversations, possibly relevant:\n${[...remembered.map((hit) => describeThread(hit)), ...recalled.map((hit) => describe(hit))].join("\n")}`
    : "",
  memoryInFull() ? "" : `From your memory:\n${picked || "(nothing that bears on this)"}\n\nYour memory topics:\n${topicList()}`,
].filter(Boolean).join("\n\n");

// The Kokoro voice runs as a helper that keeps its model loaded.
const KOKORO_SOCKET = process.env.HEYCLAUDE_SOCKET ? `${process.env.HEYCLAUDE_SOCKET}.tts` : join(RUNTIME, "heyclaude-tts.sock");
let kokoroHelper = null;
let kokoroReady = false;

function startKokoro() {
  if (cfg.engine !== "kokoro" || !existsSync(join(KOKORO, "model.onnx"))) return;
  const speaker = Math.max(0, KOKORO_VOICES.indexOf(cfg.kokoroVoice));
  const script = join(fileURLToPath(new URL(".", import.meta.url)), "kokoro.mjs");
  kokoroHelper = spawn("node", [script, KOKORO_SOCKET, String(speaker), String(cfg.kokoroSpeed)], { stdio: ["ignore", "ignore", "pipe"] });
  kokoroHelper.stderr.setEncoding("utf8");
  kokoroHelper.stderr.on("data", (text) => { if (text.includes("kokoro ready")) kokoroReady = true; });
  kokoroHelper.on("exit", () => { kokoroReady = false; kokoroHelper = null; });
  kokoroHelper.on("error", () => { kokoroReady = false; kokoroHelper = null; });
}
startKokoro();

const morganPrompt = () => [
  `You are ${cfg.name}, a voice assistant on the user's Linux desktop. Everything you write is read aloud by a speech`,
  "synthesizer, and the user's words reach you through speech recognition, so expect misheard words and work out what",
  "was meant.",
  "Each turn says whether it was spoken or typed, and that decides the form of your answer.",
  cfg.style,
  "About the user's own life, say only what is in your memory, in this conversation, or in what a tool returned: never",
  "fill in a person, a hobby, a place or any other detail of their life that you have not been given.",
  "Never say that you would need to check, look up or recall something, and never ask whether you should: when the",
  "answer may be in your memory, a kept document, an earlier conversation or one of the user's services, look there in",
  "the same turn, without comment, and answer from what you find.",
  "You can consult the Oracle, a far more capable intelligence that can search the web. Feeling sure is not a reason to",
  "answer yourself: you are a small model, and you are as sure of what you have wrong as of what you have right. Go by",
  "the kind of question instead. Answer yourself: conversation, opinions, ideas, wording and writing; anything about the",
  "user, which comes from memory and their services; and schoolbook knowledge that never changes, such as a capital or",
  "the author of a classic. Consult the Oracle, and do not answer from what you believe: any number, count, measurement,",
  "date or statistic that is not schoolbook; a particular film, book, product, company, place or person; how something",
  "technical works in detail; anything medical, legal, or about money or tax; anything current or recent, such as news,",
  "results, prices, versions and this year's rules; and anything that needs deep expertise or careful reasoning. If in",
  "doubt about which kind it is, consult.",
  "When you relay what the Oracle told you, say once that it came from the Oracle and then give the substance, in your",
  "own words and just as briefly. Speak to the user as you, never about them by name. Never announce what you are about",
  "to do (let me ask, let me check, I need to clarify): do it, and say only the answer.",
  "You keep a long-term memory about the user, in notes organized into topics that you create and curate yourself.",
  memoryInFull()
    ? "All of it is shown below, under Your memory: answer from it directly, without saying that you are looking. When the user"
    : "It is too large to show whole, so the notes most likely to bear on what was just said are picked out for you and shown below, under From your memory, with the list of topics. Answer from those notes directly; call recall to read a whole topic only when they are not enough. When the user",
  "tells you something lasting about themselves, their people, work, projects, routines or preferences, save it with",
  "remember straight away, without being asked and without making a speech about it. What a tool, the Oracle or a",
  "look shows you is not a memory: never save calendar entries, task lists, search results or what was on screen.",
  "Write every note in the third",
  `person, about ${cfg.userName ?? "the user by name once you know it"}: never as I or me, which would read as being about you.`,
  "Keep the topics few, distinct",
  "and tidy: use rewrite_topic to merge, split, rename, correct or delete them as you learn more. File each note under",
  "the existing topic it belongs to, going by the topics' descriptions; do not put everything in one. Start a new topic,",
  "with a description, only when none of them fits.",
  mcpTools.length ? "You also have tools from the user's own services; use them when a request concerns those services." : "",
  // Asked for something a switched-off tool would do, the model hunted for another way and then said only that it could not.
  withheld().length
    ? `These tools exist on the user's services but are switched off for you: ${withheld().join(", ")}. When the user asks for something one of them does, do not look for another way: say plainly that it is switched off for you, and that they can switch it on in settings, under Connections.`
    : "",
  "When you make or change something for the user, put into it only what they said: the title or the words they gave,",
  "and nothing of your own. Do not add tags, projects, due dates, priorities, notes or descriptions that they did not",
  "ask for. Once it is done you may ask, in a few words, whether they would like to add anything such as a due date.",
  "You can carry such things out: they are done for you the moment the user says yes. Never tell the user that you",
  "can only prepare actions, or that they must do it themselves, unless the tool for it is switched off.",
  "When the user asks you to send, create, delete or change something in their own services, call the tool for it",
  "straight away, with the details filled in. Do not ask permission first: calling such a tool does not carry it out,",
  "it only puts the action forward, and you are then told to check with the user. It is carried out for you when they",
  "say yes, and you are told the result. You cannot carry out such a thing by saying so: unless you have been told in",
  "this turn that it was carried out, it was not, and you must not say it was. Your memory, your saved pictures and",
  "looking need no permission.",
  cfg.sight.length
    ? `You can see, when asked: ${cfg.sight.map((source) => SIGHT[source].hint).join("; ")}. Look when the user points at`
      + " something they are looking at, showing you or have copied, as in what is this, what does my screen say or what am"
      + " I holding. Never look unasked. You see nothing at all unless you call one of these tools in the same turn: never"
      + " describe, recognise or confirm anything from imagination, and never claim a picture is saved unless remember_picture"
      + " said so. When the user asks you to remember what someone or something looks like, call remember_picture at once."
      + ` Pictures you have saved for recognising people and things: ${pictures().map((picture) => picture.label).join(", ") || "none yet"}.`
    : "",
  cfg.folders.length
    ? `You may list, search and read the files in these folders of the user's: ${cfg.folders.join(", ")}. Do so when they ask about a file, a document or their notes.`
    : "",
  `Whole documents you have kept, to read with recall_document when a question is about one: ${documents().map((entry) => entry.title).join("; ") || "none yet"}.`,
  "A document is kept only when you are told in this turn that it has been; never say you have kept or memorised one otherwise.",
  "Timers and reminders are set, listed and cancelled for you when the user asks, and you are shown the result; you",
  "cannot set one by saying so. When one comes due you say it aloud, unprompted.",
  "Everything you and the user have ever said to each other is also kept, word for word. Passages from earlier",
  "conversations that look relevant are shown below when there are any; they say how things stood then, so anything",
  "that can change (a calendar, tasks, the news) is fetched again with its tool, never repeated from them.",
  "Use search_conversations to look further,",
  "by subject, by date or both, whenever the user refers to something said before that you cannot see.",
  "Never work a date out yourself. Each turn comes with the dates already worked out; whenever the user names a day",
  "and a tool takes one, give the tool the date from that list, as YYYY-MM-DD.",
  "Each turn ends with notes from the system, in square brackets. The user did not write them and cannot see them;",
  "they tell you what has just been done for you, what applies to this turn, and what to do. Follow them.",
  memoryInFull() ? `\n\nYour memory:\n${memoryText()}` : "",
].join(" ");

const INTERVIEW_PROMPT = [
  "You are now conducting an orientation interview to get to know the user. Ask one short question at a time and",
  "wait for the answer. After each answer, save what you learned with remember before asking the next question.",
  "Cover, roughly in this order and following up where an answer is interesting: who they are and what they do,",
  "the people in their life, their current projects, their daily routines, the tools and devices they use, and how",
  "they like to be spoken to and helped. Recall existing topics first so you do not ask what you already know.",
  "When the user wants to stop or you have covered the ground, tidy the topics, call end_interview and say goodbye.",
].join(" ");

// The quick Oracle: a smaller model with no tools, asked for facts about the
// world that the local model would otherwise answer from a hunch.
const quickPrompt = () => [
  `You are the Oracle. ${cfg.name}, a small local voice assistant, passes you questions of fact that it should not answer`,
  "from memory. Each message gives the recent conversation and the question.",
  cfg.userName ? `(The user is ${cfg.userName}.)` : "",
  "You cannot look anything up. If the answer depends on anything recent or changing (news, results, reviews, prices,",
  "versions, schedules, who currently holds a post, this year's limits or rates), or you are not confident of the facts,",
  "reply with the single word SEARCH and nothing else. Otherwise answer accurately and compactly in plain prose with",
  `no markdown, lists or URLs, addressed to the user as you: ${cfg.name} will relay it in a sentence or three, so lead`,
  "with the answer and include only what matters. Where the matter is legal, medical or financial, give the general",
  "position and say in a clause that the particulars of their case could change it.",
].join(" ");

const oraclePrompt = () => [
  `You are the Oracle. ${cfg.name}, a small local voice assistant, consults you on its user's behalf when a question is`,
  cfg.userName ? `(The user is ${cfg.userName}.)` : "",
  `beyond it. Each message gives the recent conversation and ${cfg.name}'s question. Answer accurately and compactly in`,
  `plain prose with no markdown, lists or URLs: ${cfg.name} will relay your answer in a sentence or three, so lead`,
  "with the answer and include only what matters. Write it as the answer itself, addressed to the user as you: not as a",
  `note to ${cfg.name} about the user, and never calling the user by name or he or she. If the question could mean more`,
  "than one thing, answer the likeliest and mention the other in a clause; do not ask which was meant.",
  "Say plainly when you are unsure or could not find something.",
].join(" ");

const MORGAN_TOOLS = [{
  type: "function",
  function: {
    name: "consult_oracle",
    description: "Ask the Oracle, a far more capable intelligence with web access. Use it for current or recent "
      + "information, for anything you are unsure of, and for questions needing deep expertise or careful reasoning.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The full question, understandable on its own" } },
      required: ["question"],
    },
  },
}, {
  type: "function",
  function: {
    name: "recall",
    description: "Read everything saved under one memory topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "A topic name from your memory topics list" } },
      required: ["topic"],
    },
  },
}, {
  type: "function",
  function: {
    name: "remember",
    description: "Add one note to a memory topic, creating the topic if it is new.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "An existing topic name, or a short name for a new one" },
        note: { type: "string", description: "One self-contained fact, in a full sentence in the third person that names the user. Never I, me or my, and never the words the user" },
        description: { type: "string", description: "For a new topic: one line saying what belongs in it" },
      },
      required: ["topic", "note"],
    },
  },
}, {
  type: "function",
  function: {
    name: "rewrite_topic",
    description: "Replace a memory topic wholesale, to tidy, correct, merge, rename or delete it. Recall it first.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The existing topic name" },
        new_name: { type: "string", description: "A new name, if renaming" },
        description: { type: "string", description: "One line saying what belongs in the topic" },
        notes: { type: "array", items: { type: "string" }, description: "The complete new set of notes; empty deletes the topic" },
      },
      required: ["topic", "description", "notes"],
    },
  },
}, {
  type: "function",
  function: {
    name: "calculate",
    description: "Work out arithmetic exactly. Use it for every sum, percentage, average or conversion, however easy it looks: "
      + "never do arithmetic in your head. Write the sum out, as in 17% of 3480, (450 + 50) * 0.74, 100 - 15%, sqrt(2), average(72, 88, 95).",
    parameters: { type: "object", properties: { expression: { type: "string", description: "The sum, written out" } }, required: ["expression"] },
  },
}, {
  type: "function",
  function: {
    name: "search_conversations",
    description: "Search everything said in earlier conversations, by subject, by date, or both.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for. Leave out to list what was said in a date range" },
        from: { type: "string", description: "Earliest date, as YYYY-MM-DD" },
        to: { type: "string", description: "Latest date, as YYYY-MM-DD" },
      },
    },
  },
}, {
  type: "function",
  function: {
    name: "end_interview",
    description: "End the orientation interview.",
    parameters: { type: "object", properties: {} },
  },
}];

// ---------------------------------------------------------------- sight

const run = promisify(execFile);

const SIGHT = {
  screen: { tool: "look_at_screen", what: "screenshot", hint: "look_at_screen shows you the window they are working in" },
  clipboard: { tool: "look_at_clipboard", what: "copied image", hint: "look_at_clipboard shows you what they last copied" },
  camera: { tool: "look_at_camera", what: "photo from the laptop's camera", hint: "look_at_camera shows you what is in front of the laptop, usually them" },
};

const sightTools = () => cfg.sight.map((source) => ({
  type: "function",
  function: {
    name: SIGHT[source].tool,
    description: `Look, right now: ${SIGHT[source].hint}.`,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What the user wants to know about what you will see" },
        ...(source === "screen" ? { whole_screen: { type: "boolean", description: "The whole screen, not only the window in use" } } : {}),
      },
      required: ["question"],
    },
  },
})).concat(cfg.sight.length ? [{
  type: "function",
  function: {
    name: "remember_picture",
    description: "Keep a picture so you can recognise who or what is in it later. Only when the user explicitly asks you to "
      + "remember what someone or something looks like, as in this is me, remember my face, or this is my dog.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Who or what it is: the user, a named person, or a named thing" },
        source: { type: "string", enum: cfg.sight, description: "Where the picture comes from" },
        note: { type: "string", description: "Anything worth knowing about it, such as who the person is to the user" },
      },
      required: ["label", "source"],
    },
  },
}, {
  type: "function",
  function: {
    name: "forget_picture",
    description: "Delete a saved picture.",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  },
}] : []);

// Pictures the user asked to have kept, so that people and things can be
// recognised later: one sealed file each, holding a label and a small JPEG.
const PICTURES = join(MEMORY, "pictures");
const picturePath = (label) => join(PICTURES, `${slug(label)}.picture`);

function pictures() {
  if (!existsSync(PICTURES)) return [];
  return readdirSync(PICTURES).filter((file) => file.endsWith(".picture")).sort().map((file) => JSON.parse(readSealed(join(PICTURES, file))));
}

let lastLook = null; // { source, bytes, t }: what was last looked at, held in memory only

// Take a picture. Resolves to its bytes, or to { text } when there is no picture to take.
async function capture(source, args) {
  const file = join(RUNTIME, `heyclaude-look-${process.pid}.${source === "camera" ? "jpg" : "png"}`);
  try {
    if (source === "screen") {
      const shell = (command) => run("sh", ["-c", command]).then((result) => JSON.parse(result.stdout));
      if (args.whole_screen) {
        const monitor = (await shell("hyprctl -j monitors")).find((entry) => entry.focused);
        await run("grim", ["-o", monitor.name, file]);
      } else {
        const { at, size } = await shell("hyprctl -j activewindow");
        await run("grim", ["-g", `${at[0]},${at[1]} ${size[0]}x${size[1]}`, file]);
      }
    } else if (source === "clipboard") {
      const types = (await run("wl-paste", ["--list-types"]).catch(() => ({ stdout: "" }))).stdout.split("\n");
      const image = types.find((type) => type === "image/png") ?? types.find((type) => type.startsWith("image/"));
      if (!image) {
        const text = (await run("wl-paste", ["--no-newline"]).catch(() => ({ stdout: "" }))).stdout;
        return { text: text ? `The clipboard holds text, not a picture:\n${text.slice(0, 4000)}` : "The clipboard is empty." };
      }
      await run("sh", ["-c", `wl-paste --type '${image}' > '${file}'`]);
    } else {
      // The first frames are dark while the camera settles its exposure.
      await run("ffmpeg", ["-loglevel", "error", "-y", "-f", "v4l2", "-i", cfg.camera, "-vf", "select=gte(n\\,12)", "-frames:v", "1", file], { timeout: 15_000 });
    }
    return readFileSync(file);
  } finally {
    rmSync(file, { force: true });
  }
}

// Look, have the model describe what is there, and keep the picture only in
// memory, briefly, in case the user says to remember it.
async function look(source, args) {
  try {
    const bytes = await capture(source, args);
    if (bytes.text) return bytes.text;
    lastLook = { source, bytes, t: Date.now() };
    // Saved pictures go along when there may be someone or something to recognise.
    const known = source === "screen" ? [] : pictures().slice(0, 6);
    const key = known.length
      ? ` The first image is the new one. The others are pictures you saved earlier, for comparison: ${known.map((picture, index) => `image ${index + 2} is ${picture.label}${picture.note ? ` (${picture.note})` : ""}`).join("; ")}.`
        + " Say who or what in the new image matches a saved picture, and say so plainly when you are not sure."
      : "";
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        think: false,
        keep_alive: cfg.ollama.keepAlive,
        messages: [{
          role: "user",
          content: `This is a ${SIGHT[source].what}. Describe what it shows, fully enough to answer this: "${args.question ?? "What is this?"}" `
            + `Quote exactly any text that matters. Plain prose, no lists.${key}`,
          images: [bytes.toString("base64"), ...known.map((picture) => picture.data)],
        }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    return (await response.json()).message.content.trim();
  } catch (error) {
    return `You could not look: ${error.message.split("\n")[0]}`;
  }
}

// Keep a picture under a label: the one just looked at if there is one, or a new one.
async function rememberPicture(args) {
  const label = String(args.label ?? "").trim();
  const source = String(args.source ?? "camera");
  if (!slug(label)) return "No label given.";
  if (!cfg.sight.includes(source)) return "You are not allowed to look at that.";
  const file = join(RUNTIME, `heyclaude-keep-${process.pid}`);
  try {
    const fresh = lastLook && lastLook.source === source && Date.now() - lastLook.t < 120_000;
    const bytes = fresh ? lastLook.bytes : await capture(source, args);
    if (bytes.text) return "There is no picture there to keep.";
    // Small enough to send along with every later look.
    writeFileSync(`${file}.in`, bytes, { mode: 0o600 });
    await run("ffmpeg", ["-loglevel", "error", "-y", "-i", `${file}.in`, "-vf", "scale='min(768,iw)':-2", "-q:v", "4", `${file}.jpg`]);
    mkdirSync(PICTURES, { recursive: true });
    writeSealed(picturePath(label), JSON.stringify({
      label, note: String(args.note ?? "").trim(), t: Date.now(), data: readFileSync(`${file}.jpg`).toString("base64"),
    }));
    emit({ type: "memory", topic: "Pictures", note: `a picture of ${label}` });
    return `Kept, as a picture of ${label}.`;
  } catch (error) {
    return `The picture could not be kept: ${error.message.split("\n")[0]}`;
  } finally {
    rmSync(`${file}.in`, { force: true });
    rmSync(`${file}.jpg`, { force: true });
  }
}

// The model cannot be relied on to look before it answers: asked who is at the
// camera, it will sometimes just say. So a turn that sounds as if it is about
// seeing is put to a narrow yes-or-no question first, and the looking and the
// saving are done here, before the model is asked for its answer.
const SIGHT_WORDS = /\b(camera|webcam|screen|window|clipboard|copied|look(s|ing)?|see|seeing|hold(ing)?|wearing|picture|photo|face|recogni[sz]e|show(ing)?|what is this|what's this)\b/i;

async function sightIntent(text) {
  if (!cfg.sight.length || !SIGHT_WORDS.test(text)) return null;
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        think: false,
        keep_alive: cfg.ollama.keepAlive,
        format: {
          type: "object",
          properties: {
            look: { type: "string", enum: ["none", ...cfg.sight] },
            remember: { type: "boolean" },
            label: { type: "string" },
          },
          required: ["look", "remember", "label"],
        },
        messages: [{
          role: "system",
          content: "A user is speaking to a voice assistant that can look, on request, at: "
            + `${cfg.sight.map((source) => `${source} (${SIGHT[source].hint.replace(/^\S+ shows you /, "")})`).join("; ")}. `
            + "Decide what the user's message asks for. look: which of those the assistant must look at right now to do as asked, "
            + "or none if the message is not a request to look at something present (talk about pictures, screens or seeing in "
            + "general is none). remember: true only if the user asks for a picture to be kept so that someone or something can be "
            + "recognised later. label: for remember, who or what the picture is of, in a word or two (their name if they give it); "
            + "otherwise empty.",
        }, { role: "user", content: text }],
      }),
    });
    const intent = JSON.parse((await response.json()).message.content);
    return cfg.sight.includes(intent.look) ? intent : null;
  } catch (error) {
    console.error(`sight: ${error.message}`);
    return null;
  }
}

function forgetPicture(args) {
  const label = String(args.label ?? "");
  if (!slug(label) || !existsSync(picturePath(label))) return `There is no saved picture of ${label}.`;
  rmSync(picturePath(label));
  return `The picture of ${label} is gone.`;
}

// ---------------------------------------------------------------- files

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const MOST = 150_000; // characters of one file put in front of the model

const home = (path) => resolve(String(path).replace(/^~(?=\/|$)/, HOME));

// The real location of a path, if it lies inside one of the allowed folders.
function allowed(path) {
  try {
    const real = realpathSync(home(path));
    return cfg.folders.some((folder) => {
      const root = realpathSync(home(folder));
      return real === root || real.startsWith(`${root}/`);
    }) ? real : null;
  } catch {
    return null;
  }
}

// A file as something the model can read: its text, or for a picture a
// description of it.
async function readDocument(path, question = "") {
  const extension = extname(path).toLowerCase();
  const size = statSync(path).size;
  if (size > 30_000_000) return "The file is too large to read.";
  let text;
  if (IMAGES.has(extension)) {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        messages: [{
          role: "user",
          content: `Describe this picture fully${question ? `, with this question in mind: "${question}"` : ""}. Quote exactly any text in it. Plain prose.`,
          images: [readFileSync(path).toString("base64")],
        }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    return `(A picture. What it shows:) ${(await response.json()).message.content.trim()}`;
  }
  if (extension === ".pdf") {
    text = (await run("pdftotext", ["-layout", path, "-"], { maxBuffer: 1 << 28 })).stdout;
  } else {
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) return "This is not a text file, and not a kind of file that can be read.";
    text = bytes.toString("utf8");
  }
  return text.length > MOST ? `${text.slice(0, MOST)}\n\n(The file goes on: only the first ${MOST} of its ${text.length} characters are shown.)` : text;
}

// Documents kept whole, on request: a recipe, a policy, a set of notes. One
// sealed file each. The model sees their titles and reads one when it needs it.
const DOCUMENTS = join(MEMORY, "documents");
const documentPath = (title) => join(DOCUMENTS, `${slug(title)}.document`);

function documents() {
  if (!existsSync(DOCUMENTS)) return [];
  return readdirSync(DOCUMENTS).filter((file) => file.endsWith(".document")).sort().map((file) => JSON.parse(readSealed(join(DOCUMENTS, file))));
}

function keepDocument(title, source, text) {
  mkdirSync(DOCUMENTS, { recursive: true });
  writeSealed(documentPath(title), JSON.stringify({ title, source, t: Date.now(), text }));
  emit({ type: "memory", topic: "Documents", note: `kept "${title}" in full (${text.length} characters, from ${basename(source)})` });
}

let lastRead = null; // { path, text, t }: the file most recently read in this conversation

// The best match for a few words among the names of files in the allowed folders.
async function findByWords(hint) {
  const wanted = [...new Set(words(hint).filter((word) => word.length >= 4 && !["file", "document", "recipe", "notes", "download", "downloads", "downloaded", "folder", "favorite", "favourite"].includes(word)))];
  const pool = wanted.length ? wanted : words(hint).filter((word) => word.length >= 4);
  const scores = new Map();
  for (const folder of cfg.folders) {
    for (const word of pool) {
      const result = await run("find", [home(folder), "-type", "f", "-iname", `*${word}*`, "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], { maxBuffer: 1 << 24 }).catch((error) => ({ stdout: error.stdout ?? "" }));
      for (const path of result.stdout.split("\n").filter(Boolean)) scores.set(path, (scores.get(path) ?? 0) + 1);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? null;
}

// As with looking: whether the user is asking for a document to be kept is
// put as a narrow question, and the keeping is done here, so that "I've
// saved it" is only ever said about something that was saved.
// ---------------------------------------------------------------- reminders
//
// As with looking and keeping: what the user wants is put to the model as a
// narrow question, and the setting, listing and cancelling are done here.

let due = reminders.load(); // [{ id, at, text, made }]
let lastFired = null; // the reminder that last went off, for "snooze that"
const REMIND_WORDS = /\b(remind|reminder|reminders|timer|timers|alarm|alarms|wake me|snooze|nudge me|don'?t let me forget)\b/i;

const reminderList = () => (due.length
  ? [...due].sort((a, b) => a.at - b.at).map((entry) => `- ${entry.text || "a timer"}: ${reminders.when(entry.at)}`).join("\n")
  : "There are none.");

let reminderTalk = 0; // when reminders were last the subject, so "cancel the one about the dentist" is understood

async function reminderIntent(text) {
  // The word need not be said again while they are the subject, or when
  // there are some set and the user speaks of cancelling or moving one.
  const following = due.length > 0 && (Date.now() - reminderTalk < 3 * 60_000 || /\b(cancel|delete|remove|clear|drop|scrap|snooze|postpone|push back|move)\b/i.test(text));
  if (!REMIND_WORDS.test(text) && !following) return;
  let intent;
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        format: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["none", "set", "list", "cancel", "change"] },
            kind: { type: "string", enum: ["relative", "absolute"] },
            amount: { type: "number" },
            unit: { type: "string", enum: ["seconds", "minutes", "hours", "days"] },
            day: { type: "string" },
            time: { type: "string" },
            text: { type: "string" },
            all: { type: "boolean" },
          },
          required: ["action", "kind", "amount", "unit", "day", "time", "text", "all"],
        },
        messages: [{
          role: "system",
          content: "A user is speaking to an assistant that keeps timers and reminders. Say what the message asks for; do not work out "
            + "any dates yourself. action: set to make a timer or reminder (snoozing one is setting it again); list to hear what is "
            + "set; cancel to remove one or all; change to move one that is already set to a different time; none if the message is not asking "
            + "for any of that. For set and change: kind is relative when "
            + "they give a length of time from now (in ten minutes, in two hours), with amount and unit; kind is absolute when they "
            + "give a clock time or a day, with time as 24-hour HH:MM (empty if none was said) and day as today, tomorrow, a weekday "
            + "name, a date as YYYY-MM-DD, or empty if no day was said. text: what to remind them of, as a short phrase addressed "
            + "to them (take the bread out, ring the dentist); empty for a plain timer. For cancel and change: text is which one, in their words, "
            + `and all is true if they mean every one. It is ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}.`
            + `${lastFired ? ` The reminder that last went off was: ${lastFired.text || "a timer"}.` : ""}`
            + `${due.length ? ` Set at present:\n${reminderList()}` : ""}`,
        }, { role: "user", content: text }],
      }),
    });
    intent = JSON.parse((await response.json()).message.content);
  } catch (error) {
    console.error(`reminders: ${error.message}`);
    return;
  }
  if (intent.action === "none") return;
  reminderTalk = Date.now();
  fresh = true; // not something to file away as a memory
  if (intent.action === "list") return did("list_reminders", {}, reminderList());
  // Which reminder their words point at: the one sharing most of the words
  // that carry meaning; or, when they name none, the only one there is.
  const FILLER = new Set(["the", "one", "about", "that", "this", "for", "to", "my", "me", "a", "an", "of", "it", "reminder", "reminders", "timer", "alarm", "please"]);
  const wanted = words(intent.text).filter((word) => !FILLER.has(word));
  const hits = (entry) => wanted.filter((word) => words(entry.text || "timer").includes(word)).length;
  const ranked = [...due].sort((a, b) => hits(b) - hits(a) || a.at - b.at);
  const meant = ranked[0] && (hits(ranked[0]) > 0 || (due.length === 1 && !wanted.length)) ? ranked[0] : null;

  if (intent.action === "cancel") {
    const gone = intent.all ? [...due] : meant ? [meant] : [];
    if (!gone.length) return did("cancel_reminder", { which: intent.text }, `Nothing was cancelled: it was not clear which one is meant. Set at present:\n${reminderList()}`);
    due = due.filter((entry) => !gone.includes(entry));
    reminders.save(due);
    return did("cancel_reminder", { which: intent.all ? "all" : intent.text }, `Cancelled, just now: ${gone.map((entry) => entry.text || "the timer").join("; ")}.`);
  }
  if (intent.action === "change") {
    if (!meant) return did("change_reminder", { which: intent.text }, `Nothing was changed: it was not clear which one is meant. Set at present:\n${reminderList()}`);
    try {
      let at;
      if (intent.kind === "absolute" && !String(intent.day ?? "").trim() && /^\d{1,2}:\d{2}$/.test(intent.time)) {
        // A new time and no new day: the same day it was already set for.
        const moved = new Date(meant.at);
        moved.setHours(Number(intent.time.split(":")[0]), Number(intent.time.split(":")[1]), 0, 0);
        at = moved.getTime();
        if (at <= Date.now()) throw new Error("that time has already gone");
      } else {
        at = reminders.resolve(intent.kind === "relative" ? { kind: "relative", amount: intent.amount, unit: intent.unit } : { kind: "absolute", day: intent.day, time: intent.time });
      }
      meant.at = at;
      reminders.save(due);
      emit({ type: "reminder", set: true, text: meant.text, when: reminders.when(at) });
      return did("change_reminder", { which: intent.text }, `Changed, just now: ${meant.text || "the timer"} is now ${reminders.when(at)}. Tell the user exactly that time.`);
    } catch (error) {
      return did("change_reminder", { which: intent.text }, `Not changed: ${error.message}. It is still ${reminders.when(meant.at)}.`);
    }
  }
  const what = String(intent.text ?? "").replace(/\s+/g, " ").trim();
  const asked = intent.kind === "relative" ? { kind: "relative", amount: intent.amount, unit: intent.unit } : { kind: "absolute", day: intent.day, time: intent.time };
  try {
    const at = reminders.resolve(asked);
    due.push({ id: randomUUID().slice(0, 8), at, text: what, made: Date.now() });
    reminders.save(due);
    emit({ type: "reminder", set: true, text: what, when: reminders.when(at) });
    did("set_reminder", { ...asked, text: what }, `Set, just now: ${what ? `a reminder to ${what}` : "a timer"}, ${reminders.when(at)}. Tell the user exactly that time, so they can catch a mistake.`);
  } catch (error) {
    did("set_reminder", { ...asked, text: what }, `Not set: ${error.message}. Ask the user to say when again.`);
  }
}

// A reminder that has come due is said aloud, unprompted, once nothing else
// is going on; then Morgan listens for a moment, for "thanks" or "snooze that".
function fire(entry) {
  due = due.filter((other) => other !== entry);
  reminders.save(due);
  lastFired = entry;
  reminderTalk = Date.now();
  const late = Date.now() - entry.at > 5 * 60_000 ? ` That was due ${reminders.when(entry.at).replace(/ \(.*\)$/, "")}.` : "";
  const line = `${entry.text ? `Reminder: ${entry.text}.` : "Your timer is up."}${late}`;
  emit({ type: "reminder", text: entry.text || "Your timer is up", late: Boolean(late) });
  interrupt();
  lastActivity = Date.now();
  began ||= lastActivity;
  history.push({ role: "assistant", content: line });
  emit({ type: "assistant", text: line });
  if (!cfg.tts) return;
  quiet = false;
  spokenTurn = true;
  setState("thinking");
  speakDelta(`${line} `);
  speakFlush();
  finishSpeaking();
}

setInterval(() => {
  if (state !== "idle" || active) return;
  const entry = due.filter((candidate) => candidate.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
  if (entry) fire(entry);
}, 1000).unref();

const KEEP_WORDS = /\b(remember|keep|save|store|memori[sz]e|hold on to|file away|learn)\b/i;

async function keepIntent(text, files) {
  if (!KEEP_WORDS.test(text) || !(files.length || lastRead || cfg.folders.length)) return "";
  let intent;
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        format: {
          type: "object",
          properties: { keep: { type: "boolean" }, extract: { type: "boolean" }, title: { type: "string" }, file: { type: "string" } },
          required: ["keep", "extract", "title", "file"],
        },
        messages: [{
          role: "system",
          content: "A user is speaking to an assistant that can do two things with a document. It can keep the whole text (a recipe, "
            + "a guide) so as to have it word for word later; and it can read a document through and save the facts in it as separate "
            + "notes in its memory. Decide what the message asks. keep: true only if they want the document itself, its contents or "
            + "full text, remembered or kept. extract: true only if they want what the document says, the information or facts in it, "
            + "learned, taken in or saved as memories or notes. Both are false for remembering a simple fact they state themselves, "
            + "and for anything else. title: a short title for the document, "
            + "such as Sourdough recipe. file: the name or path of the file if they give one, or the words they use to describe it; "
            + `empty if they mean a file already attached or just read. ${files.length ? `Attached to this message: ${files.map((file) => basename(file)).join(", ")}.` : ""}`
            + `${lastRead ? ` The file read most recently: ${basename(lastRead.path)}.` : ""}`,
        }, { role: "user", content: text }],
      }),
    });
    intent = JSON.parse((await response.json()).message.content);
  } catch (error) {
    console.error(`keep: ${error.message}`);
    return "";
  }
  if (!intent.keep && !intent.extract) return "";
  const title = intent.title.trim() || "Document";
  try {
    let path = files[0] ? home(files[0]) : null;
    if (!path && intent.file) path = allowed(intent.file) ?? await findByWords(`${intent.file} ${title}`);
    if (!path && lastRead && Date.now() - lastRead.t < 15 * 60_000) path = lastRead.path;
    if (!path && cfg.folders.length) path = await findByWords(title);
    if (!path) return " You were asked to keep a document, but which file is meant could not be worked out, so nothing has been kept. Ask them which file.";
    const content = await readDocument(path, text);
    lastRead = { path, text: content, t: Date.now() };
    // An attached file is already in front of the model; one found in a folder is not.
    if (!files.length) did("read_file", { path }, content);
    if (intent.keep) {
      keepDocument(title, path, content);
      did("keep_document", { title, file: path }, `Done, just now: the full text of ${basename(path)} is kept under the title "${title}".`);
    }
    if (intent.extract) {
      const filed = await learnFrom(content, basename(path));
      const total = Object.values(filed).reduce((sum, notes) => sum + notes.length, 0);
      did("save_document_as_memories", { file: path }, total
        ? `Done, just now: ${total} new notes saved from ${basename(path)}.\n`
          + Object.entries(filed).map(([topic, notes]) => `${topic}:\n${notes.map((note) => `- ${note}`).join("\n")}`).join("\n")
          + "\nTell the user how many were saved and under which topics, with an example or two, and that they can look them over and correct them in settings under Memory."
        : `Nothing was saved: everything in ${basename(path)} is either held already or not worth a note.`);
    }
    return "";
  } catch (error) {
    return ` You were asked to keep a document, but it failed (${error.message.split("\n")[0]}), so nothing has been kept. Say so.`;
  }
}

// Read a document through and file what it says as notes. The model is asked
// for the facts as a list, each with a topic chosen from those that exist;
// the saving is done here, and only notes not already held are added.
async function learnFrom(content, source) {
  const names = topics().map((topic) => topic.name);
  const who = cfg.userName ?? "the user";
  const found = [];
  for (let at = 0; at < content.length && at < 120_000; at += 7000) {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        format: {
          type: "object",
          properties: {
            notes: {
              type: "array",
              items: { type: "object", properties: { topic: { type: "string", enum: names }, note: { type: "string" } }, required: ["topic", "note"] },
            },
          },
          required: ["notes"],
        },
        messages: [{
          role: "system",
          content: `You keep a memory about ${who}, in notes filed under these topics:\n`
            + topics().map((topic) => `- ${topic.name}: ${topic.description}`).join("\n")
            + `\n\n${who} has given you part of a document (${source}) and asked you to save what it says. Pull out each fact worth `
            + `having later as one self-contained sentence in the third person, naming ${who} where it is about them and naming `
            + "other people and things in full, so that it makes sense on its own with the document gone. Keep exact names, numbers "
            + "and dates. One fact to a note; no headings, no summaries of the document, nothing that is only filler. Give each the "
            + "topic whose description it fits.",
        }, { role: "user", content: content.slice(at, at + 7500) }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    found.push(...(JSON.parse((await response.json()).message.content).notes ?? []));
  }
  const filed = {};
  const today = new Date().toISOString().slice(0, 10);
  const plain = (note) => words(note.replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, "")).join(" ");
  for (const name of names) {
    const topic = readTopic(name);
    const held = new Set(topic.notes.map(plain));
    const fresh = found.filter((entry) => entry.topic === name).map((entry) => String(entry.note).replace(/\s+/g, " ").trim())
      .filter((note) => note && !held.has(plain(note)) && held.add(plain(note)));
    if (!fresh.length) continue;
    writeTopic({ ...topic, notes: [...topic.notes, ...fresh.map((note) => `${note} (${today})`)] });
    noted.push(...fresh.map((note) => noteKey(name, note)));
    filed[name] = fresh;
  }
  const total = Object.values(filed).reduce((sum, notes) => sum + notes.length, 0);
  if (total) emit({ type: "memory", topic: Object.keys(filed).join(", "), note: `${total} notes from ${source}` });
  return filed;
}

const documentTools = () => (documents().length ? [{
  type: "function",
  function: {
    name: "recall_document",
    description: "Read the full text of a document you have kept.",
    parameters: { type: "object", properties: { title: { type: "string", description: "A title from your kept documents" } }, required: ["title"] },
  },
}] : []);

function recallDocument(args) {
  const title = String(args.title ?? "");
  const kept = documents();
  const wanted = words(title);
  const found = kept.find((entry) => slug(entry.title) === slug(title))
    ?? kept.map((entry) => ({ entry, hits: wanted.filter((word) => words(entry.title).includes(word)).length })).sort((a, b) => b.hits - a.hits).find((match) => match.hits > 0)?.entry;
  if (!found) return `There is no kept document called ${title}. You have: ${kept.map((entry) => entry.title).join(", ")}`;
  emit({ type: "recall", topic: found.title });
  return `${found.title} (kept ${new Date(found.t).toLocaleDateString()}, from ${basename(found.source)}):\n\n${found.text}`;
}

const fileTools = () => (cfg.folders.length ? [{
  type: "function",
  function: {
    name: "list_folder",
    description: "List what is in one of the user's folders you may read.",
    parameters: { type: "object", properties: { path: { type: "string", description: "The folder" } }, required: ["path"] },
  },
}, {
  type: "function",
  function: {
    name: "find_files",
    description: "Find files by name anywhere under the folders you may read.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Part of the file's name" } }, required: ["name"] },
  },
}, {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the folders you may read: markdown, text, code, PDF, or a picture (which is described).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, question: { type: "string", description: "For a picture: what the user wants to know about it" } },
      required: ["path"],
    },
  },
}] : []);

async function fileTool(name, args) {
  try {
    if (name === "find_files") {
      const wanted = String(args.name ?? "").replace(/[*?\[\]]/g, "");
      if (!wanted) return "No name given.";
      const found = [];
      for (const folder of cfg.folders) {
        const result = await run("find", [home(folder), "-iname", `*${wanted}*`, "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], { maxBuffer: 1 << 24 }).catch((error) => ({ stdout: error.stdout ?? "" }));
        found.push(...result.stdout.split("\n").filter(Boolean));
      }
      return found.length ? found.slice(0, 60).join("\n") + (found.length > 60 ? `\n(and ${found.length - 60} more)` : "") : "Nothing by that name.";
    }
    const path = allowed(args.path ?? "");
    if (!path) return `That is outside the folders you may read, or is not there. You may read: ${cfg.folders.join(", ")}`;
    if (name === "list_folder") {
      const entries = readdirSync(path, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
      return entries.slice(0, 300).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join("\n") || "It is empty.";
    }
    if (statSync(path).isDirectory()) return "That is a folder; list it instead.";
    const text = await readDocument(path, String(args.question ?? ""));
    lastRead = { path, text, t: Date.now() };
    return text;
  } catch (error) {
    return `That failed: ${error.message.split("\n")[0]}`;
  }
}

// ---------------------------------------------------------------- events

let state = "idle"; // idle | listening | transcribing | thinking | consulting | speaking
const watchers = new Set();

function emit(event) {
  const line = JSON.stringify(event) + "\n";
  for (const socket of watchers) socket.write(line);
}

function setState(next) {
  state = next;
  emit({ type: "state", state });
  bindEscape(next !== "idle");
}

// While Morgan is doing anything, Escape stops it. The key is bound only for
// that long, and as a pass-through, so the window in front still gets it.
let escapeBound = false;

function bindEscape(want) {
  // A trial run on a socket of its own leaves the keyboard alone.
  if (want === escapeBound || !process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.HEYCLAUDE_SOCKET) return;
  escapeBound = want;
  const stop = join(HOME, ".local", "bin", "heyclaude");
  execFile("hyprctl", ["keyword", ...(want ? ["bindn", `, escape, exec, ${stop} stop`] : ["unbind", ", escape"])], () => {});
}

function fail(message) {
  console.error(message);
  emit({ type: "error", message });
}

// ---------------------------------------------------------------- memory
//
// One file per topic: the first line is the topic's name, the second its
// description, then one "- note" per line. Sealed on disk (see lib.mjs);
// `heyclaude settings` shows what is remembered.

let interviewing = false;

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const topicPath = (name) => join(MEMORY, `${slug(name)}.topic`);

// Topics written before memory was sealed.
if (existsSync(MEMORY)) {
  for (const file of readdirSync(MEMORY).filter((name) => name.endsWith(".md"))) {
    writeSealed(join(MEMORY, `${file.slice(0, -3)}.topic`), readFileSync(join(MEMORY, file), "utf8"));
    rmSync(join(MEMORY, file));
  }
}

function readTopic(name) {
  if (!slug(name) || !existsSync(topicPath(name))) return null;
  const [title = "", description = "", ...rest] = readSealed(topicPath(name)).split("\n");
  const notes = rest.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  return { name: title.replace(/^#\s*/, ""), description, notes };
}

function writeTopic({ name, description, notes }) {
  mkdirSync(MEMORY, { recursive: true });
  const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  writeSealed(topicPath(name), [`# ${oneLine(name)}`, oneLine(description), "", ...notes.map((note) => `- ${oneLine(note)}`), ""].join("\n"));
}

function topics() {
  if (!existsSync(MEMORY)) return [];
  return readdirSync(MEMORY).filter((file) => file.endsWith(".topic")).sort().map((file) => readTopic(file.slice(0, -6)));
}

// A memory with nothing in it yet gets the starter topics.
function seedTopics() {
  if (topics().length) return;
  for (const [name, description] of STARTER_TOPICS) {
    writeTopic({ name: name.replace("{name}", cfg.userName ?? "me"), description, notes: [] });
  }
}

// Everything remembered, as text. While it is small it is simply put in
// front of the model whole: asked to choose which topic to read, it often
// chose the wrong one, and each wrong choice was another round trip.
function memoryText() {
  return topics().filter((topic) => topic.notes.length)
    .map((topic) => `${topic.name} (${topic.description})\n${topic.notes.map((note) => `- ${note}`).join("\n")}`).join("\n\n") || "(nothing yet)";
}

const memoryInFull = () => memoryText().length <= cfg.memoryInFull;

// Picking out what matters from a memory too large to show whole. Every note
// has an embedding; each turn, the notes nearest in meaning to what was said
// are chosen here and put in front of the model, grouped by topic. Topics
// keep the memory in order and let a whole subject be read at once; they are
// not what the choosing depends on, which is why it stays quick as they grow.
const noteVectors = new Map(); // note text -> its embedding
let picked = ""; // the notes chosen for the turn in hand

async function pickNotes(text) {
  if (memoryInFull()) return "";
  const all = topics().flatMap((topic) => topic.notes.map((note) => ({ topic: topic.name, note })));
  // Embeddings are made once per note and kept for as long as the daemon runs.
  const missing = [...new Set(all.map((entry) => entry.note).filter((note) => !noteVectors.has(note)))];
  for (let at = 0; at < missing.length; at += 64) {
    const batch = missing.slice(at, at + 64);
    const response = await fetch(`${cfg.ollama.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: cfg.embedModel, input: batch.map((note) => `search_document: ${note}`) }),
    });
    if (!response.ok) throw new Error(`embedding notes failed: HTTP ${response.status}`);
    (await response.json()).embeddings.forEach((vector, index) => {
      let norm = 0;
      for (const x of vector) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      noteVectors.set(batch[index], Float32Array.from(vector, (x) => x / norm));
    });
  }
  const query = await transcript.embed(`search_query: ${text}`);
  const wanted = new Set(words(text).filter((word) => word.length >= 4));
  const scored = all.map((entry) => {
    const vector = noteVectors.get(entry.note);
    let meaning = 0;
    for (let i = 0; i < query.length; i++) meaning += query[i] * vector[i];
    // Names and exact words are where meaning alone lets you down.
    const shared = words(entry.note).filter((word) => wanted.has(word)).length;
    return { ...entry, score: meaning + 0.06 * Math.min(shared, 3) };
  }).sort((a, b) => b.score - a.score);
  // Who the user is and how they like to be dealt with bear on every turn.
  const always = (topic) => /^about\b/i.test(topic) || /^preferences$/i.test(topic);
  const chosen = [...all.filter((entry) => always(entry.topic)).slice(0, 14), ...scored.filter((entry) => !always(entry.topic) && entry.score >= cfg.noteScore).slice(0, cfg.notesShown)];
  if (process.env.HEYCLAUDE_DEBUG) console.error("notes", scored.slice(0, 6).map((entry) => `${entry.score.toFixed(2)} ${entry.note.slice(0, 40)}`));
  const byTopic = new Map();
  for (const entry of chosen) byTopic.set(entry.topic, [...(byTopic.get(entry.topic) ?? []), entry.note]);
  return [...byTopic].map(([topic, notes]) => `${topic}\n${notes.map((note) => `- ${note}`).join("\n")}`).join("\n\n");
}

function topicList() {
  const all = topics();
  if (!all.length) return "(none yet)";
  return all.map((topic) => `- ${topic.name}: ${topic.description} (${topic.notes.length} notes)`).join("\n");
}

// Which exchanges a note came from, kept beside the notes: so that when an
// answer is marked wrong, the notes that may have been taken from it can be
// put in front of the user to keep or delete. Nothing is deleted on that
// evidence alone.
const SOURCES = join(MEMORY, "sources.sealed");
let provenance = { notes: {}, kept: {} }; // notes: key -> [exchange times]; kept: exchange time -> [keys the user chose to keep]
try { if (existsSync(SOURCES)) provenance = { notes: {}, kept: {}, ...JSON.parse(readSealed(SOURCES)) }; } catch { /* start again */ }
const noteKey = (topic, note) => `${slug(topic)}|${words(String(note).replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, "")).join(" ")}`;
let noted = []; // notes saved during the turn in hand, to be tied to its exchange once that is filed

function sourced(keys, times) {
  if (!keys.length || !times.length) return;
  for (const key of keys) provenance.notes[key] = [...new Set([...(provenance.notes[key] ?? []), ...times])];
  writeSealed(SOURCES, JSON.stringify(provenance));
}

// Notes that may have come from an exchange, for the user to look over.
function notesFrom(t) {
  const item = transcript.items.find((entry) => entry.t === t);
  if (!item) return [];
  const kept = new Set(provenance.kept[t] ?? []);
  const said = new Set(words(`${item.user} ${item.morgan}`).filter((word) => word.length >= 4));
  const out = [];
  for (const topic of topics()) {
    for (const note of topic.notes) {
      const key = noteKey(topic.name, note);
      const from = provenance.notes[key];
      if (!from?.includes(t) || kept.has(key)) continue;
      // Saved in that very turn: it came from it. Saved when the whole
      // conversation was filed: only if it shares its matter with this exchange.
      if (from.length > 1) {
        const vector = noteVectors.get(note);
        let like = 0;
        if (vector && item.v) for (let i = 0; i < vector.length; i++) like += vector[i] * item.v[i];
        const shared = words(note).filter((word) => said.has(word)).length;
        if (!(like >= 0.5 || shared >= 3)) continue;
      }
      out.push({ topic: topic.name, note });
    }
  }
  return out;
}

// The user's verdict on one such note.
function settleNote(t, topic, note, action) {
  if (action === "delete") {
    const found = readTopic(topic);
    if (found) writeTopic({ ...found, notes: found.notes.filter((entry) => entry !== note) });
  } else {
    provenance.kept[t] = [...new Set([...(provenance.kept[t] ?? []), noteKey(topic, note)])];
    writeSealed(SOURCES, JSON.stringify(provenance));
  }
  emit({ type: "review", t, notes: notesFrom(t) });
}

function memoryTool(name, args, sources = null) {
  const topic = String(args.topic ?? "").trim();
  if (name === "end_interview") {
    interviewing = false;
    emit({ type: "interview", active: false });
    return "The interview is over.";
  }
  if (!slug(topic)) return "No topic given.";
  const existing = readTopic(topic);
  if (name === "recall") {
    emit({ type: "recall", topic });
    if (!existing) return `There is no topic called ${topic}. Your topics:\n${topicList()}`;
    // Older notes were sometimes written in the user's own voice.
    return `${existing.name}: ${existing.description}\n(These are notes about ${cfg.userName ?? "the user"}. Where one says I, me or my, it means them, not you.)\n${existing.notes.map((note) => `- ${note}`).join("\n")}`;
  }
  if (name === "remember") {
    const note = String(args.note ?? "").trim();
    if (!note) return "No note given.";
    const today = new Date().toISOString().slice(0, 10);
    writeTopic({
      name: existing?.name ?? topic,
      description: existing?.description || args.description || "",
      notes: [...(existing?.notes ?? []), `${note} (${today})`],
    });
    // Tied to the exchanges it came from: those given, or the turn in hand once it is filed.
    const key = noteKey(existing?.name ?? topic, note);
    if (sources) sourced([key], sources); else noted.push(key);
    emit({ type: "memory", topic: existing?.name ?? topic, note });
    return existing ? "Saved." : `Saved, in the new topic ${topic}.`;
  }
  if (name === "rewrite_topic") {
    if (!existing) return `There is no topic called ${topic}.`;
    const notes = (Array.isArray(args.notes) ? args.notes : []).map(String).filter((note) => note.trim());
    const newName = String(args.new_name ?? "").trim() || existing.name;
    if (slug(newName) !== slug(topic) && readTopic(newName)) return `A topic called ${newName} already exists; recall and rewrite that one.`;
    rmSync(topicPath(topic), { force: true });
    if (notes.length) writeTopic({ name: newName, description: args.description || existing.description, notes });
    emit({ type: "memory", topic: newName, rewritten: true, notes: notes.length });
    return notes.length ? `Rewrote ${newName} with ${notes.length} notes.` : `Deleted ${topic}.`;
  }
  return `Unknown tool: ${name}`;
}

// ---------------------------------------------------------------- MCP servers

const mcpClients = new Map();
let mcpTools = []; // in Ollama's tool format, named server__tool

const mcpAll = new Map(); // per server: every tool it offers, or why it could not be reached

// Tools the servers offer that the model has not been given.
const withheld = () => [...mcpAll].flatMap(([server, known]) => (known.tools ?? [])
  .filter((tool) => !mcpTools.some((given) => given.function.name === `${server}__${tool.name}`))
  .map((tool) => tool.name));

async function connectMcpServers() {
  for (const [name, spec] of Object.entries(cfg.mcpServers)) {
    const client = new McpClient(name, spec);
    try {
      const offered = await client.start();
      mcpAll.set(name, { tools: offered });
      const tools = offered.filter((tool) => toolAllowed(spec, tool));
      mcpClients.set(name, client);
      for (const tool of tools) {
        if (!readOnly(tool)) changes.add(`${name}__${tool.name}`);
        mcpTools.push({
          type: "function",
          function: {
            name: `${name}__${tool.name}`,
            description: (readOnly(tool) ? "" : "Puts this action forward for the user's yes; call it as soon as they ask for it. ") + (tool.description ?? ""),
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
      }
      console.error(`mcp: ${name} connected, ${tools.length} tools`);
    } catch (error) {
      client.stop();
      mcpAll.set(name, { error: error.message });
      fail(`mcp: ${name} failed to connect: ${error.message}`);
    }
  }
}

// Drop every connection and make them again from the saved settings: how a
// change made in the settings window takes effect without a restart.
async function reconnectMcp() {
  for (const client of mcpClients.values()) client.stop();
  mcpClients.clear();
  mcpAll.clear();
  changes.clear();
  mcpTools = [];
  proposals = [];
  try { cfg.mcpServers = JSON.parse(readFileSync(configPath, "utf8")).mcpServers ?? {}; } catch { /* keep the ones we had */ }
  await connectMcpServers();
}

// A tool that changes something is not run when the model calls it. The call
// is held as a proposal; the model is told to say what it proposes and ask;
// and it is run here, not by the model, once the user's next words are a
// plain yes. The model's word that the user agreed is never what decides.
const toolLog = []; // the last few tool calls and the start of what came back
const changes = new Set(); // names of the tools that change things
let proposals = []; // [{ name, args }], all put forward in the same turn
let agreedTo = ""; // a question the user has just said yes to, asked in words with no proposal behind it
let acted = false; // something was put forward or carried out in this turn

const CHANGE_ASKED = /\b(add|create|make|new|delete|remove|archive|unarchive|update|change|edit|rename|move|mark|complete|finish|send|reply|forward|schedule|reschedule|cancel|set|put|tag|assign|draft|post|save)\b/i;
const CHANGE_CLAIMED = /\b(i've|i have|i just|i went ahead|has been|have been|is now|are now|it's been|all set|all done|taken care of|successfully)\b[^.?!]*\b(added|created|made|deleted|removed|archived|unarchived|updated|changed|edited|renamed|moved|marked|completed|sent|replied|forwarded|scheduled|rescheduled|cancelled|canceled|set|tagged|assigned|drafted|posted|saved|done)\b|\ball set\b|\bsuccessfully\b/i;
const CHANGE_SPOKEN_OF = /\b(i['’]?m|i am|i['’]ll|i will|i['’]m about to|i['’]m going to|let me)\b[^.?!]{0,40}\b(creat|add|remov|delet|updat|chang|renam|mov|archiv|mark|schedul|tagg|sett)(e|es|ed|ing)?\b|,\s*(ok|okay|alright|all right|right)\?\s*$/i;
const PERMISSION_ASKED = /\b(shall i|should i|want me to|would you like me to|do you want me to|like me to|is that (ok|okay|right|correct)|does that (work|sound)|sound (good|right)|go ahead|proceed|confirm)\b[^.!]*\?/i;
const LOOKUP_ASKED = /\b(my|the) (calendar|schedule|agenda|diary|tasks?|task list|to-?do( list)?s?|meetings?|appointments?|events?|projects?|notes?|inbox)\b|\b(what's|what is|anything|what do i have) (on|due|scheduled|planned|coming up)\b/i;
const PUTS_OFF = /\b(i(['’]d| would| will|['’]ll)? (need|have) to (check|look|search|recall|consult|review|pull|go through|see|clarify|verify|confirm|find out|ask)|let me (ask|consult|clarify|verify|confirm|find out|get|grab)|i(['’]ll| will) (ask|consult|find out)|i(['’]d| would) (need|have|want) to (first )?(check|look|search|recall|review)|let me (check|look|search|recall|pull|see|review|go through)|i(['’]ll| will| can| could) (check|look (that|it|this|in|at|through|up)|search|recall|pull)|i don['’]t have (that|this|it|any|access)[^.]*\b(memory|notes|record|information)|would you like me to (check|look|search|recall))\b/i;
const ORACLE_SAYS = "The Oracle says: ";
const ORACLE_RELAY = "The Oracle answered as follows. Give the user this answer now. Speak to them directly, as you: never of them by name or as he, she or they, even where the Oracle's wording does. Say once, in passing, that it comes from the Oracle, and then give the substance. Do not say what you did or are about to do, do not restate their question, and do not offer alternatives they did not ask about.";
const ORACLE_ASKED = /\b(ask|consult|check with|run (it|this|that) (by|past)|see what|find out from|look (it|this|that) up with)\b[^.?!]{0,30}\boracle\b|\boracle\b[^.?!]{0,20}\b(say|says|think|thinks|know|knows)\b/i;
const CURRENT_ASKED = /\b(this (weekend|week|season|month|year)|last (night|week|weekend|game|match|month)|yesterday['’]?s?|tonight['’]?s?|latest|newest|most recent|recently|right now|currently|these days|score[sd]?|standings|who won|did .{2,40} win|how did .{2,60} do\b|news|headlines|weather|forecast|temperature outside|stock price|share price|exchange rate|election|release date|new(est)? version|reviews?|reviewed|reception|received|box office|rotten tomatoes|metacritic|ratings?|came out|coming out|just released|premiered?|new (movie|film|album|book|show|series|season|episode|game|phone|model|release))\b/i;
const SUM_ASKED = /(\bpercent|%|\btimes\b|\bmultipl|\bdivided?\b|\bplus\b|\bminus\b|\bsum of\b|\badd(ed)? up\b|\btotal\b|\baverage\b|\bsquare root\b|\bsquared\b|\bcubed\b|\bhow much is\b|\bwhat(['’]s| is) \d|[\d)]\s*[+*\/×÷^]\s*[\d(]|\d\s+-\s+\d|\bsplit\b[^.?]*\b(ways|between|among)\b|\btip\b)/i;
const TIMELY = /\b(today|tonight|tomorrow|yesterday|now|currently|current|latest|newest|recent|this (morning|afternoon|evening|week|weekend|month|year)|next (week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|calendar|schedule|due|overdue|weather|news|price|score)\b/i;
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|right|correct|absolutely|definitely|please)?( ?(yes|please|do it|do that|go ahead|go for it|go on|confirm|confirmed|thats right|that is right|thats correct|sounds good|thats fine|fine))*( ?(please|thanks|thank you))?$/;

// Called with the user's words at the start of each turn. Returns what the
// model should be told about the proposal, if there was one.
async function settleProposal(text) {
  const said = words(text.replace(new RegExp(cfg.name, "gi"), "")).join(" ");
  agreedTo = "";
  // A yes with nothing waiting: the model asked permission in words alone.
  if (!proposals.length && changes.size && said && YES.test(said)) {
    // What it asked, so that the same thing, called for now, can go ahead on this yes.
    const asked = history.filter((message) => message.role === "assistant" && message.content).at(-1)?.content ?? "";
    if (/\?\s*$/.test(asked.trim())) agreedTo = asked;
    return "The user has said yes, but nothing has been put forward, so nothing has been carried out. If you were asking "
      + "permission to change something, call its tool now, and do not say it is done.";
  }
  if (!proposals.length) return "";
  const waiting = proposals;
  proposals = [];
  const list = waiting.map(({ name, args }) => `${name} with ${JSON.stringify(args)}`).join("; ");
  if (!said || !YES.test(said)) {
    for (const { name } of waiting) emit({ type: "confirm", name, done: false });
    return `You had proposed: ${list}. The user did not plainly agree, so NONE of it has been done and the proposal is dropped. `
      + "If they still want it, or want it changed, call the tools again to propose it afresh.";
  }
  for (const { name, args } of waiting) {
    emit({ type: "confirm", name, done: true });
    const [server, tool] = name.split(/__(.*)/s);
    let result;
    try { result = (await mcpClients.get(server).call(tool, args)).slice(0, 4000); } catch (error) { result = `It failed: ${error.message}`; }
    did(name, args, `Carried out just now, on the user's yes. ${result}`);
  }
  acted = true;
  return "What the user agreed to has just been carried out, as the results above show. Do not call those tools again; tell them briefly how it went.";
}

// What kind of question this is. The model is asked to sort it, which it does
// well, and not whether it knows the answer, which it does badly.
async function kindOf(text) {
  try {
    const before = history.filter((message) => message.role !== "tool" && message.content).slice(-3, -1)
      .map((message) => `${message.role === "user" ? "User" : cfg.name}: ${message.content.slice(0, 300)}`).join("\n");
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive, options: { temperature: 0 },
        format: { type: "object", properties: { kind: { type: "string", enum: ["yours", "conversation", "settled", "world", "current"] } }, required: ["kind"] },
        messages: [{
          role: "system",
          content: "Sort the user's latest message to a voice assistant into one kind. Do not answer it.\n"
            + "yours: about the user's own life, people, things, plans, notes, files or earlier conversations; or an instruction to the "
            + "assistant to remember, set, make, change or do something; or about the assistant itself.\n"
            + "conversation: small talk, feelings, opinions, jokes, brainstorming, naming things, wording, writing or rewriting, advice "
            + "on how to go about something where there is no single right answer.\n"
            + "world: any question of fact about the world that is not about what is happening now: a particular film, book, "
            + "piece of music, product, company, place or person; a figure, count, measurement or statistic; how something "
            + "works; anything in science, medicine, law, money or tax. This is the usual kind for a question of fact.\n"
            + "settled: only a fact a ten-year-old could answer without looking it up, such as the capital of a large country, "
            + "how many days are in a week, or who wrote a play taught in every school. Nothing about law, medicine, money, "
            + "technology or a particular modern work is ever settled. If there is any doubt, it is world, not settled.\n"
            + "current: depends on what is happening now or lately: news, results, scores, reviews, prices, weather, versions, "
            + "schedules, who holds a post, this year's rates or limits.",
        }, { role: "user", content: `${before ? `Earlier:\n${before}\n\n` : ""}The message to sort:\n${text}` }],
      }),
    });
    return JSON.parse((await response.json()).message.content).kind;
  } catch (error) {
    console.error(`router: ${error.message}`);
    return null;
  }
}

// The sum in what the user said, written out for the calculator; "" if there is none.
async function sumIntent(text) {
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        format: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
        messages: [{
          role: "system",
          content: "Write the arithmetic the user is asking for as one expression for a calculator, and do not work it out. Use only "
            + "numbers, + - * / ^, brackets, and % for per cent, as in: 17% * 3480; (186 * 1.20) / 4; 350 / 450 * 100; 100 - 15%; "
            + "sqrt(144); average(72, 88, 95). Give an empty expression if the message does not ask for a calculation.",
        }, { role: "user", content: text }],
      }),
    });
    return String(JSON.parse((await response.json()).message.content).expression ?? "").trim();
  } catch (error) {
    console.error(`sums: ${error.message}`);
    return "";
  }
}

// The question put to the user about a proposal. The model that made the
// proposal is not left to word it: having called the tool, it tends to say
// the thing is done. This is a separate request that can only ask.
async function proposalQuestion() {
  const each = proposals.map(({ name, args }) => `${name.split("__")[1].replace(/_/g, " ")}${Object.keys(args ?? {}).length ? ` with ${Object.entries(args).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ")}` : ""}`);
  const plain = `I'm about to ${each.join(", and ")}. Shall I go ahead?`;
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        think: false,
        keep_alive: cfg.ollama.keepAlive,
        messages: [{
          role: "system",
          content: `You word one question for ${cfg.name}, a voice assistant. The user asked for something that changes their data. `
            + "It has NOT been done. Write a single short spoken sentence that says exactly what is about to be done, every action "
            + "listed, in plain words and using the names of things from the conversation, and asks whether to go ahead. It must be "
            + "a question. Nothing else. "
            + cfg.style,
        }, {
          role: "user",
          content: `The conversation so far:\n${history.filter((message) => message.role !== "tool" && message.content).slice(-6).map((message) => `${message.role === "user" ? "User" : cfg.name}: ${message.content}`).join("\n")}`
            + `\n\nWaiting for a yes: ${proposals.map(({ name, args }) => `${name} with ${JSON.stringify(args)}`).join("; ")}`,
        }],
      }),
    });
    const question = (await response.json()).message.content.trim().replace(/\s+/g, " ");
    return question.endsWith("?") && question.length < 300 ? question : plain;
  } catch {
    return plain;
  }
}

const plain = (text) => words(String(text)).join(" ");

// The words in a tool's arguments that say what is being done: names and
// titles, not ids.
function particulars(args) {
  const out = [];
  const walk = (value) => {
    if (typeof value === "string") { if (value.trim().length >= 3 && !/^[0-9a-f-]{16,}$/i.test(value.trim()) && !/^\d{4}-\d{2}-\d{2}/.test(value)) out.push(value); }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(args ?? {});
  return out;
}

// When something is being made, only what the user said goes into it. Left to
// itself the model added tags, projects and notes of its own devising. An
// argument the tool does not require, whose words the user never spoke in
// this conversation, is taken out (dates are kept if a day was spoken of).
// Returns the names of what was taken out.
function pare(name, args) {
  const [server, tool] = name.split(/__(.*)/s);
  if (!/creat|add|append|new/i.test(tool)) return [];
  const schema = mcpAll.get(server)?.tools?.find((entry) => entry.name === tool)?.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  const spoken = plain(history.filter((message) => message.role === "user").map((message) => message.content).join(" "));
  const dayNamed = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|due|by the|\d{1,2}(st|nd|rd|th)|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(spoken);
  const grounded = (value) => {
    if (typeof value === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return dayNamed;
      return value.trim().length < 3 || plain(value).split(" ").every((word) => spoken.includes(word));
    }
    if (Array.isArray(value)) return value.length > 0 && value.every(grounded);
    return true; // numbers and switches are left alone
  };
  const left = [];
  for (const key of Object.keys(args ?? {})) {
    if (required.has(key) || grounded(args[key])) continue;
    delete args[key];
    left.push(key);
  }
  return left;
}

async function mcpTool(name, args) {
  const [server, tool] = name.split(/__(.*)/s);
  const client = mcpClients.get(server);
  if (!client || !mcpTools.some((entry) => entry.function.name === name)) return `Unknown tool: ${name}`;
  if (changes.has(name)) {
    const left = pare(name, args);
    const omitted = left.length ? ` (Left out, because the user did not ask for them: ${left.join(", ")}. Do not add what was not asked for.)` : "";
    // The user has just said yes to a question about this very thing: every
    // particular now given was in the question, so it goes ahead on that yes.
    if (agreedTo && particulars(args).length && particulars(args).every((value) => plain(agreedTo).includes(plain(value)))) {
      agreedTo = "";
      acted = true;
      emit({ type: "confirm", name, args });
      emit({ type: "confirm", name, done: true });
      let result;
      try { result = (await client.call(tool, args)).slice(0, 4000); } catch (error) { result = `It failed: ${error.message}`; }
      toolLog.push({ t: Date.now(), name, args, result: result.slice(0, 400) });
      return `Carried out just now, on the user's yes. ${result}${omitted}`;
    }
    proposals.push({ name, args });
    acted = true;
    emit({ type: "confirm", name, args });
    return omitted + " This changes something, so it has NOT been done yet. Tell the user exactly what you are about to do, with the details that matter, "
      + "and ask them to say yes. It will be carried out for you when they do. Do not say it is done.";
  }
  // A weekday name that reaches a tool all the same is made a date on the way.
  args = Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => {
    const date = typeof value === "string" && /day$/i.test(value.trim()) && !/^(to|yester)day$/i.test(value.trim()) ? reminders.dateOf(value) : null;
    return [key, date ?? value];
  }));
  emit({ type: "tool", name, args });
  fresh = true;
  let result;
  try {
    // A small model's context is easily flooded by one large result.
    result = (await client.call(tool, args)).slice(0, 12_000);
  } catch (error) {
    result = `The tool failed: ${error.message}`;
  }
  // Kept in memory only, for `heyclaude tools`: when an answer is wrong, this
  // says whether the tool was asked the wrong thing or answered it wrongly.
  toolLog.push({ t: Date.now(), name, args, result: result.slice(0, 400) });
  if (toolLog.length > 40) toolLog.shift();
  return result;
}

// ---------------------------------------------------------------- Morgan

const transcript = new Transcript({
  // A trial run, with its own memory folder, keeps its own transcript too.
  dir: process.env.HEYCLAUDE_MEMORY ? join(MEMORY, "history") : join(SPEECH, "history"),
  url: cfg.ollama.url,
  model: cfg.embedModel,
});

let history = []; // user, assistant and tool messages, without the system prompt
let began = 0; // when the conversation in progress started
let unfiled = 0; // exchanges since memory was last brought up to date
let lastFiled = 0; // the exchange most recently filed, for "that was wrong"
let recalled = []; // earlier exchanges shown to the model this turn
let remembered = []; // and earlier threads
let seen = ""; // what was looked at for this turn, before the model was asked
let fresh = false; // this turn's answer drew on something live: a tool, the Oracle, a look
const lookups = new WeakSet(); // the user messages of turns answered from something live
const exchangeOf = new WeakMap(); // a user message in the conversation -> the exchange it was filed as

seedTopics();
transcript.reindex();
// Not at once: the first thing said after a start should not have to wait behind this.
setTimeout(() => backfillThreads().catch((error) => console.error(`threads: ${error.message}`)), 30_000).unref();

// A conversation interrupted by a restart carries on where it left off.
for (const item of transcript.since(Date.now() - cfg.idleResetMinutes * 60_000)) {
  if (item.hidden) continue;
  const restored = { role: "user", content: item.user };
  exchangeOf.set(restored, item.t);
  if (item.live) lookups.add(restored);
  history.push(restored, { role: "assistant", content: item.morgan });
  began ||= item.t;
  unfiled++;
}

async function searchTool(args) {
  const day = (text, end) => {
    const time = Date.parse(`${text}T00:00:00`);
    return Number.isNaN(time) ? undefined : time + (end ? 86_400_000 : 0);
  };
  const hits = await transcript.search({
    query: String(args.query ?? "").trim() || undefined,
    from: day(args.from) ?? 0,
    to: Math.min(day(args.to, true) ?? Infinity, began || Infinity),
    limit: 8,
  });
  emit({ type: "recall", topic: args.query ?? `${args.from ?? ""} to ${args.to ?? ""}` });
  const about = args.query ? (await transcript.searchThreads({ query: String(args.query), to: began || Infinity, limit: 3, live: true })).filter((hit) => hit.score >= 0.45) : [];
  const found = [...about.map((hit) => describeThread(hit, 500)), ...hits.map((hit) => describe(hit, 700))];
  return found.length ? found.join("\n") : "Nothing was found.";
}

// Thumbs down: the exchange stays on the record and is kept from the model
// for good. It comes out of the conversation in hand, so that a wrong answer
// is not built on; it is no longer found by search; and any thread it was
// part of is made again without it. Thumbs up marks an answer as one to
// prefer; a third press clears either.
function rate(t, vote) {
  const outcome = transcript.rate(t, vote);
  if (!outcome) return false;
  if (vote === "down") {
    const at = history.findIndex((message) => exchangeOf.get(message) === t);
    if (at >= 0) {
      let end = at + 1;
      while (end < history.length && history[end].role !== "user") end++;
      history.splice(at, end - at);
    }
    for (const rest of outcome.stale) if (rest.length) fileThreads(rest);
  }
  emit({ type: "rated", t, vote });
  // Notes that may have been taken from it are not deleted: they are put to the user.
  if (vote === "down") emit({ type: "review", t, notes: notesFrom(t) });
  return true;
}

// Said aloud or typed, at the start of a turn: the last answer is struck, as
// by a thumbs down, and anything said after it is the turn.
const STRIKE = /^(no[,.]?\s+)?(that(['’]s| is| was) (wrong|incorrect|not right|not true|not correct)|scratch that|strike that|forget (that|what you (just )?said))\b[.!,;:]?\s*/i;

// When a conversation is over it is cut into threads: the exchanges that were
// about one thing, wherever in the conversation they fell, with a title and
// a summary. A conversation is not a thread. One that was never cleared may
// run from a recipe to a meeting to a timer and back, and what is wanted
// later is the part about the recipe.
async function fileThreads(items) {
  if (!items.length) return;
  const numbered = items.map((item, index) => `${index + 1}. User: ${item.user.replace(/\s+/g, " ").slice(0, 500)}\n   ${cfg.name}: ${item.morgan.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  let threads = null;
  try {
    const response = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false, keep_alive: cfg.ollama.keepAlive,
        format: {
          type: "object",
          properties: {
            threads: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, summary: { type: "string" }, exchanges: { type: "array", items: { type: "integer" } } },
                required: ["title", "summary", "exchanges"],
              },
            },
          },
          required: ["threads"],
        },
        messages: [{
          role: "system",
          content: `These are the numbered exchanges of one conversation between ${cfg.userName ?? "a user"} and ${cfg.name}, an assistant. `
            + "The conversation may wander over several subjects and come back to one. Sort the exchanges into threads: each thread is the "
            + "exchanges about one subject, whether or not they were next to each other. Every exchange goes in exactly one thread; a "
            + "subject touched once is a thread of one. For each thread give a title of a few words, and a summary of one to three "
            + `sentences saying what ${cfg.userName ?? "the user"} asked or said and what was decided, learned or left open, with the names, `
            + "numbers and dates that matter. Say only what the exchanges say.",
        }, { role: "user", content: numbered }],
      }),
    });
    threads = JSON.parse((await response.json()).message.content).threads;
  } catch (error) {
    console.error(`threads: ${error.message}`);
  }
  // Each exchange once, and none left out; failing that, the conversation is kept as one thread.
  const seen = new Set();
  const sound = Array.isArray(threads) && threads.length > 0 && threads.every((thread) => Array.isArray(thread.exchanges)
    && thread.exchanges.every((number) => Number.isInteger(number) && number >= 1 && number <= items.length && !seen.has(number) && seen.add(number)));
  if (!sound) threads = [{ title: items[0].user.replace(/\s+/g, " ").slice(0, 60), summary: items.map((item) => item.user.replace(/\s+/g, " ")).join(" / ").slice(0, 400), exchanges: items.map((_, index) => index + 1) }];
  const left = items.map((_, index) => index + 1).filter((number) => !seen.has(number));
  if (sound && left.length) threads.push({ title: "Other remarks", summary: left.map((number) => items[number - 1].user.replace(/\s+/g, " ")).join(" / ").slice(0, 400), exchanges: left });
  for (const thread of threads) {
    const members = thread.exchanges.map((number) => items[number - 1]).sort((a, b) => a.t - b.t);
    if (members.length) await transcript.addThread({ title: String(thread.title).trim(), summary: String(thread.summary).trim(), items: members });
  }
}

// Conversations from before threads were kept, or cut short by a restart:
// taken a conversation at a time, a conversation ending where nothing was said
// for as long as it takes one to lapse.
async function backfillThreads() {
  const loose = transcript.unthreaded().filter((item) => !began || item.t < began);
  let group = [];
  for (const item of loose) {
    if (group.length && item.t - group.at(-1).t > cfg.idleResetMinutes * 60_000) { await fileThreads(group); group = []; }
    group.push(item);
  }
  if (group.length) await fileThreads(group);
}

// When a conversation is over, read it back and file what should last. In the
// moment Morgan saves what it notices; this catches what it did not.
async function fileAway(turns, from = []) {
  // Answers that came from a lookup are left out: a day's calendar or a task
  // list is not something to remember, and read back it looks as if it were.
  let lookedUp = false;
  const text = turns
    .filter((message) => message.role !== "tool" && message.content)
    .map((message) => {
      if (message.role === "user") { lookedUp = lookups.has(message); return `User: ${message.content.slice(0, 2000)}`; }
      return lookedUp ? `${cfg.name}: (answered by looking something up; nothing in the answer is to be remembered)` : `${cfg.name}: ${message.content}`;
    })
    .join("\n");
  const messages = [{
    role: "system",
    content: [
      `You are ${cfg.name}, looking back over a conversation you have just had with the user in order to keep your`,
      `long-term memory of them up to date. Write each note in the third person about ${cfg.userName ?? "the user, by name if you know it"}, never as I.`,
      "Save anything lasting that is not already in memory: facts about them,",
      "their people, work, projects, plans, routines and preferences, and decisions reached. Save only what the user",
      "said about themselves: a question they asked is not a fact about them, and neither is what a calendar, task list",
      "or search showed. Ignore small talk and",
      "anything that only mattered in the moment. Recall a topic before adding to it, so that you do not repeat what",
      "is there. File each note under the topic whose description it fits, not all under one. Use rewrite_topic to correct",
      "what has changed, and when a topic has grown past about twenty notes, to split it: keep part, and remember the rest",
      "under a new, narrower topic. When there is",
      `nothing more to save, reply with the single word done.\n\nYour memory topics:\n${topicList()}`,
    ].join(" "),
  }, { role: "user", content: `The conversation:\n\n${text}` }];
  const tools = MORGAN_TOOLS.filter((tool) => ["recall", "remember", "rewrite_topic"].includes(tool.function.name));
  try {
    for (let round = 0; round < 8; round++) {
      const response = await fetch(`${cfg.ollama.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: cfg.ollama.model, stream: false, think: cfg.ollama.think, keep_alive: cfg.ollama.keepAlive, tools, messages }),
      });
      if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
      const reply = (await response.json()).message;
      messages.push(reply);
      if (!reply.tool_calls?.length) break;
      for (const call of reply.tool_calls) {
        messages.push({ role: "tool", tool_name: call.function.name, content: memoryTool(call.function.name, call.function.arguments ?? {}, from) });
      }
    }
  } catch (error) {
    console.error(`filing memory: ${error.message}`);
  }
}
let turn = 0; // bumped whenever the current turn is abandoned
let abort = null;
let lastActivity = 0;

// A typed turn is answered in text only; a spoken one is read aloud.
async function ask(text, { typed = false, files = [] } = {}) {
  text = text.trim();
  interrupt();
  quiet = typed;
  if (typed) spokenTurn = false;
  if (!text && files.length) text = files.length > 1 ? "Here are some files." : "Here is a file.";
  // "That was wrong": the last answer is struck before anything else happens.
  let struck = false;
  let struckAt = 0;
  if (lastFiled && STRIKE.test(text)) {
    struckAt = lastFiled;
    struck = rate(lastFiled, "down");
    lastFiled = 0;
    text = text.replace(STRIKE, "").trim();
    if (struck && !text) {
      const about = notesFrom(struckAt).length;
      const line = `Struck. I won't go by that again.${about ? ` ${about === 1 ? "One note in my memory" : `${about} notes in my memory`} may have come from it; ${about === 1 ? "it is" : "they are"} in the chat window for you to look over.` : ""}`;
      emit({ type: "assistant", text: line });
      setState("thinking");
      speakDelta(`${line} `);
      speakFlush();
      return finishSpeaking();
    }
  }
  if (!text) return setState("idle");
  if (lastActivity && Date.now() - lastActivity > cfg.idleResetMinutes * 60_000) reset();
  const mine = ++turn;
  lastActivity = Date.now();
  began ||= lastActivity;
  // Attached files are read here and handed over with the message. The
  // conversation carries their contents; the transcript keeps only their names.
  const names = files.map((file) => basename(file));
  emit({ type: "user", text: names.length ? `${text}\n\n${names.map((name) => `📎 ${name}`).join("\n")}` : text });
  setState("thinking");
  let attached = "";
  for (const file of files) {
    let content;
    try { content = await readDocument(home(file), text); } catch (error) { content = `(It could not be read: ${error.message.split("\n")[0]})`; }
    if (mine !== turn) return;
    attached += `\n\n[The user attached the file ${basename(file)}. Its contents:]\n${content}\n[End of ${basename(file)}]`;
  }
  const asked = { role: "user", content: text + attached };
  history.push(asked);
  if (names.length) text = `${text} [attached: ${names.join(", ")}]`;
  let spoke = false;
  const said = [];
  const told = [];
  const saw = [];
  fresh = false;
  noted = [];
  try {
    // Earlier talk is brought back a thread at a time: what it was about and
    // how it came out, with the exchange or two that bear on this. A single
    // exchange on its own ("yes, do that") often says nothing.
    const threads = TIMELY.test(text) ? [] : (await transcript.searchThreads({ query: text, to: began, limit: 2 })).filter((hit) => hit.score >= cfg.threadScore);
    if (process.env.HEYCLAUDE_DEBUG) console.error("threads", threads.map((hit) => `${hit.score.toFixed(2)} ${hit.thread.title}`));
    remembered = threads;
    const inThreads = new Set(threads.flatMap((hit) => hit.thread.ts));
    const hits = (await transcript.search({ query: text, to: began, limit: 6 })).filter((hit) => !inThreads.has(hit.item.t) && transcript.unthreaded().includes(hit.item));
    if (process.env.HEYCLAUDE_DEBUG) console.error("recall", hits.map((hit) => `${hit.score.toFixed(2)} ${hit.item.live ? "live " : ""}${hit.item.user.slice(0, 40)}`));
    // An old answer that came from a calendar, a task list, the web or the
    // camera is a record of how things stood, not of how they stand. Shown
    // unasked, it gets repeated in place of looking again; so it is not shown,
    // and nothing is when the question is about now.
    recalled = TIMELY.test(text) ? [] : hits.filter((hit) => hit.score >= cfg.recallScore && !hit.item.live).slice(0, 3);
    if (mine !== turn) return;
    acted = false;
    seen = await settleProposal(text);
    if (struck) seen += " The user has just said that your last answer was wrong. It has been struck from the record: do not repeat it or rely on it.";
    if (mine !== turn) return;
    // Where the user may be asking for a change, the answer is held back
    // until it is whole, so that a false "done" is never spoken.
    // A question about what has been done ("did you create it?") is not a
    // request to do it, and a true "yes, I created it" is not to be taken for a false one.
    const asking = /^(did|have|has|had|is|was|are|were|do|does|what|which|when|where|why|how|who)\b/i.test(text.trim());
    const guarded = changes.size > 0 && !asking && (CHANGE_ASKED.test(text) || YES.test(words(text).join(" ")));
    let nudges = 0; // times it has been sent back for speaking of a change without calling for it
    // A question about the user's own calendar, tasks or notes cannot be
    // answered without looking them up; an answer given without a tool call
    // is held back and sent round again.
    const lookup = mcpTools.length > 0 && LOOKUP_ASKED.test(text);
    // A sum is likewise not to be answered without being worked out.
    const sums = /\d/.test(text) && SUM_ASKED.test(text);
    // Something recent or current is likewise not to be answered from what the model happens to believe.
    const current = CURRENT_ASKED.test(text) && !LOOKUP_ASKED.test(text);
    let worked = false;
    let credited = false; // the Oracle has been named as the source of what it supplied
    let corrected = false;
    let called = false;
    try { picked = await pickNotes(text); } catch (error) { picked = ""; console.error(error.message); }
    if (mine !== turn) return;
    // A sum is worked out here, before the model answers: asked to call the
    // calculator itself, it mostly answered from its head instead, and wrongly.
    if (sums) {
      const sum = await sumIntent(text);
      if (mine !== turn) return;
      if (sum) {
        try {
          did("calculate", { expression: sum }, `${sum} = ${calculate(sum)}. Give the user that number; do not work it out again yourself.`);
          emit({ type: "tool", name: "calculate", args: { expression: sum } });
          worked = true;
        } catch { /* not a sum after all, or not one that could be written out */ }
      }
    }
    // Something recent or current, or a request to ask the Oracle, is put to
    // the Oracle here. Told to consult it, the model as often wrote "the
    // Oracle says" and made the rest up.
    let kind = current || ORACLE_ASKED.test(text) ? "current" : null;
    if (!kind && cfg.router && !lookup && !sums && !guarded && !files.length && words(text).length >= 3) {
      kind = await kindOf(text);
      if (mine !== turn) return;
      emit({ type: "kind", kind });
    }
    if (kind === "current" || kind === "world") {
      setState("consulting");
      let answer = "";
      if (kind === "world") {
        // From what the smaller model knows, which takes a couple of seconds.
        emit({ type: "consult", question: text, quick: true });
        answer = await consultOracle(text, true);
        if (mine !== turn) return;
      }
      if (kind === "current" || /^\W*SEARCH\b/i.test(answer) || !answer) {
        // Looked up, which takes long enough to say so.
        enqueue(cfg.consultLine);
        emit({ type: "consult", question: text });
        answer = await consultOracle(text);
      }
      if (mine !== turn) return;
      emit({ type: "oracle", text: answer });
      told.push(answer);
      fresh = true;
      called = true;
      did("consult_oracle", { question: text }, `${ORACLE_RELAY}\n\n${answer}`);
      setState("thinking");
    }
    // A day the user named is turned into its date here, where it is certain.
    const named = reminders.daysNamed(text);
    if (named.length) seen += ` The user named ${named.length > 1 ? "days" : "a day"}. As dates: ${named.join("; ")}. Use those dates.`;
    await reminderIntent(text);
    if (mine !== turn) return;
    seen += await keepIntent(text, files);
    if (mine !== turn) return;
    const intent = await sightIntent(text);
    if (mine !== turn) return;
    if (intent) {
      emit({ type: "look", source: intent.look });
      const view = await look(intent.look, { question: text });
      if (mine !== turn) return;
      saw.push(view);
      did(SIGHT[intent.look].tool, { question: text }, `What you see:\n${view}`);
      if (intent.remember) {
        const label = intent.label || cfg.userName || "the user";
        const kept = await rememberPicture({ label, source: intent.look });
        if (mine !== turn) return;
        did("remember_picture", { label, source: intent.look }, kept);
      }
    }
    // Morgan may use its tools several times in a turn, but not for ever.
    for (let round = 0; round < 8; round++) {
      let draft = "";
      let shown = 0;
      let begun = false; // the opening sentence has been heard out and let through
      let putOff = false; // it opens by saying it would have to look, instead of looking
      let creditHere = false;
      let invented = false; // it credits the Oracle with something the Oracle was never asked
      const reply = await morgan(mine, (delta) => {
        if (guarded || lookup || sums || current) return; // held back until it is known to be true
        draft += delta;
        if (!begun) {
          // Nothing is said until the first sentence is in and can be judged.
          if (!/[.!?…]+\s/.test(draft) && draft.length < 200) return;
          begun = true;
          if (PUTS_OFF.test(draft)) { putOff = true; return; }
          // "The Oracle checked for you", when it was never asked.
          if (!told.length && !/\boracle\b/i.test(text) && /\boracle\b/i.test(draft)) { putOff = invented = true; return; }
          // What the Oracle supplied is said to be the Oracle's. The model was
          // asked to say so and often did not, so it is said for it.
          if (told.length && !credited && !/\boracle\b/i.test(draft)) { draft = ORACLE_SAYS + draft; credited = creditHere = true; }
          spoke = true;
          speakDelta(draft);
          return;
        }
        if (putOff) return;
        spoke = true;
        speakDelta(delta);
        // The answer so far, for the chat window to show as it is written.
        if (Date.now() - shown > 120) { shown = Date.now(); emit({ type: "partial", text: draft }); }
      });
      if (mine !== turn) return;
      if (creditHere) reply.content = ORACLE_SAYS + reply.content;
      else if (told.length && !credited && reply.content && !reply.tool_calls?.length && !/\boracle\b/i.test(reply.content)) {
        reply.content = ORACLE_SAYS + reply.content;
        credited = true;
      }
      if (!guarded && !lookup && !sums && !current && !begun && reply.content) {
        // Too short to have reached a full stop while it was being written.
        if (PUTS_OFF.test(reply.content)) putOff = true;
        else { spoke = true; speakDelta(reply.content); }
      }
      if (!invented && !told.length && !reply.tool_calls?.length && !/\boracle\b/i.test(text) && /\boracle\b/i.test(reply.content)) invented = putOff = true;
      if (invented && !reply.tool_calls?.length) {
        if (!corrected) {
          corrected = true;
          seen += " You have just drafted a reply saying the Oracle told you something. It did not: you have not consulted it in this"
            + " turn, so what you wrote is made up. Call consult_oracle now with the question, and answer only from what it returns.";
          continue;
        }
        reply.content = "I don't know, and I wasn't able to reach the Oracle to find out.";
        putOff = false;
        spoke = true;
        speakDelta(`${reply.content} `);
      }
      // Something current cannot be known without asking: an answer given with no lookup is sent back.
      if (current && !called && !reply.tool_calls?.length && !corrected) {
        corrected = true;
        seen += " You have just drafted an answer about something recent or current (a result, a score, the news, the weather, a"
          + " latest version) without looking it up. You cannot know it. Call consult_oracle now, and answer from what it returns.";
        continue;
      }
      if (putOff) {
        if (!reply.tool_calls?.length && !corrected) {
          // "I'd need to check my memory", and then nothing. It is sent back to check.
          corrected = true;
          seen += " You have just drafted a reply saying that you would need to check, look up or recall something. Do not say so:"
            + " do it now. Call recall for your memory topics, recall_document for a kept document, search_conversations for"
            + " earlier talk, or the tool that holds what is wanted; then answer from what comes back.";
          continue;
        }
        if (reply.tool_calls?.length) {
          // "Let me ask the Oracle about that", and it is asking. Nobody needs
          // to hear the announcement, and strung in front of the answer it made
          // the answer read as a running commentary.
          reply.content = "";
        } else {
          // Told once already, and still at it: let it be heard.
          spoke = true;
          speakDelta(`${reply.content} `);
        }
      }
      if (mine !== turn) return;
      called ||= Boolean(reply.tool_calls?.length);
      if (sums && !worked && !reply.tool_calls?.length && !corrected) {
        corrected = true;
        seen += " You have just drafted an answer to a sum without working it out. Call calculate with the sum written out, and"
          + " give the user the number it returns.";
        continue;
      }
      if (lookup && !called && !corrected) {
        corrected = true;
        seen += " You have just drafted an answer about the user's calendar, tasks or notes without looking anything up, so it"
          + " cannot be right. Call the tool that holds it now, and answer from what comes back.";
        continue;
      }
      if (guarded && !acted && !reply.tool_calls?.length && (CHANGE_CLAIMED.test(reply.content) || PERMISSION_ASKED.test(reply.content) || CHANGE_SPOKEN_OF.test(reply.content))) {
        // It says it did, is doing or is about to do something, or asks leave
        // to, and has called nothing: so nothing was done, and there is
        // nothing for a yes to act on. Once, it is sent back to call the
        // tool; after that the user is simply told the truth.
        if (nudges < 2) {
          nudges++;
          seen += " You have just drafted a reply that speaks of making a change (saying it is done, or being done, or asking leave"
            + " to do it) without calling the tool for it. Nothing has happened. Call the tool now, with exactly what the user"
            + " asked for; calling it puts the action forward, and the user is then asked for you.";
          continue;
        }
        reply.content = "I haven't actually done that yet. Could you ask me again?";
      }
      history.push(reply);
      if (reply.content) {
        said.push(reply.content);
        emit({ type: "assistant", text: reply.content });
        // A held-back answer is spoken now, unless a proposal's question is about to replace it.
        if ((guarded || lookup || sums || current) && !reply.tool_calls?.length) speakDelta(`${reply.content} `);
      }
      if (!reply.tool_calls?.length) break;
      speakFlush();
      for (const call of reply.tool_calls) {
        let result;
        if (call.function.name.includes("__")) {
          result = await mcpTool(call.function.name, call.function.arguments ?? {});
          if (mine !== turn) return;
        } else if (call.function.name === "remember_picture") {
          emit({ type: "look", source: String(call.function.arguments?.source ?? "camera") });
          result = await rememberPicture(call.function.arguments ?? {});
          if (mine !== turn) return;
        } else if (call.function.name === "forget_picture") {
          result = forgetPicture(call.function.arguments ?? {});
        } else if (call.function.name.startsWith("look_at_")) {
          const source = call.function.name.slice(8);
          if (!cfg.sight.includes(source)) { result = "You are not allowed to look at that."; } else {
            emit({ type: "look", source });
            result = await look(source, call.function.arguments ?? {});
            if (mine !== turn) return;
            saw.push(result);
            result = `What you see:\n${result}`;
          }
        } else if (call.function.name === "calculate") {
          const sum = String(call.function.arguments?.expression ?? "");
          try { result = `${sum} = ${calculate(sum)}`; worked = true; } catch (error) { result = `That could not be worked out: ${error.message}. Write the sum with numbers and + - * / ^ % and brackets only.`; }
          emit({ type: "tool", name: "calculate", args: { expression: sum } });
        } else if (call.function.name === "recall_document") {
          result = recallDocument(call.function.arguments ?? {});
        } else if (["list_folder", "find_files", "read_file"].includes(call.function.name)) {
          emit({ type: "tool", name: call.function.name, args: call.function.arguments ?? {} });
          result = await fileTool(call.function.name, call.function.arguments ?? {});
          if (mine !== turn) return;
        } else if (call.function.name === "search_conversations") {
          result = await searchTool(call.function.arguments ?? {});
          if (mine !== turn) return;
        } else if (call.function.name === "remember" && fresh && !KEEP_WORDS.test(text)) {
          // What tomorrow's calendar holds is not a fact about the user.
          result = "Not saved. This turn was answered from a lookup, and what a lookup returns is how things stand today, not "
            + "something to remember about the user. Only what they tell you about themselves is.";
        } else if (call.function.name !== "consult_oracle") {
          result = memoryTool(call.function.name, call.function.arguments ?? {});
        } else {
          if (!spoke) enqueue(cfg.consultLine);
          setState("consulting");
          const question = String(call.function.arguments?.question ?? text);
          emit({ type: "consult", question });
          const answer = await consultOracle(question);
          if (mine !== turn) return;
          emit({ type: "oracle", text: answer });
          told.push(answer);
          fresh = true;
          result = `${ORACLE_RELAY}\n\n${answer}`;
          setState("thinking");
        }
        history.push({ role: "tool", tool_name: call.function.name, content: result });
      }
      if (proposals.length) {
        // The turn ends here, on a question the model does not get to answer for the user.
        const question = await proposalQuestion();
        if (mine !== turn) return;
        history.push({ role: "assistant", content: question });
        said.push(question);
        emit({ type: "assistant", text: question });
        speakDelta(`${question} `);
        break;
      }
      spoke = false;
    }
  } catch (error) {
    if (mine !== turn) return;
    fail(`${cfg.name}: ${error.message}`);
  }
  lastActivity = Date.now();
  if (fresh || saw.length || acted) lookups.add(asked);
  if (said.length) {
    unfiled++;
    const filed = Date.now();
    exchangeOf.set(asked, filed);
    lastFiled = filed;
    sourced(noted, [filed]);
    // So that whatever is showing the conversation can offer to mark this answer.
    emit({ type: "filed", t: filed });
    transcript.add({
      t: filed,
      user: text,
      morgan: said.join(" "),
      ...(saw.length ? { saw: saw.join(" ") } : {}),
      ...(told.length ? { oracle: told.join(" ") } : {}),
      ...(fresh || saw.length || acted ? { live: true } : {}),
    });
  }
  speakFlush();
  finishSpeaking();
}

// The turn's notes, put after the words of the user's latest message.
function withNotes(messages) {
  const last = messages.findLastIndex((message) => message.role === "user");
  if (last < 0) return messages;
  const copy = [...messages];
  copy[last] = { ...copy[last], content: `${copy[last].content}\n\n[Notes from the system for this turn:\n${turnNotes()}\n]` };
  return copy;
}

// One streamed chat completion. Text is passed on as it arrives.
async function morgan(mine, onText) {
  abort = new AbortController();
  const response = await fetch(`${cfg.ollama.url}/api/chat`, {
    method: "POST",
    signal: abort.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.ollama.model,
      stream: true,
      think: cfg.ollama.think,
      keep_alive: cfg.ollama.keepAlive,
      // With memory in front of it whole there is nothing for recall to fetch.
      tools: [...MORGAN_TOOLS.filter((tool) => !(memoryInFull() && tool.function.name === "recall")), ...sightTools(), ...fileTools(), ...documentTools(), ...mcpTools],
      messages: withNotes([{ role: "system", content: morganPrompt() }, ...history]),
    }),
  });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const reply = { role: "assistant", content: "" };
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const part = JSON.parse(line);
      if (part.error) throw new Error(part.error);
      const message = part.message ?? {};
      if (message.content) {
        reply.content += message.content;
        if (mine === turn) onText(message.content);
      }
      if (message.tool_calls?.length) reply.tool_calls = [...(reply.tool_calls ?? []), ...message.tool_calls];
    }
  }
  return reply;
}

function reset() {
  if (unfiled && !interviewing) fileAway(history, began ? transcript.since(began).filter((item) => !item.hidden).map((item) => item.t) : []);
  if (began) fileThreads(transcript.since(began).filter((item) => !item.hidden && !transcript.threads.some((thread) => thread.ts.includes(item.t))));
  unfiled = 0;
  began = 0;
  recalled = [];
  remembered = [];
  seen = "";
  proposals = [];
  history = [];
  interviewing = false;
  stopOracle();
  lastActivity = 0;
}

// Something the daemon did on the model's behalf, before asking it for its
// answer: looking, keeping a document, carrying out an agreed change. It is
// put into the conversation as a tool call the model made and the result that
// came back. Told about it any other way (a line in its instructions, say),
// the model takes it for something from an earlier turn, and answers "I had
// already saved that" about a thing saved a moment ago.
function did(name, args, result) {
  history.push(
    { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] },
    { role: "tool", tool_name: name, content: result },
  );
}

// Abandon whatever is in flight: speech, Morgan's stream, a consultation.
function interrupt() {
  turn++;
  stopSpeech();
  abort?.abort();
  abort = null;
  oracles.full.interrupt();
  oracles.quick.interrupt();
  // A turn cut off before Morgan answered would leave the history ending on a
  // user message or a tool call with no result; drop back to the last answer.
  while (history.length && !(history.at(-1).role === "assistant" && !history.at(-1).tool_calls?.length)) history.pop();
}

// ---------------------------------------------------------------- the Oracle
//
// Two of them, each a long-lived `claude -p` on the Oracle's own login. The
// full one has the web and takes its time; the quick one is a smaller model
// with no tools, for facts that want getting right but not looking up.

function oracleEnv() {
  // The Oracle has its own login. Nothing inherited may point it elsewhere.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC)/.test(key)) env[key] = value;
  }
  env.ANTHROPIC_CONFIG_DIR = join(CONFIG_HOME, "anthropic");
  env.CLAUDE_CONFIG_DIR = join(CONFIG_HOME, "claude");
  return env;
}

function makeOracle({ label, model, tools, allowed, prompt }) {
  let child = null;
  let buffer = "";
  let waiting = null; // { resolve } while a question is out
  let drop = false; // an interrupted question's answer is discarded

  const answer = (text) => {
    const pending = waiting;
    waiting = null;
    pending?.resolve(text);
  };

  function hear(message) {
    if (message.type === "assistant") {
      if (drop) return;
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") emit({ type: "tool", name: block.name });
      }
    } else if (message.type === "result") {
      if (drop) { drop = false; return; }
      const text = String(message.result ?? "").trim();
      answer(message.is_error ? `The Oracle could not answer: ${text}` : text);
    }
  }

  function start() {
    mkdirSync(WORKDIR, { recursive: true });
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", model(),
      "--append-system-prompt", prompt(),
      "--tools", tools().join(","),
    ];
    if (allowed().length) args.push("--allowedTools", allowed().join(","));
    const mine = spawn(cfg.oracle.claude, args, { cwd: WORKDIR, env: oracleEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child = mine;
    buffer = "";
    drop = false;
    mine.stdout.setEncoding("utf8");
    mine.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { hear(JSON.parse(line)); } catch { /* not a JSON line */ }
      }
    });
    mine.stderr.setEncoding("utf8");
    mine.stderr.on("data", (text) => console.error(`${label}:`, text.trimEnd()));
    mine.on("error", (error) => console.error(`${label}:`, error.message));
    mine.on("exit", (code) => {
      if (child !== mine) return;
      child = null;
      answer(`The Oracle could not be reached (exit code ${code}).`);
    });
  }

  return {
    ask(content) {
      if (!child) start();
      return new Promise((resolve) => {
        waiting = { resolve };
        child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      });
    },
    // Give up on the question that is out, and tell the model to stop working on it.
    interrupt() {
      if (!waiting) return;
      const { resolve } = waiting;
      waiting = null;
      drop = true;
      child?.stdin.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }) + "\n");
      resolve("");
    },
    stop() {
      const mine = child;
      child = null;
      mine?.kill("SIGTERM");
    },
  };
}

const oracles = {
  full: makeOracle({ label: "oracle", model: () => cfg.oracle.model, tools: () => cfg.oracle.tools, allowed: () => cfg.oracle.allowedTools, prompt: () => oraclePrompt() }),
  quick: makeOracle({ label: "quick oracle", model: () => cfg.oracle.quickModel, tools: () => [], allowed: () => [], prompt: () => quickPrompt() }),
};

function stopOracle() {
  oracles.full.stop();
  oracles.quick.stop();
}

// `quick`: the smaller model, from what it knows. It answers SEARCH when the
// question wants looking up, and the caller then asks the full one.
function consultOracle(question, quick = false) {
  // The Oracle gets the conversation so far: the question alone often leans
  // on something said earlier.
  const recent = history
    .filter((message) => message.role !== "tool" && message.content)
    .slice(-8)
    .map((message) => `${message.role === "user" ? cfg.userName ?? "User" : cfg.name}: ${message.content.slice(0, 1500)}`)
    .join("\n");
  // The name goes with each question too: the Oracle is started once and kept,
  // and the name may have been set since.
  const whose = cfg.userName ? ` (asked on behalf of ${cfg.userName})` : "";
  return oracles[quick ? "quick" : "full"].ask(`Recent conversation:\n${recent}\n\n${cfg.name}'s question for you${whose}:\n${question}`);
}

// ---------------------------------------------------------------- speech out

let pending = ""; // text received but not yet a whole sentence
let turnDone = false;
let quiet = false; // the current turn was typed, so nothing is spoken

function speakDelta(text) {
  pending += text;
  let match;
  // A sentence is spoken once the whitespace after its full stop has arrived.
  while ((match = pending.match(/^([\s\S]*?[.!?…]+)\s+/))) {
    enqueue(match[1]);
    pending = pending.slice(match[0].length);
  }
}

function speakFlush() {
  enqueue(pending);
  pending = "";
}

function enqueue(sentence) {
  const clean = sentence.replace(/[*_#`>]+/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  emit({ type: "sentence", text: clean });
  if (!cfg.tts || quiet) return;
  speakText(clean);
}

// Speaking. Sentences are turned into sound one after another as soon as
// they are written, ahead of being played, and all go to one player kept
// open for the run of speech. Made and played one at a time, each sentence
// waited for the last to finish before it was even started, and there was a
// pause between every two.
let voiceEpoch = 0; // bumped to abandon whatever is in hand
let making = Promise.resolve(); // the queue of sentences being turned into sound
const ready = []; // in order: { pcm } once made, { pcm: null } while being made
let player = null;
let playRate = 22050;
let playEnd = 0; // when what has been handed to the player will have been heard
let drainTimer = null;
let levelTimers = [];
let afterSpeech = null; // run once, when a run of speech has played out

const speaking = () => ready.length > 0 || Date.now() < playEnd;

// One sentence as raw 16-bit mono audio.
function synthesize(text) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks));
    if (kokoroReady) {
      const source = connect(KOKORO_SOCKET);
      source.on("data", (chunk) => chunks.push(chunk));
      source.on("end", done);
      source.on("error", done);
      source.end(text + "\n");
    } else {
      const synth = spawn("sh", ["-c", "exec " + cfg.tts.replace("{voice}", `'${voiceFile}'`)], { stdio: ["pipe", "pipe", "ignore"] });
      synth.stdin.on("error", () => {});
      synth.stdout.on("data", (chunk) => chunks.push(chunk));
      synth.on("close", done);
      synth.on("error", done);
      synth.stdin.end(text + "\n");
    }
  });
}

function speakText(text) {
  for (const [word, said] of Object.entries(cfg.pronunciations)) {
    text = text.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), said);
  }
  const job = { pcm: null };
  const epoch = voiceEpoch;
  ready.push(job);
  making = making.then(() => (epoch === voiceEpoch ? synthesize(text) : Buffer.alloc(0))).then((pcm) => {
    job.pcm = pcm;
    if (epoch === voiceEpoch) pump();
  });
}

// Hand the player whatever is made and next in line.
function pump() {
  while (ready.length && ready[0].pcm) {
    const { pcm } = ready.shift();
    if (!pcm.length) continue;
    if (!player) {
      playRate = kokoroReady ? 24000 : voiceRate;
      player = spawn("sh", ["-c", "exec " + cfg.play.replace("{rate}", playRate)], { stdio: ["pipe", "ignore", "ignore"] });
      player.stdin.on("error", () => {});
      player.on("error", () => {});
      playEnd = 0;
    }
    if (state === "thinking") setState("speaking");
    const begins = Math.max(Date.now(), playEnd);
    showLevels(pcm, begins - Date.now());
    player.stdin.write(pcm);
    playEnd = begins + (pcm.length / 2 / playRate) * 1000;
  }
  clearTimeout(drainTimer);
  // A little over, for what the player still holds when the last of it is written.
  drainTimer = setTimeout(drained, Math.max(0, playEnd - Date.now()) + 250);
}

// The loudness of a stretch of sound, reported in step with its being heard,
// for whatever is drawing a waveform.
function showLevels(pcm, delay) {
  const WINDOW = Math.round(playRate * 0.05) * 2; // 50 ms
  const levels = [];
  for (let at = 0; at + WINDOW <= pcm.length; at += WINDOW) {
    let sum = 0;
    for (let i = 0; i < WINDOW; i += 2) sum += pcm.readInt16LE(at + i) ** 2;
    levels.push(Math.min(1, Math.sqrt(sum / (WINDOW / 2)) / 10000));
  }
  const epoch = voiceEpoch;
  levels.forEach((level, index) => {
    levelTimers.push(setTimeout(() => {
      if (epoch === voiceEpoch) emit({ type: "level", who: "morgan", value: Number(level.toFixed(2)) });
    }, delay + index * 50));
  });
}

// Everything handed over has been heard, and nothing more is being made.
function drained() {
  if (speaking()) return;
  levelTimers = [];
  emit({ type: "level", who: "morgan", value: 0 });
  const then = afterSpeech;
  afterSpeech = null;
  if (then) { closePlayer(); return then(); }
  if (turnDone) finishSpeaking();
}

function closePlayer() {
  player?.stdin.end();
  player = null;
  playEnd = 0;
}

function finishSpeaking() {
  turnDone = true;
  if (speaking()) return;
  turnDone = false;
  closePlayer();
  if (state !== "thinking" && state !== "speaking") return;
  setState("idle");
  const invite = spokenTurn && cfg.tts && cfg.followUpSeconds > 0;
  spokenTurn = false;
  if (invite) startActive(cfg.followUpSeconds);
}

function stopSpeech() {
  voiceEpoch++;
  pending = "";
  ready.length = 0;
  turnDone = false;
  afterSpeech = null;
  clearTimeout(drainTimer);
  for (const timer of levelTimers) clearTimeout(timer);
  levelTimers = [];
  player?.kill("SIGTERM");
  player = null;
  playEnd = 0;
  emit({ type: "level", who: "morgan", value: 0 });
}

// ---------------------------------------------------------------- speech in
//
// The microphone is cut into utterances by loudness: one starts after 150 ms
// of sound and ends after a pause. In "active" mode (after the wake word, a
// toggle, or an answer that invites a reply) the next utterance is the user's
// turn. Otherwise, with a wake word set, each utterance is checked for it.

const FRAME = 480 * 2; // 30 ms of 16 kHz 16-bit mono
const PREROLL = 15; // frames kept from before an utterance, so its first sound is not clipped

let mic = null;
let active = null; // { since, patience } while waiting for the user's turn
let rest = Buffer.alloc(0);
let floor = 0; // background level
let calibrating = 0;
let preroll = [];
let utterance = null; // { frames: [], quietMs }
let loudRun = 0;
let checkingWake = false;
let meter = 0;
let spokenTurn = false; // the turn in progress came from the microphone

// PipeWire's echo canceller, loaded for as long as the daemon runs: a second
// microphone with whatever the speakers are playing subtracted from it. The
// system's own default devices are left as they are.
const CLEAN_MIC = "heyclaude.mic";
let canceller = null;

function startCanceller() {
  if (!cfg.echoCancel) return;
  canceller = spawn("pw-cli", [], { stdio: ["pipe", "ignore", "ignore"] });
  canceller.on("error", () => { canceller = null; });
  canceller.on("exit", () => { canceller = null; });
  canceller.stdin.write("load-module libpipewire-module-echo-cancel { library.name = aec/libspa-aec-webrtc monitor.mode = true"
    + " capture.props = { node.name = heyclaude.ec.capture node.passive = true }"
    + ` source.props = { node.name = ${CLEAN_MIC} node.description = "heyclaude microphone (echo cancelled)" priority.session = 1 } }\n`);
}

// Whose voice: null until a model is there to tell.
let voices = null;
const voiceLog = []; // recent checks, for tuning: { t, seconds, name, score, ok }
let enrolling = null; // { name, vectors, want } while a voice is being taught
let recent = []; // the last two seconds from the microphone

function startVoices() {
  if (!voiceprint.available()) return;
  try { voices = voiceprint.verifier(); } catch (error) { console.error(`voices: ${error.message}`); }
}

// Is this speech in a voice that has been taught? True when none has.
//
// How like the taught voice it has to be depends on how much there is to go
// on. A full sentence is held to the threshold. A few words score lower for
// the same speaker, so they are held to less; and a short reply straight
// after a turn that was accepted is almost certainly the same person
// answering, so it need only not be plainly someone else. Held to the full
// threshold, "yes" to "shall I go ahead?" was being ignored.
let lastAccepted = 0;

function recognised(pcm) {
  if (!voices || !cfg.knownVoicesOnly || !voices.enrolled.length) return true;
  const seconds = pcm.length / 32000;
  const { name, score } = voices.whose(pcm);
  let need = cfg.voiceThreshold - (seconds < 1.2 ? 0.18 : seconds < 2.5 ? 0.1 : 0);
  if (Date.now() - lastAccepted < 90_000) need = Math.min(need, 0.18);
  const ok = score >= need;
  if (ok) lastAccepted = Date.now();
  voiceLog.push({ t: Date.now(), seconds: Number(seconds.toFixed(1)), name, score: Number(score.toFixed(2)), need: Number(need.toFixed(2)), ok });
  if (voiceLog.length > 30) voiceLog.shift();
  emit({ type: "voice", name: ok ? name : null, score: Number(score.toFixed(2)) });
  return ok;
}

// One more sample of the voice being taught; the voiceprint is saved after the last.
function enrolStep(pcm) {
  const taught = enrolling;
  if (pcm.length / 32000 >= 1.5) taught.vectors.push(voices.embed(pcm));
  emit({ type: "enroll", name: taught.name, count: taught.vectors.length, want: taught.want });
  if (taught.vectors.length < taught.want) return startActive(20);
  enrolling = null;
  voiceprint.saveVoiceprint(taught.name, taught.vectors);
  voices.load();
  stopActive();
}

let spot = null;

function startSpotter() {
  const phrases = [...new Set([cfg.wakeWord, interruptWord()].filter(Boolean))];
  if (cfg.wakeEngine !== "spotter" || !phrases.length || !wake.available()) return;
  try {
    spot = wake.spotter(phrases, { threshold: cfg.wakeThreshold });
    console.error(`wake word: spotting ${phrases.map((phrase) => `"${phrase}"`).join(" and ")}`);
  } catch (error) {
    console.error(`wake word: falling back to transcribing (${error.message})`);
  }
}

const same = (a, b) => words(a ?? "").join(" ") === words(b ?? "").join(" ");
let wakeHit = 0; // when the spotter last heard the wake word
let wakeSure = false; // and whether it heard the whole phrase

const interruptWord = () => (cfg.interruptWord === undefined ? cfg.name : cfg.interruptWord);
const busy = () => state === "speaking" || state === "thinking" || state === "consulting";

function openMic() {
  if (mic) return;
  const command = cfg.record.replace("{target}", canceller ? `--target ${CLEAN_MIC}` : "");
  const child = spawn("sh", ["-c", "exec " + command], { stdio: ["ignore", "pipe", "ignore"] });
  mic = child;
  rest = Buffer.alloc(0);
  floor = 0;
  calibrating = 10;
  resetUtterance();
  child.stdout.on("data", (chunk) => {
    if (mic !== child) return;
    rest = Buffer.concat([rest, chunk]);
    for (; rest.length >= FRAME && mic === child; rest = rest.subarray(FRAME)) onFrame(Buffer.from(rest.subarray(0, FRAME)));
  });
  child.on("error", (error) => fail(`recording failed: ${error.message}`));
  child.on("exit", () => { if (mic === child) mic = null; });
}

function closeMic() {
  const child = mic;
  mic = null;
  child?.kill("SIGTERM");
}

function resetUtterance() {
  preroll = [];
  utterance = null;
  loudRun = 0;
}

function onFrame(frame) {
  let sum = 0;
  for (let i = 0; i < FRAME; i += 2) sum += frame.readInt16LE(i) ** 2;
  const level = Math.sqrt(sum / (FRAME / 2));
  if (calibrating) { floor += level / 10; calibrating--; return; }
  recent.push(frame);
  if (recent.length > 66) recent.shift();
  if (!active && state === "transcribing") return resetUtterance();
  if (spot && !active) {
    const hit = spot.feed(frame);
    if (hit && process.env.HEYCLAUDE_DEBUG) console.error(`spotter: "${hit}" state=${state} utterance=${Boolean(utterance)} checking=${checkingWake}`);
    if (hit && busy()) {
      // Either word cuts an answer short; what follows is the user's turn.
      // There is no whole utterance yet to judge the voice by, only the last
      // couple of seconds.
      if (!recognised(Buffer.concat(recent))) return;
      emit({ type: "wake" });
      return startActive(cfg.noSpeechSeconds);
    }
    if (hit && cfg.wakeWord) {
      // The interrupt word is usually part of the wake phrase, and the spotter
      // may report either for it. Only the full phrase is taken at its word;
      // the other is checked against the transcript before anything happens.
      wakeHit = Date.now();
      wakeSure = same(hit, cfg.wakeWord);
      // Heard after the utterance had already been let go: nothing came with it.
      if (wakeSure && !utterance && loudRun === 0 && !checkingWake) { emit({ type: "wake" }); return acknowledge(); }
    }
    if (busy()) return resetUtterance();
  }
  // While an answer is under way the microphone listens only for the
  // interrupt word, and not at all if there is none.
  const interruptible = !active && busy();
  if (interruptible && !interruptWord()) return resetUtterance();

  if (active && ++meter % 2 === 0) emit({ type: "level", who: "user", value: Number(Math.min(1, level / (canceller ? 1500 : 4000)).toFixed(2)) });
  // The cancelled microphone is a good deal quieter than the raw one.
  const loud = level > Math.max(floor * 4, canceller ? 150 : 300);
  if (!utterance) {
    if (!loud) floor = floor * 0.98 + level * 0.02;
    preroll.push(frame);
    if (preroll.length > PREROLL) preroll.shift();
    loudRun = loud ? loudRun + 1 : 0;
    if (loudRun >= 5) utterance = { frames: preroll, quietMs: 0, t: Date.now() };
    else if (active && Date.now() - active.since > active.patience * 1000) {
      if (enrolling) { emit({ type: "enroll", name: enrolling.name, cancelled: true }); enrolling = null; }
      // Nothing more came: what was heard with the interruption is the whole turn.
      const { said } = active;
      stopActive(said ? "transcribing" : "idle");
      if (said) heard(said);
    }
    return;
  }
  utterance.frames.push(frame);
  utterance.quietMs = loud ? 0 : utterance.quietMs + 30;
  const seconds = utterance.frames.length * 0.03;
  // An interruption has to be caught quickly, so it is checked in short pieces.
  if (interruptible) { if (utterance.quietMs >= 300 || seconds >= 1.5) endUtterance(); return; }
  if (utterance.quietMs >= cfg.endSilenceMs || seconds >= cfg.maxUtteranceSeconds) endUtterance();
}

function endUtterance() {
  const pcm = Buffer.concat(utterance.frames);
  const spotted = wakeHit >= utterance.t - 600;
  if (process.env.HEYCLAUDE_DEBUG) console.error(`utterance: ${(pcm.length / 32000).toFixed(1)}s state=${state} active=${Boolean(active)} spotted=${spotted} checking=${checkingWake}`);
  resetUtterance();
  if (active && enrolling) {
    enrolStep(pcm);
  } else if (active) {
    const { said } = active;
    // Someone else answering in the user's place is not the user's turn.
    if (!recognised(pcm)) return stopActive();
    stopActive("transcribing");
    transcribe(pcm).then((text) => { if (state === "transcribing") heard(`${said} ${text}`.trim()); });
  } else if (busy()) {
    if (!checkingWake) checkInterrupt(pcm);
  } else if (cfg.wakeWord && !checkingWake) {
    // With the spotter, only an utterance it heard the wake word in is worth transcribing.
    if (!spot) checkWake(pcm);
    else if (spotted) { wakeHit = 0; checkWake(pcm, wakeSure); }
  }
}

const STOP = /^(stop|stop it|stop talking|cancel|quiet|be quiet|enough|that's enough|thats enough|never ?mind|shut up|ok|okay|thanks|thank you)?$/;

async function checkInterrupt(pcm) {
  checkingWake = true;
  try {
    const text = await transcribe(pcm);
    const rest = phraseMatch(text, interruptWord()) ?? (cfg.wakeWord ? phraseMatch(text, cfg.wakeWord) : null);
    if (rest === null || !busy()) return;
    emit({ type: "wake" });
    const spoken = spokenTurn;
    interrupt();
    // The word alone, or with "stop", ends the answer and waits; anything
    // more is taken as the start of what the user wants instead.
    if (STOP.test(words(rest).join(" "))) startActive(cfg.noSpeechSeconds);
    else { spokenTurn = spoken; startActive(cfg.noSpeechSeconds, rest); }
  } catch (error) {
    fail(error.message);
  } finally {
    checkingWake = false;
  }
}

// Said on its own, any of these ends the conversation there and then: no
// answer, no waiting for a reply, back to listening for the wake word.
const GOODBYE = /^(ok |okay |alright |all right |great |good |thanks |thank you |no |nope |no thanks |no thank you )*(stop|stop it|stop talking|cancel|quiet|be quiet|enough|that's enough|thats enough|shut up|bye|bye bye|goodbye|good bye|see you|see you later|that's all|thats all|that is all|that will be all|that'll be all|that's it|thats it|that is it|i'm done|im done|we're done|were done|all done|nothing else|that's everything|never ?mind|stop listening|go to sleep|good ?night|no thanks|no thank you|thanks|thank you)( for now| then| morgan| thanks| thank you)*$/;

// The user's turn, from the microphone.
function heard(text) {
  if (!text) return setState("idle");
  if (GOODBYE.test(words(text.replace(new RegExp(cfg.name, "gi"), "")).join(" "))) {
    proposals = [];
    emit({ type: "user", text });
    spokenTurn = false;
    return setState("idle");
  }
  spokenTurn = true;
  ask(text);
}

// `spotted`: the spotter has already heard the wake word here, so the
// transcript is wanted only for whatever was said after it.
async function checkWake(pcm, spotted = false) {
  checkingWake = true;
  try {
    // The phrase opens the utterance, so the first few seconds settle it.
    const opening = spotted ? await transcribe(pcm) : await transcribe(pcm.subarray(0, 3 * 32000));
    if (wakeMatch(opening) === null && !spotted) return;
    let command = spotted || pcm.length <= 3 * 32000 ? wakeMatch(opening) : wakeMatch(await transcribe(pcm));
    // The spotter heard the phrase but the transcript spells it some other
    // way: take it to be the opening words, and the rest to be the request.
    command ??= spotted ? opening.split(/\s+/).slice(words(cfg.wakeWord).length).join(" ") : "";
    // A bare wake word is too short to tell a voice by; what is said next is checked.
    if (command && !recognised(pcm)) return;
    emit({ type: "wake" });
    if (command) heard(command);
    else acknowledge();
  } catch (error) {
    fail(error.message);
  } finally {
    checkingWake = false;
  }
}

// Answer a bare wake word, then listen for the turn.
function acknowledge() {
  if (!cfg.tts || !cfg.wakeReply) return startActive(cfg.noSpeechSeconds);
  interrupt();
  setState("speaking"); // so the reply is not taken for the user
  afterSpeech = () => { if (state === "speaking") startActive(cfg.noSpeechSeconds); };
  speakText(cfg.wakeReply);
}

const words = (text) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// What follows the wake word in a transcript, or null if it is not there.
// Speech recognition spells names loosely, so near misses count.
const wakeMatch = (text) => phraseMatch(text, cfg.wakeWord);

function phraseMatch(text, phrase) {
  const wake = words(phrase);
  const spoken = text.split(/\s+/).filter((word) => words(word).length);
  const slack = wake.join("").length >= 8 ? 2 : 1;
  for (let at = 0; at <= 2 && at + wake.length <= spoken.length; at++) {
    const window = words(spoken.slice(at, at + wake.length).join(" ")).join("");
    if (distance(window, wake.join("")) <= slack) return spoken.slice(at + wake.length).join(" ");
  }
  return null;
}

// Wait for the user's turn. `said` is the start of it, already heard.
function startActive(patience, said = "") {
  interrupt();
  openMic();
  resetUtterance();
  active = { since: Date.now(), patience, said };
  setState("listening");
}

function stopActive(next = "idle") {
  if (!active) return;
  active = null;
  if (!cfg.wakeWord && !interruptWord()) closeMic();
  setState(next);
}

let wavCount = 0;

function transcribe(pcm) {
  return new Promise((resolve, reject) => {
    if (!cfg.stt) return reject(new Error("no speech-to-text command configured (stt)"));
    const file = join(RUNTIME, `heyclaude-${process.pid}-${wavCount++}.wav`);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    writeFileSync(file, Buffer.concat([header, pcm]));
    const prompt = `${cfg.wakeWord ? cfg.wakeWord + ". " : ""}${cfg.name}. ${cfg.sttPrompt}`.replace(/'/g, "");
    const command = cfg.stt.replace("{file}", `'${file}'`).replace("{prompt}", `'${prompt}'`);
    let out = "";
    const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => { out += text; });
    child.on("exit", (code) => {
      rmSync(file, { force: true });
      if (code !== 0) return reject(new Error(`speech-to-text exited with code ${code}`));
      // whisper marks non-speech as [BLANK_AUDIO], (music) and the like
      resolve(out.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim());
    });
  });
}

// ---------------------------------------------------------------- control socket

function handle(line, socket) {
  const [command, ...rest] = line.trim().split(" ");
  const reply = (object) => socket.end(JSON.stringify(object) + "\n");
  switch (command) {
    case "toggle":
      // While listening: send what has been said so far, or give up if nothing has.
      if (!active) startActive(cfg.noSpeechSeconds);
      else if (utterance) endUtterance();
      else stopActive();
      return reply({ ok: true, state });
    case "say":
      stopActive();
      spokenTurn = true;
      ask(rest.join(" "));
      return reply({ ok: true, state });
    case "speak":
      if (cfg.tts) speakText(rest.join(" "));
      return reply({ ok: true, state });
    case "type":
      stopActive();
      ask(rest.join(" "), { typed: true });
      return reply({ ok: true, state });
    case "ask": {
      // A typed turn with files: one line of JSON, { text, files }.
      let turnOf;
      try { turnOf = JSON.parse(rest.join(" ")); } catch { return reply({ ok: false, error: "ask wants JSON: { text, files }" }); }
      stopActive();
      ask(String(turnOf.text ?? ""), { typed: true, files: (turnOf.files ?? []).map(String) });
      return reply({ ok: true, state });
    }
    case "stop":
      enrolling = null;
      stopActive();
      interrupt();
      proposals = [];
      emit({ type: "dismiss" });
      setState("idle");
      return reply({ ok: true, state });
    case "new":
      stopActive();
      interrupt();
      reset();
      emit({ type: "new" });
      setState("idle");
      return reply({ ok: true, state });
    case "interview":
      stopActive();
      interrupt();
      reset();
      interviewing = true;
      emit({ type: "interview", active: true });
      ask("Please begin the orientation interview.");
      return reply({ ok: true, state });
    case "recent": {
      const count = Math.min(Number(rest[0]) || 50, 500);
      return reply({ ok: true, items: transcript.items.slice(-count).map(({ t, user, morgan, oracle, hidden, good }) => ({ t, user, morgan, ...(oracle ? { oracle } : {}), hidden: Boolean(hidden), good: Boolean(good), ...(hidden ? { review: notesFrom(t) } : {}) })) });
    }
    case "settle": {
      // settle { t, topic, note, action }: the user's verdict on a note that may have come from a hidden answer
      let verdict;
      try { verdict = JSON.parse(rest.join(" ")); } catch { return reply({ ok: false, error: "settle wants JSON: { t, topic, note, action }" }); }
      settleNote(Number(verdict.t), String(verdict.topic), String(verdict.note), verdict.action === "delete" ? "delete" : "keep");
      return reply({ ok: true });
    }
    case "rate": {
      // rate <exchange> up | down | none
      const done = rate(Number(rest[0]), String(rest[1] ?? "none"));
      return reply(done ? { ok: true } : { ok: false, error: "there is no such exchange" });
    }
    case "enroll":
      try { enroll(rest.join(" ").trim()); } catch (error) { return reply({ ok: false, error: error.message }); }
      return reply({ ok: true, state });
    case "voices":
      return reply({ ok: true, ...voicesStatus() });
    case "forget-voice":
      forgetVoice(rest.join(" "));
      return reply({ ok: true, ...voicesStatus() });
    case "admin": {
      // The settings window's requests: { op, args } in, JSON out.
      let request;
      try { request = JSON.parse(rest.join(" ")); } catch { return reply({ ok: false, error: "admin wants JSON: { op, args }" }); }
      admin(String(request.op), request.args ?? {}).then(reply);
      return;
    }
    case "tools":
      return reply({ ok: true, calls: toolLog });
    case "threads":
      return reply({ ok: true, threads: transcript.threads.map(({ t0, title, summary, ts, live }) => ({ t0, title, summary, exchanges: ts.length, live: Boolean(live) })) });
    case "reminders":
      return reply({ ok: true, reminders: [...due].sort((a, b) => a.at - b.at).map((entry) => ({ ...entry, when: reminders.when(entry.at) })) });
    case "status":
      return reply({
        ok: true, state, name: cfg.name, model: cfg.ollama.model, oracle: cfg.oracle.model,
        stt: Boolean(cfg.stt), tts: Boolean(cfg.tts), wakeWord: cfg.wakeWord, wakeEngine: spot ? "spotter" : "transcribe", voice: kokoroReady ? cfg.kokoroVoice : cfg.voice, engine: kokoroReady ? "kokoro" : "piper", interviewing, mcpTools: mcpTools.map((tool) => tool.function.name), topics: topics().map((topic) => topic.name),
      });
    case "watch":
      watchers.add(socket);
      socket.write(JSON.stringify({ type: "state", state, name: cfg.name }) + "\n");
      return;
    default:
      return reply({ ok: false, error: `unknown command: ${command}` });
  }
}

// Teach a voice: the next six things said are taken as samples of it.
function enroll(name) {
  if (!voices) throw new Error("the voice model is not installed");
  if (!name) throw new Error("whose voice is it?");
  interrupt();
  enrolling = { name, vectors: [], want: 6 };
  startActive(20);
}

function forgetVoice(name) {
  voiceprint.removeVoiceprint(name);
  voices?.load();
}

const voicesStatus = () => ({
  installed: Boolean(voices), enrolled: voices?.enrolled ?? [], only: cfg.knownVoicesOnly, threshold: cfg.voiceThreshold, checks: voiceLog,
});

const admin = createAdmin({
  cfg, defaults, LIVE, interruptWord,
  topics, readTopic, writeTopic, topicPath, slug,
  documents, documentPath, pictures, picturePath,
  mcpAll, reconnectMcp, enroll, forgetVoice, voicesStatus,
  reminders: {
    list: () => [...due].sort((a, b) => a.at - b.at).map((entry) => ({ ...entry, when: reminders.when(entry.at) })),
    cancel: (id) => { due = due.filter((entry) => entry.id !== id); reminders.save(due); },
  },
  // Settings the running daemon cannot simply pick up: start again, once the answer has gone.
  restartSoon: () => setTimeout(() => spawn("systemctl", ["--user", "restart", "heyclaude.service"], { stdio: "ignore", detached: true }).unref(), 400),
});

rmSync(SOCKET, { force: true });
const server = createServer((socket) => {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    handle(buffer.slice(0, newline), socket);
  });
  socket.on("close", () => watchers.delete(socket));
  socket.on("error", () => watchers.delete(socket));
});
server.listen(SOCKET, () => console.error(`heyclaude listening on ${SOCKET}`));
startCanceller();
startSpotter();
startVoices();
// The canceller's microphone takes a moment to appear.
if (cfg.wakeWord || interruptWord()) setTimeout(openMic, canceller ? 1500 : 0);
connectMcpServers();

// ---------------------------------------------------------------- hotkey
//
// A runtime bind, not a line in hyprland.conf: Hyprland forgets it whenever
// its configuration is reloaded, so it is put back each time that happens.

const CHAT_PANEL = "jpmoo/morgan:chat";

function bindHotkey() {
  if (!cfg.hotkey) return;
  const shell = join(HOME, ".local", "bin", "noctalia");
  execFile("hyprctl", ["--batch", `keyword unbind ${cfg.hotkey} ; keyword bind ${cfg.hotkey}, exec, ${shell} msg panel-toggle ${CHAT_PANEL}`], () => {});
}

function watchHyprland() {
  const instance = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!cfg.hotkey || !instance) return;
  bindHotkey();
  const events = connect(join(RUNTIME, "hypr", instance, ".socket2.sock"));
  events.setEncoding("utf8");
  events.on("data", (text) => { if (text.includes("configreloaded")) bindHotkey(); });
  events.on("error", () => {});
}
watchHyprland();

// A conversation nobody returns to still ends, and is still filed.
setInterval(() => {
  if (history.length && state === "idle" && Date.now() - lastActivity > cfg.idleResetMinutes * 60_000) reset();
}, 60_000).unref();

function shutdown() {
  closeMic();
  bindEscape(false);
  canceller?.kill("SIGTERM");
  kokoroHelper?.kill("SIGTERM");
  stopSpeech();
  stopOracle();
  for (const client of mcpClients.values()) client.stop();
  server.close();
  rmSync(SOCKET, { force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
