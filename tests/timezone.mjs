#!/usr/bin/env node
// The time zone setting works by setting TZ while the daemon runs (daemon.mjs,
// applyTimeZone). That rests on Node taking TZ up again when it changes, which
// is what this checks — with the moment that went wrong: 7 PM in New York on
// 2026-10-23, which is 11 PM in UTC, and "today" from toISOString() was right
// only by luck until 8 PM, when UTC turns the day over.
//
//   node tests/timezone.mjs
import assert from "node:assert/strict";

const at = new Date("2026-10-23T23:00:00Z"); // 7:00 PM in New York
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const clock = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

process.env.TZ = "UTC";
assert.equal(clock(at), "11:00 PM", "UTC reads 11 PM");

process.env.TZ = "America/New_York";
assert.equal(clock(at), "7:00 PM", "set while running, TZ is taken up at once");
assert.equal(new Date(at).getHours(), 19);

// After 8 PM in New York the UTC day has turned over; the user's has not.
const late = new Date("2026-10-24T01:30:00Z"); // 9:30 PM on the 23rd in New York
assert.equal(late.toISOString().slice(0, 10), "2026-10-24", "toISOString gives UTC's day");
assert.equal(localDay(late), "2026-10-23", "the user's day is still the 23rd");

// A name that is not a zone is refused by Intl, which is how the daemon tells.
assert.throws(() => new Intl.DateTimeFormat("en-US", { timeZone: "Not/AZone" }));

console.log("time zone: ok");
