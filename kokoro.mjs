#!/usr/bin/env node
// The Kokoro voice, kept loaded. As a server (no arguments) it listens on a
// Unix socket: a connection sends text and gets back raw 16-bit mono audio at
// 24 kHz. With --say it speaks one line and exits, for previews.
//
//   kokoro.mjs <socket> <speaker> <speed>
//   kokoro.mjs --say <speaker> <speed> <text>

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { SHARE } from "./env.mjs";

const MODEL = join(SHARE, "kokoro-multi-lang-v1_0");
export const RATE = 24000;

function load(british = false) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  return new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: join(MODEL, "model.onnx"),
        voices: join(MODEL, "voices.bin"),
        tokens: join(MODEL, "tokens.txt"),
        dataDir: join(MODEL, "espeak-ng-data"),
        dictDir: join(MODEL, "dict"),
        // British voices (b...) read from the British word list.
        lexicon: join(MODEL, british ? "lexicon-gb-en.txt" : "lexicon-us-en.txt"),
      },
      numThreads: 4,
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
}

function speak(tts, text, sid, speed) {
  const audio = tts.generate({ text, sid, speed });
  const pcm = Buffer.alloc(audio.samples.length * 2);
  for (let i = 0; i < audio.samples.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio.samples[i] * 32767))), i * 2);
  }
  return pcm;
}

const british = (sid) => Number(sid) >= 20 && Number(sid) <= 27;

const args = process.argv.slice(2);
if (args[0] === "--say") {
  const pcm = speak(load(british(args[1])), args.slice(3).join(" "), Number(args[1]), Number(args[2]) || 1);
  spawnSync("pw-play", ["--raw", "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"], { input: pcm });
} else if (args[0] === "--pcm") {
  process.stdout.write(speak(load(british(args[1])), args.slice(3).join(" "), Number(args[1]), Number(args[2]) || 1));
} else if (args[0] === "--time") {
  const started = Date.now();
  const tts = load();
  const loaded = Date.now();
  const pcm = speak(tts, args.slice(3).join(" "), Number(args[1]), Number(args[2]) || 1);
  console.log(JSON.stringify({ loadMs: loaded - started, synthMs: Date.now() - loaded, audioMs: Math.round(pcm.length / 2 / RATE * 1000), speakers: tts.numSpeakers, rate: tts.sampleRate }));
} else {
  const [socket, sid, speed] = args;
  const tts = load(british(sid));
  // The first thing a freshly loaded model says takes a few seconds to make.
  // Better that it is this than the opening of somebody's answer.
  speak(tts, "Ready.", Number(sid), Number(speed) || 1);
  rmSync(socket, { force: true });
  createServer({ allowHalfOpen: true }, (connection) => {
    let text = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => { text += chunk; });
    connection.on("error", () => {});
    connection.on("end", () => {
      try { connection.end(speak(tts, text.trim(), Number(sid), Number(speed) || 1)); } catch (error) { console.error(error.message); connection.end(); }
    });
  }).listen(socket, () => console.error("kokoro ready"));
}
