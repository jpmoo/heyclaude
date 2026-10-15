// The keys that let client apps reach a server: issued here, one per device,
// shown once, kept only as a hash. `heyclaude access add|list|remove`.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const hash = (key) => createHash("sha256").update(String(key)).digest();

export function createAccess(file) {
  let keys = [];
  try { keys = JSON.parse(readFileSync(file, "utf8")); } catch { /* none yet */ }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  };
  let lastSaved = 0;
  return {
    // A new key for a device, returned this once.
    add(name) {
      name = String(name ?? "").trim();
      if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("a device name is letters, digits, dots, dashes or underscores");
      if (keys.some((entry) => entry.name === name)) throw new Error(`${name} already has a key; remove it first`);
      const key = `hc_${randomBytes(32).toString("base64url")}`;
      keys.push({ name, hash: hash(key).toString("hex"), made: Date.now(), used: null });
      save();
      return key;
    },
    list: () => keys.map(({ name, made, used }) => ({ name, made, used })),
    remove(name) {
      const before = keys.length;
      keys = keys.filter((entry) => entry.name !== name);
      if (keys.length !== before) save();
      return keys.length !== before;
    },
    // The device a key belongs to, or null.
    check(key) {
      if (typeof key !== "string" || !key.startsWith("hc_")) return null;
      const offered = hash(key);
      const found = keys.find((entry) => timingSafeEqual(Buffer.from(entry.hash, "hex"), offered));
      if (!found) return null;
      found.used = Date.now();
      if (Date.now() - lastSaved > 60_000) { lastSaved = Date.now(); save(); }
      return found;
    },
    exists: () => existsSync(file),
  };
}
