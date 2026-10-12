// Timers and reminders: when they are due, and saying so.
//
// The model is good at understanding "remind me to call Ana at half three on
// Thursday" and poor at working out what date that is. So it is asked only
// for the parts (a day, a time, or an amount and a unit) and the arithmetic
// is done here.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MEMORY, readSealed, writeSealed } from "./lib.mjs";

const FILE = join(MEMORY, "reminders.sealed");
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const UNITS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

export function load() {
  try { return existsSync(FILE) ? JSON.parse(readSealed(FILE)) : []; } catch { return []; }
}

export const save = (list) => writeSealed(FILE, JSON.stringify(list));

// The moment meant, in milliseconds, or an error to put to the user.
//   { kind: "relative", amount: 10, unit: "minutes" }
//   { kind: "absolute", day: "tomorrow" | "thursday" | "2026-10-15" | "", time: "15:30" | "" }
export function resolve(parts, now = Date.now()) {
  if (parts.kind === "relative") {
    const amount = Number(parts.amount);
    if (!(amount > 0) || !UNITS[parts.unit]) throw new Error("how long from now was not clear");
    return now + amount * UNITS[parts.unit];
  }
  const day = String(parts.day ?? "").trim().toLowerCase();
  const clock = String(parts.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!day && !clock) throw new Error("neither a day nor a time was given");
  const at = new Date(now);
  at.setHours(clock ? Number(clock[1]) : 9, clock ? Number(clock[2]) : 0, 0, 0);
  const weekday = DAYS.indexOf(day);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [year, month, date] = day.split("-").map(Number);
    at.setFullYear(year, month - 1, date);
  } else if (day === "tomorrow") {
    at.setDate(at.getDate() + 1);
  } else if (weekday >= 0) {
    // The next one: today counts only if the time is still to come.
    let ahead = (weekday - at.getDay() + 7) % 7;
    if (ahead === 0 && at.getTime() <= now) ahead = 7;
    at.setDate(at.getDate() + ahead);
  } else if (day && day !== "today" && day !== "tonight") {
    throw new Error(`"${parts.day}" is not a day that could be worked out`);
  } else if (at.getTime() <= now) {
    // "At three", said at four: tomorrow, unless today was asked for outright.
    if (day) throw new Error("that time has already gone today");
    at.setDate(at.getDate() + 1);
  }
  if (at.getTime() <= now) throw new Error("that is in the past");
  return at.getTime();
}

// "at 3:30 PM today (in 42 minutes)", "tomorrow at 8:00 AM", "on Thursday 15 October at 9:00 AM"
export function when(at, now = Date.now()) {
  const then = new Date(at);
  const time = then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(then).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const minutes = Math.round((at - now) / 60_000);
  const away = minutes < 1 ? `in ${Math.max(1, Math.round((at - now) / 1000))} seconds`
    : minutes < 90 ? `in ${minutes} minute${minutes === 1 ? "" : "s"}`
      : minutes < 36 * 60 ? `in about ${Math.round(minutes / 60)} hours` : "";
  if (days === 0) return `at ${time} today${away ? ` (${away})` : ""}`;
  if (days === 1) return `tomorrow at ${time}${away ? ` (${away})` : ""}`;
  return `on ${then.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })} at ${time}`;
}

// ---------------------------------------------------------------- days as dates
//
// A day named in words, as the date it is. The model is not left to work
// this out: asked what is due on Tuesday, it passed "Tuesday" to a tool that
// wanted a date, and on a Monday did not see that Tuesday was tomorrow.

const pad = (n) => String(n).padStart(2, "0");
export const isoDate = (day) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;

// "tuesday" (the next one, counting today), "today", "tomorrow", "yesterday".
// Null for anything else.
export function dateOf(word, now = Date.now()) {
  const said = String(word).trim().toLowerCase().replace(/^(on|this|next|by|for)\s+/, "");
  const day = new Date(now);
  day.setHours(12, 0, 0, 0);
  const weekday = DAYS.indexOf(said);
  if (weekday >= 0) day.setDate(day.getDate() + ((weekday - day.getDay() + 7) % 7));
  else if (said === "tomorrow") day.setDate(day.getDate() + 1);
  else if (said === "yesterday") day.setDate(day.getDate() - 1);
  else if (said !== "today") return null;
  return isoDate(day);
}

// The fortnight ahead, and yesterday, as a table for the model to read from.
export function calendar(now = Date.now()) {
  const lines = [];
  for (let offset = -1; offset <= 13; offset++) {
    const day = new Date(now);
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    const name = day.toLocaleDateString("en-US", { weekday: "long" });
    const label = offset === -1 ? "yesterday" : offset === 0 ? "today" : offset === 1 ? "tomorrow" : offset < 7 ? `this coming ${name}` : `${name} of next week`;
    lines.push(`${isoDate(day)} is ${name} (${label})`);
  }
  return lines.join("; ");
}

// The weekdays named in what the user said, each with its date.
export function daysNamed(text, now = Date.now()) {
  const found = [];
  for (const name of DAYS) {
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) found.push(`${name[0].toUpperCase()}${name.slice(1)} is ${dateOf(name, now)}`);
  }
  return found;
}
