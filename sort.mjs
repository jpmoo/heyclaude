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

const SCHEMA = {
  type: "object",
  properties: {
    follows: { type: "boolean" },
    about: { type: "string", enum: KINDS },
    calendar_tasks_or_notes: { type: "boolean" },
    sum: { type: "boolean" },
    oracle: { type: "boolean" },
  },
  required: ["follows", "about", "calendar_tasks_or_notes", "sum", "oracle"],
};

const instructions = (name) => [
  `Sort the user's latest message to ${name}, a voice assistant. Do not answer it. Give five things about it.`,
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
  "  versions, public events, who holds a post, this year's rates or limits. The user's own schedule is yours, not current.",
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
].join("\n");

// Returns { follows, about, lookup, sum, oracle }, or null if it could not be sorted.
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
    const { calendar_tasks_or_notes: lookup, ...sorted } = JSON.parse((await response.json()).message.content);
    return KINDS.includes(sorted.about) ? { ...sorted, lookup } : null;
  } catch (error) {
    console.error(`sort: ${error.message}`);
    return null;
  }
}
