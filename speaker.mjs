// Whose voice is this? A small model turns a stretch of speech into a list of
// numbers that is much the same for one person and different for another.
// Voiceprints are kept sealed, as numbers; no recording is kept.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SHARE } from "./env.mjs";
import { MEMORY, readSealed, writeSealed } from "./lib.mjs";

const MODEL = join(SHARE, "speaker", "nemo_en_titanet_small.onnx");
export const VOICEPRINTS = join(MEMORY, "voices");
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export const available = () => existsSync(MODEL);

export function voiceprints() {
  if (!existsSync(VOICEPRINTS)) return [];
  return readdirSync(VOICEPRINTS).filter((file) => file.endsWith(".voice")).sort().map((file) => JSON.parse(readSealed(join(VOICEPRINTS, file))));
}

export function saveVoiceprint(name, vectors) {
  mkdirSync(VOICEPRINTS, { recursive: true });
  writeSealed(join(VOICEPRINTS, `${slug(name)}.voice`), JSON.stringify({ name, t: Date.now(), vectors: vectors.map((vector) => [...vector]) }));
}

export const removeVoiceprint = (name) => rmSync(join(VOICEPRINTS, `${slug(name)}.voice`), { force: true });

function unit(vector) {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(vector, (x) => x / norm);
}

export function verifier() {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2, provider: "cpu" });
  // 16 kHz 16-bit mono in, a unit-length voiceprint out.
  const embed = (pcm) => {
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const stream = extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    stream.inputFinished();
    return unit(extractor.compute(stream, false));
  };
  let known = [];
  const load = () => { known = voiceprints().map((print) => ({ name: print.name, vectors: print.vectors.map(unit) })); };
  load();
  return {
    embed,
    load,
    get enrolled() { return known.map((print) => print.name); },
    // The enrolled voice most like this speech, and how like it (-1 to 1): the
    // average of its likeness to each sample that voice was taught with.
    whose(pcm) {
      const vector = embed(pcm);
      let best = { name: null, score: -1 };
      for (const print of known) {
        let total = 0;
        for (const sample of print.vectors) for (let i = 0; i < vector.length; i++) total += vector[i] * sample[i];
        const score = total / print.vectors.length;
        if (score > best.score) best = { name: print.name, score };
      }
      return best;
    },
  };
}
