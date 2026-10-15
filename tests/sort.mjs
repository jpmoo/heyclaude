#!/usr/bin/env node
// Every wording in sorting.json, put to the sorter alone and checked against
// the fields given for it. Fast: nothing but the one narrow call per wording.
//
//   node tests/sort.mjs            all of them
//   node tests/sort.mjs -v         with what each was sorted as
//   SORT_MODEL=mistral node tests/sort.mjs      another model, to see whether it sorts as well
import { readFileSync } from "node:fs";
import { loadConfig, BASICS } from "../lib.mjs";
import { sortTurn } from "../sort.mjs";

// The settings in use here; on a client they are the server's mirror, which
// may leave out Ollama, so the laptop's own settings stand in for it then.
import { CONFIG_HOME } from "../lib.mjs";
import { existsSync, readFileSync as read } from "node:fs";
const config = loadConfig();
const own = existsSync(`${CONFIG_HOME}/config.json`) ? JSON.parse(read(`${CONFIG_HOME}/config.json`, "utf8")) : {};
const ollama = { ...BASICS.ollama, ...own.ollama, ...config.ollama };
const name = config.name ?? BASICS.name;
const cases = JSON.parse(readFileSync(new URL("sorting.json", import.meta.url), "utf8"));
const verbose = process.argv.includes("-v");
// Where the answer comes from, which is what matters: a schoolbook fact sent
// to the Oracle costs a few seconds; a fact about the world kept back costs a wrong answer.
const source = (about) => (about === "world" || about === "current" ? "oracle" : "self");
let wrong = 0, unsafe = 0, slowest = 0, total = 0;
for (const entry of cases) {
  const began = Date.now();
  const sorted = await sortTurn({ url: ollama.url, model: process.env.SORT_MODEL ?? ollama.model, name }, entry.say, entry.after ?? []);
  const took = Date.now() - began;
  slowest = Math.max(slowest, took);
  total += took;
  const off = [];
  for (const [field, want] of Object.entries(entry.want)) {
    const got = field === "source" ? source(sorted?.about) : sorted?.[field];
    if (got !== want) off.push(`${field} ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  if (off.length) wrong++;
  if (entry.want.source === "oracle" && source(sorted?.about) === "self") unsafe++;
  if (off.length || verbose) console.log(`${off.length ? "X" : " "} ${entry.say}${entry.after ? "  (after earlier talk)" : ""}\n      ${off.length ? off.join("; ") : JSON.stringify(sorted)}`);
}
console.log(`\n${cases.length - wrong}/${cases.length} sorted as wanted; ${unsafe} kept from the Oracle that should have gone; `
  + `${Math.round(total / cases.length)} ms each on average, ${slowest} ms at slowest`);
process.exit(wrong ? 1 : 0);
