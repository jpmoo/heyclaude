// Spotting the wake word with a small model that listens for it and nothing
// else, in place of transcribing everything the microphone hears.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SHARE } from "./env.mjs";

const MODEL = join(SHARE, "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");

export const available = () => existsSync(join(MODEL, "bpe.model"));

// The model knows words as pieces from a fixed vocabulary, so a phrase has to
// be cut up the same way it was in training. The vocabulary and the order in
// which pieces are joined are in bpe.model, a SentencePiece file: a protobuf
// whose field 1 repeats { 1: piece, 2: score }.
function vocabulary() {
  const data = readFileSync(join(MODEL, "bpe.model"));
  const scores = new Map();
  const varint = (at) => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = data[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return [value, at];
    }
  };
  for (let at = 0; at < data.length;) {
    const [tag, afterTag] = varint(at);
    const type = tag & 7;
    if (type !== 2) { // not a nested message: skip it
      at = type === 0 ? varint(afterTag)[1] : afterTag + (type === 5 ? 4 : 8);
      continue;
    }
    const [length, start] = varint(afterTag);
    at = start + length;
    if (tag >> 3 !== 1) continue;
    let piece = null;
    let score = 0;
    for (let inner = start; inner < at;) {
      const [field, afterField] = varint(inner);
      if ((field & 7) === 2) {
        const [size, from] = varint(afterField);
        if (field >> 3 === 1) piece = data.toString("utf8", from, from + size);
        inner = from + size;
      } else if ((field & 7) === 5) {
        if (field >> 3 === 2) score = data.readFloatLE(afterField);
        inner = afterField + 4;
      } else {
        inner = varint(afterField)[1];
      }
    }
    if (piece !== null) scores.set(piece, score);
  }
  return scores;
}

// Of all the ways to cut the phrase into pieces from the vocabulary, the one
// whose pieces are most probable together: SentencePiece's unigram method.
export function pieces(phrase, scores = vocabulary()) {
  const text = phrase.toUpperCase().replace(/[^A-Z' ]/g, " ").trim().split(/\s+/).map((word) => `▁${word}`).join("");
  const best = [{ score: 0, from: -1 }];
  for (let end = 1; end <= text.length; end++) {
    best[end] = { score: -Infinity, from: -1 };
    for (let start = Math.max(0, end - 16); start < end; start++) {
      const score = scores.get(text.slice(start, end));
      if (score === undefined || best[start].score === -Infinity) continue;
      if (best[start].score + score > best[end].score) best[end] = { score: best[start].score + score, from: start };
    }
  }
  const out = [];
  for (let end = text.length; end > 0; end = best[end].from) {
    if (best[end].from < 0) throw new Error(`"${phrase}" cannot be spelled in the wake-word model's vocabulary`);
    out.unshift(text.slice(best[end].from, end));
  }
  return out;
}

// A spotter for the given phrases. feed() takes 16 kHz 16-bit mono audio and
// returns the phrase just heard, or null.
export function spotter(phrases, { threshold = 0.25, score = 1.5 } = {}) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const scores = vocabulary();
  const keywords = phrases.map((phrase) => `${pieces(phrase, scores).join(" ")} @${phrase.replace(/\s+/g, "_")}`).join("\n");
  const file = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", `heymorgan-keywords-${process.pid}.txt`);
  writeFileSync(file, keywords + "\n");
  const kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(MODEL, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        decoder: join(MODEL, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        joiner: join(MODEL, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
      },
      tokens: join(MODEL, "tokens.txt"),
      numThreads: 1,
      provider: "cpu",
    },
    keywordsFile: file,
    keywordsThreshold: threshold,
    keywordsScore: score,
  });
  const stream = kws.createStream();
  return {
    keywords,
    feed(pcm) {
      const samples = new Float32Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      let heard = null;
      while (kws.isReady(stream)) {
        kws.decode(stream);
        const { keyword } = kws.getResult(stream);
        if (keyword) { heard = keyword.replace(/_/g, " "); kws.reset(stream); }
      }
      return heard;
    },
  };
}
