// What kind of turn this is, decided in one place.
//
// The local model answers anything put to it with the same assurance, right or
// wrong, and does not reliably reach for a tool when told to. So before it
// answers, a narrow call sorts what the user said, and the daemon acts on the
// result: looks things up, works out the sum, consults the Oracle, picks a
// lapsed conversation back up. This replaced lists of phrases ("my calendar",
// "who won", "try again"), each of which knew only the wordings it had been
// taught. tests/sorting.json holds the wordings this must get right; a change
// to the instructions below is checked against all of them with
// `node tests/sort.mjs` before it is trusted.

const KINDS = ["yours", "conversation", "settled", "world", "current"];

// What the turn calls for is given as a list of only what applies, which is
// most often nothing: nine yes-or-noes took half as long again to write out.
const NEEDS = ["calendar_tasks_or_notes", "sum", "oracle", "asks_for_change", "reminder_or_timer", "asks_to_keep", "needs_seeing", "earlier_talk"];

const SCHEMA = {
  type: "object",
  properties: {
    follows: { type: "boolean" },
    about: { type: "string", enum: KINDS },
    calls_for: { type: "array", items: { type: "string", enum: NEEDS } },
  },
  required: ["follows", "about", "calls_for"],
};

const instructions = (name) => [
  `Sort the user's latest message to ${name}, a voice assistant. Do not answer it. Give three things: follows, about, and calls_for.`,
  "",
  "follows: true if the message cannot be understood without what was said just before it: \"try again\", \"I mean...\",",
  "\"what about Friday?\", \"and the other one?\", \"say that again\", \"no, the second one\", \"why?\", or a question that says",
  "he, she, it or that of something not named in the message. True for such a message even when nothing before it is shown.",
  "False if it stands on its own.",
  "",
  "about: one of these. For a message that follows, first work out the whole question from what was said before (after talk",
  "of a film, \"what else has he made?\" is a question about a film director, so world), and sort that.",
  "- yours: the user's own life, people, things, plans, work, files or earlier conversations; an instruction to the assistant",
  "  to remember, set, make, change, add, create, cancel or do something; or about the assistant itself. The user's own tasks,",
  "  calendar, events, meetings, reminders, mail and notes are always yours, whatever day they are about. So is a question",
  "  about anything the user calls my or mine: my commute, my sister, my recipe.",
  "- conversation: small talk, greetings, thanks, feelings, opinions, jokes, brainstorming, naming things, wording, writing or",
  "  rewriting, advice on how to go about something where there is no single right answer.",
  "- world: a question of fact about the world that does not depend on what is happening now: a particular film, book, piece of",
  "  music, product, company, place or person; a figure, count, measurement or statistic; how something works; anything in",
  "  science, medicine, law, money or tax. This is the usual kind for a question of fact.",
  "- settled: only a fact every schoolchild is taught and that never changes: the capital of a large country, the planets,",
  "  the boiling point of water, the symbol of a common element, who wrote one of the most famous classics, how many days",
  "  are in a week, what a common word means. Nothing about law, medicine, money, technology, a particular modern work, or a",
  "  number most adults could not give from memory is ever settled. If there is any doubt, it is world, not settled.",
  "- current: depends on what is happening now or lately in the world: news, results, scores, reviews, prices, weather,",
  "  versions, public events, this year's rates or limits. Who holds an office, runs a company or holds a title or record",
  "  now (a president, a chief executive, a champion) is current however long they have held it, because it can change.",
  "  The user's own schedule is yours, not current.",
  "",
  "calls_for: a list of every one of the following that is true of the message. For most messages none is, and the list is",
  "then empty.",
  "",
  "calendar_tasks_or_notes: true only if answering needs the user's calendar, task list, projects, notes or mail to be read: what is on, due,",
  "available, overdue, planned or scheduled; when a meeting is; what a note or task says. When the message follows a question",
  "of that sort and asks for it again (\"try again\"), or for another day or another part of it, this is true as well.",
  "False for everything else. In particular false for who the user's family, friends and pets are, where anyone lives, what",
  "the user does, owns or likes, and their routines: the assistant knows those by heart. False for an instruction to create or",
  "change something, and for anything about the world.",
  "",
  "sum: true if the message asks for arithmetic to be worked out on numbers it gives: a percentage, a total, a tip, a split,",
  "a product, a difference, an average. False for a question whose answer merely is a number.",
  "",
  `oracle: true only if the user asks in so many words for the Oracle to be asked or consulted, or what the Oracle says or thinks.`,
  "",
  "asks_for_change: true if the user is telling the assistant to make, add, change, move, complete, archive, delete, send or",
  "schedule something in their task list, calendar, projects, notes or mail, in whatever words: \"add a task\", \"put milk on",
  "the list\", \"push that to Friday\", \"I finished the review\", \"get rid of that one\". False for a question about what is",
  "there or about what has been done (\"did you add it?\"), and false for timers and reminders.",
  "",
  "reminder_or_timer: true if the message is about a timer, alarm or reminder the assistant itself keeps: setting one (\"remind",
  "me\", \"wake me at six\", \"let me know in ten minutes\", \"don't let me forget\"), asking what is set, or cancelling, moving",
  "or snoozing one, including when that follows talk of reminders.",
  "",
  "asks_to_keep: true if the user asks for something to be remembered, saved, kept, stored or learned for later: a fact about",
  "them, a file, a document, a recipe, a picture. False when they only ask what is already remembered.",
  "",
  "needs_seeing: true if answering needs the assistant to look right now at the camera, the screen, a window or the",
  "clipboard: \"what am I holding?\", \"who is this?\", \"what's on my screen?\", \"read what I copied\", \"how do I look?\",",
  "\"remember this is me\". False for a figure of speech (\"let's see\", \"look up\", \"I see\") and for pictures already saved.",
  "",
  "earlier_talk: the user asks about their earlier conversations with the assistant: when they last talked, what they talked",
  "about on a day, what the assistant told them or what was decided before (\"what did you say about the boiler last week?\").",
  "Not for what was said a moment ago in this conversation, and not for facts about the user.",
].join("\n");

// Returns { follows, about, lookup, sum, oracle, change, reminder, keep, look, earlier }, or null if it could not be sorted.
// `earlier` is the last few messages of the conversation: [{ role, content }].
export async function sortTurn({ url, model, keepAlive, name }, text, earlier = []) {
  const before = earlier.filter((message) => message.role !== "tool" && message.content).slice(-4)
    .map((message) => `${message.role === "user" ? "User" : name}: ${message.content.slice(0, 300)}`).join("\n");
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model, stream: false, think: false, keep_alive: keepAlive, options: { temperature: 0 }, format: SCHEMA,
        messages: [
          { role: "system", content: instructions(name) },
          { role: "user", content: `${before ? `Said just before:\n${before}\n\n` : ""}The message to sort:\n${text}` },
        ],
      }),
    });
    const sorted = JSON.parse((await response.json()).message.content);
    if (!KINDS.includes(sorted.about)) return null;
    const calls = new Set(sorted.calls_for ?? []);
    return {
      follows: sorted.follows === true, about: sorted.about, lookup: calls.has("calendar_tasks_or_notes"), sum: calls.has("sum"),
      oracle: calls.has("oracle"), change: calls.has("asks_for_change"), reminder: calls.has("reminder_or_timer"),
      keep: calls.has("asks_to_keep"), look: calls.has("needs_seeing"), earlier: calls.has("earlier_talk"),
    };
  } catch (error) {
    console.error(`sort: ${error.message}`);
    return null;
  }
}
