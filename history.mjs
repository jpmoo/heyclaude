// Everything ever said, kept as one line per exchange, with an embedding of
// each so that earlier conversations can be found by meaning as well as by
// word and by date. Every line is sealed: see seal() in lib.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "./lib.mjs";

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(unseal(line))) : []);
const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []);

export class Transcript {
  constructor({ dir, url, model }) {
    this.dir = dir;
    this.url = url;
    this.model = model;
    mkdirSync(dir, { recursive: true });
    this.items = lines(join(dir, "exchanges.sealed")); // { t, user, morgan, oracle? }
    // Vectors from another embedding model cannot be compared with this one's.
    const vectors = new Map(lines(join(dir, "vectors.sealed"))
      .filter((entry) => (entry.m ?? "nomic-embed-text") === model)
      .map((entry) => [entry.t, entry.v]));
    for (const item of this.items) {
      const stored = vectors.get(item.t);
      if (stored) item.v = new Float32Array(new Uint8Array(Buffer.from(stored, "base64")).buffer);
    }
  }

  async embed(text) {
    const response = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: this.model, input: [text.slice(0, 6000)] }),
    });
    if (!response.ok) throw new Error(`embedding failed: HTTP ${response.status}`);
    const vector = Float32Array.from((await response.json()).embeddings[0]);
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return vector.map((x) => x / norm);
  }

  // The exchange is on disk before anything else is tried; an embedding that
  // fails only makes it findable by word and date instead of by meaning.
  async add(exchange) {
    const item = { t: Date.now(), ...exchange };
    appendFileSync(join(this.dir, "exchanges.sealed"), seal(JSON.stringify(item)) + "\n", { mode: 0o600 });
    this.items.push(item);
    try {
      await this.index(item);
    } catch (error) {
      console.error(`history: ${error.message}`);
    }
  }

  async index(item) {
    item.v = await this.embed(`search_document: ${item.user}\n${item.morgan}`);
    const stored = Buffer.from(item.v.buffer).toString("base64");
    // An embedding gives away much of what it was made from, so it is sealed too.
    appendFileSync(join(this.dir, "vectors.sealed"), seal(JSON.stringify({ t: item.t, v: stored, m: this.model })) + "\n", { mode: 0o600 });
  }

  // Embed whatever has no vector: exchanges whose embedding failed at the
  // time, or all of them after a change of embedding model.
  async reindex() {
    const missing = this.items.filter((item) => !item.v);
    if (!missing.length) return;
    console.error(`history: embedding ${missing.length} exchanges with ${this.model}`);
    try {
      for (const item of missing) await this.index(item);
    } catch (error) {
      console.error(`history: ${error.message}`);
    }
  }

  since(t) {
    return this.items.filter((item) => item.t >= t);
  }

  // Exchanges between two times, best match first when there is a query and
  // newest first when there is not. Each result carries its score (0 to 1).
  async search({ query, from = 0, to = Infinity, limit = 5 }) {
    const pool = this.items.filter((item) => item.t >= from && item.t < to);
    if (!query) return pool.slice(-limit).reverse().map((item) => ({ item, score: 1 }));
    let vector = null;
    try { vector = await this.embed(`search_query: ${query}`); } catch (error) { console.error(`history: ${error.message}`); }
    const wanted = words(query);
    return pool
      .map((item) => {
        let meaning = 0;
        if (vector && item.v) for (let i = 0; i < vector.length; i++) meaning += vector[i] * item.v[i];
        // Names and exact terms are where meaning alone lets you down.
        const have = words(`${item.user} ${item.morgan}`);
        let shared = 0;
        for (const word of wanted) if (have.has(word)) shared++;
        const wording = wanted.size ? shared / wanted.size : 0;
        return { item, score: vector && item.v ? meaning + 0.15 * wording : 0.75 * wording };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export function describe({ item }, limit = 400) {
  const when = new Date(item.t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  return `[${when}] User: ${clip(item.user)}\n  You: ${clip(item.morgan)}${item.saw ? `\n  You had looked and seen: ${clip(item.saw)}` : ""}${item.oracle ? `\n  The Oracle had told you: ${clip(item.oracle)}` : ""}`;
}
