// Everything ever said, kept as one line per exchange, with an embedding of
// each so that earlier conversations can be found by meaning as well as by
// word and by date. Every line is sealed: see seal() in lib.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // Threads: the exchanges of a conversation that were about one thing,
    // with a title and a summary. A conversation that wanders is several.
    this.threads = lines(join(dir, "threads.sealed")); // { id, t0, t1, title, summary, ts, live? }
    const threadVectors = new Map(lines(join(dir, "thread-vectors.sealed"))
      .filter((entry) => (entry.m ?? "nomic-embed-text") === model)
      .map((entry) => [entry.id, entry.v]));
    for (const thread of this.threads) {
      const stored = threadVectors.get(thread.id);
      if (stored) thread.v = new Float32Array(new Uint8Array(Buffer.from(stored, "base64")).buffer);
    }
  }

  // Mark an exchange: "down" hides it, "up" marks it good, anything else clears
  // both. A hidden exchange stays on the record and is never again put in
  // front of the model, in any form: not found by search, not part of a
  // thread. Threads it was in are returned, taken off the record, for the
  // caller to make afresh from what is left of them, since their summaries
  // were written with it in view.
  rate(t, vote) {
    const item = this.items.find((entry) => entry.t === t);
    if (!item) return null;
    delete item.hidden;
    delete item.good;
    if (vote === "down") item.hidden = true;
    if (vote === "up") item.good = true;
    const plain = (list) => list.map(({ v, ...rest }) => seal(JSON.stringify(rest))).join("\n") + (list.length ? "\n" : "");
    writeFileSync(join(this.dir, "exchanges.sealed"), plain(this.items), { mode: 0o600 });
    const stale = vote === "down" ? this.threads.filter((thread) => thread.ts.includes(t)) : [];
    if (stale.length) {
      this.threads = this.threads.filter((thread) => !stale.includes(thread));
      writeFileSync(join(this.dir, "threads.sealed"), plain(this.threads), { mode: 0o600 });
    }
    return { item, stale: stale.map((thread) => this.items.filter((entry) => thread.ts.includes(entry.t) && !entry.hidden)) };
  }

  // Exchanges that no thread has been made from yet.
  unthreaded() {
    const done = new Set(this.threads.flatMap((thread) => thread.ts));
    return this.items.filter((item) => !done.has(item.t) && !item.hidden);
  }

  async addThread({ title, summary, items }) {
    const thread = {
      id: `${items[0].t}-${this.threads.length}`,
      t0: items[0].t,
      t1: items.at(-1).t,
      title,
      summary,
      ts: items.map((item) => item.t),
      // Made up wholly of lookups: a record of how things stood, not to be brought back unasked.
      ...(items.every((item) => item.live) ? { live: true } : {}),
    };
    appendFileSync(join(this.dir, "threads.sealed"), seal(JSON.stringify(thread)) + "\n", { mode: 0o600 });
    this.threads.push(thread);
    try {
      await this.indexThread(thread);
    } catch (error) {
      console.error(`history: ${error.message}`);
    }
    return thread;
  }

  async indexThread(thread) {
    const said = this.items.filter((item) => thread.ts.includes(item.t)).map((item) => item.user).join(" ").slice(0, 1500);
    thread.v = await this.embed(`search_document: ${thread.title}. ${thread.summary}\n${said}`);
    const stored = Buffer.from(thread.v.buffer).toString("base64");
    appendFileSync(join(this.dir, "thread-vectors.sealed"), seal(JSON.stringify({ id: thread.id, v: stored, m: this.model })) + "\n", { mode: 0o600 });
  }

  // Earlier threads nearest in meaning to this one, best first, each with its
  // likeness (0 to 1): those that ended before it began and within `days`.
  near(thread, { days = 14, limit = 3 } = {}) {
    if (!thread.v) return [];
    const like = (other) => { let sum = 0; for (let i = 0; i < other.length; i++) sum += thread.v[i] * other[i]; return sum; };
    return this.threads
      .filter((other) => other !== thread && other.v && other.t1 < thread.t0 && other.t0 > thread.t0 - days * 86_400_000)
      .map((other) => ({ thread: other, score: like(other.v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Two threads that turned out to be one subject made one: the exchanges of
  // both, under the title of the larger (or, alike, the earlier), with both
  // summaries; and whatever pointed at the one dropped now points at the one kept.
  async merge(keep, drop) {
    if (drop.ts.length > keep.ts.length) [keep, drop] = [drop, keep];
    keep.ts = [...new Set([...keep.ts, ...drop.ts])].sort((a, b) => a - b);
    keep.t0 = Math.min(keep.t0, drop.t0);
    keep.t1 = Math.max(keep.t1, drop.t1);
    keep.summary = `${keep.summary} ${drop.summary}`;
    if (!drop.live) delete keep.live;
    delete keep.linked;
    this.threads = this.threads.filter((thread) => thread !== drop);
    for (const thread of this.threads) {
      if (thread.follows?.includes(drop.id)) thread.follows = [...new Set(thread.follows.map((id) => (id === drop.id ? keep.id : id)))].filter((id) => id !== thread.id);
    }
    const plain = (list) => list.map(({ v, ...rest }) => seal(JSON.stringify(rest))).join("\n") + (list.length ? "\n" : "");
    writeFileSync(join(this.dir, "threads.sealed"), plain(this.threads), { mode: 0o600 });
    try { await this.indexThread(keep); } catch (error) { console.error(`history: ${error.message}`); }
    return keep;
  }

  // Note that a thread may carry on from earlier ones (`follows`, their ids),
  // and that it has been looked at, so it is not looked at again.
  link(thread, follows) {
    thread.linked = true;
    if (follows.length) thread.follows = follows; else delete thread.follows;
    const plain = (list) => list.map(({ v, ...rest }) => seal(JSON.stringify(rest))).join("\n") + (list.length ? "\n" : "");
    writeFileSync(join(this.dir, "threads.sealed"), plain(this.threads), { mode: 0o600 });
  }

  // The threads nearest in meaning to what was said, each with the one or two
  // of its exchanges that bear on it most.
  async searchThreads({ query, to = Infinity, limit = 2, live = false }) {
    let vector;
    try { vector = await this.embed(`search_query: ${query}`); } catch (error) { console.error(`history: ${error.message}`); return []; }
    const like = (other) => {
      if (!other) return 0;
      let sum = 0;
      for (let i = 0; i < vector.length; i++) sum += vector[i] * other[i];
      return sum;
    };
    const wanted = words(query);
    return this.threads
      .filter((thread) => thread.t1 < to && thread.v && (live || !thread.live))
      .map((thread) => {
        const have = words(`${thread.title} ${thread.summary}`);
        let shared = 0;
        for (const word of wanted) if (have.has(word)) shared++;
        return { thread, score: like(thread.v) + 0.1 * (wanted.size ? shared / wanted.size : 0) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => ({
        ...hit,
        items: this.items.filter((item) => hit.thread.ts.includes(item.t) && !item.live && !item.hidden)
          .map((item) => ({ item, score: like(item.v) })).sort((a, b) => b.score - a.score).slice(0, 2)
          .sort((a, b) => a.item.t - b.item.t),
      }));
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
    if (!missing.length && this.threads.every((thread) => thread.v)) return;
    console.error(`history: embedding ${missing.length} exchanges with ${this.model}`);
    try {
      for (const item of missing) await this.index(item);
      for (const thread of this.threads.filter((entry) => !entry.v)) await this.indexThread(thread);
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
    const pool = this.items.filter((item) => item.t >= from && item.t < to && !item.hidden);
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
        // An answer the user marked good counts for a little more.
        return { item, score: (vector && item.v ? meaning + 0.15 * wording : 0.75 * wording) + (item.good ? 0.05 : 0) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// A thread as it is shown to the model: when, what it was about, how it came
// out, and the exchanges from it that matter most here.
export function describeThread({ thread, items }, limit = 300) {
  const when = new Date(thread.t0).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  return `[${when}] ${thread.title}: ${thread.summary}${items.map(({ item }) => `\n  User: ${clip(item.user)}\n  You: ${clip(item.morgan)}`).join("")}`;
}

export function describe({ item }, limit = 400) {
  const when = new Date(item.t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const clip = (text) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  return `[${when}] User: ${clip(item.user)}\n  You${item.live ? " (from what a tool showed at the time; it may have changed)" : ""}: ${clip(item.morgan)}${item.saw ? `\n  You had looked and seen: ${clip(item.saw)}` : ""}${item.oracle ? `\n  The Oracle had told you: ${clip(item.oracle)}` : ""}`;
}
