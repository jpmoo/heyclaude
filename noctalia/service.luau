--!nonstrict
-- Follows the heyclaude daemon's event stream and publishes what the widget
-- and the voice panel draw. Shows the panel while Morgan is doing anything.

local PANEL = "jpmoo/morgan:voice"
local BARS = 48
local heyclaude = noctalia.expandPath("~/.local/bin/heyclaude")
-- By full path: the shell's own PATH need not include where it was installed.
local shell = noctalia.expandPath("~/.local/bin/noctalia")

local LOG = 120 -- lines of conversation the chat window shows

local levels = table.create(BARS, 0)
local log = {}
local open = false
local idleSince = 0

local heldOracle = nil -- what the Oracle said, waiting for the answer it belongs under

local function say(who: string, text: string, when: string?)
  table.insert(log, { who = who, text = text, when = when })
  while #log > LOG do
    table.remove(log, 1)
  end
  noctalia.state.set("log", log)
end

-- A step Morgan took, for the chat window to show as a small card.
local function act(glyph: string, title: string, detail: string, body: string?)
  table.insert(log, { who = "act", glyph = glyph, text = title, detail = detail, body = body })
  while #log > LOG do
    table.remove(log, 1)
  end
  noctalia.state.set("log", log)
end

-- An icon and a plain title for a tool, from its name: "HermesNotes__calendar_events"
-- becomes a calendar and "Calendar events · HermesNotes".
local ICONS = {
  { "calculate", "calculator" }, { "calendar", "calendar" }, { "event", "calendar" }, { "task", "checklist" }, { "todo", "checklist" },
  { "search", "search" }, { "find", "search" }, { "mail", "mail" }, { "message", "message" }, { "note", "notes" },
  { "block", "notes" }, { "project", "folders" }, { "tag", "tag" }, { "list_folder", "folder" }, { "folder", "folder" },
  { "file", "file-text" }, { "read", "file-text" }, { "collection", "stack-2" }, { "canvas", "layout-board" },
  { "daily", "sun" }, { "web", "world" }, { "fetch", "world" }, { "type", "category" },
}

local function describeTool(name: string): (string, string)
  local server, tool = name:match("^(.-)__(.+)$")
  tool = tool or name
  local glyph = "plug"
  for _, pair in ipairs(ICONS) do
    if tool:lower():find(pair[1], 1, true) then
      glyph = pair[2]
      break
    end
  end
  local title = tool:gsub("_", " ")
  title = title:sub(1, 1):upper() .. title:sub(2)
  return glyph, if server then `{title} · {server}` else title
end

-- A tool's arguments on one line: date 2026-10-13, when week.
local function details(args): string
  if type(args) ~= "table" then
    return ""
  end
  local parts = {}
  for key, value in pairs(args) do
    table.insert(parts, `{key} {if type(value) == "table" then noctalia.json.encode(value) else tostring(value)}`)
  end
  table.sort(parts)
  return table.concat(parts, ", ")
end

-- The assistant's name is a setting, and comes from the daemon.
local function who(): string
  return noctalia.state.get("name") or "Morgan"
end

local function show(want: boolean)
  -- The chat window has its own waveform; two of them at once is one too many.
  if want and (noctalia.state.get("chat_open") or noctalia.state.get("settings_open")) then
    want = false
  end
  if want == open then
    return
  end
  open = want
  noctalia.runAsync({ shell, "msg", if want then "panel-open" else "panel-close", PANEL })
end

local function clearLevels()
  levels = table.create(BARS, 0)
  noctalia.state.set("levels", levels)
end

local function onLine(line: string)
  local event = noctalia.json.decode(line)
  if type(event) ~= "table" then
    return
  end
  if event.type == "level" then
    table.remove(levels, 1)
    table.insert(levels, event.value)
    noctalia.state.set("levels", levels)
  elseif event.type == "state" then
    -- The first line of the stream carries the assistant's name.
    if event.name then
      noctalia.state.set("name", event.name)
    end
    noctalia.state.set("state", event.state)
    if event.state == "idle" then
      idleSince = noctalia.nowMs()
      noctalia.state.set("partial", "")
    else
      if event.state == "listening" then
        -- A new turn: the last one's words are not left up while the next is being said.
        noctalia.state.set("asked", "")
        noctalia.state.set("answer", "")
        noctalia.state.set("caption", "")
        clearLevels()
      end
      -- A typed turn is watched where it was typed: the chat panel, the window
      -- or a terminal. The popup is for what is said aloud.
      if not event.typed then
        show(true)
      end
    end
  elseif event.type == "reminder" then
    if event.set then
      act("bell", if (event.text or "") ~= "" then `Reminder set: {event.text}` else "Timer set", tostring(event.when or ""))
    else
      -- On screen as well as aloud, in case the sound is off or nobody is near.
      noctalia.notify(who(), tostring(event.text or "Reminder"))
      act("bell-ringing", "Reminder", tostring(event.text or ""))
    end
  elseif event.type == "filed" then
    -- The answer just given now has a place on the record, so it can be marked.
    for index = #log, 1, -1 do
      if log[index].who == "morgan" then
        log[index].t = event.t
        break
      end
    end
    noctalia.state.set("log", log)
  elseif event.type == "review" then
    -- Notes that may have come from an answer the user has hidden, to keep or delete.
    for _, line in ipairs(log) do
      if line.t == event.t then
        line.review = event.notes
      end
    end
    noctalia.state.set("log", log)
  elseif event.type == "rated" then
    for _, line in ipairs(log) do
      if line.t == event.t then
        line.hidden = event.vote == "down"
        line.good = event.vote == "up"
      end
    end
    noctalia.state.set("log", log)
  elseif event.type == "enroll" then
    -- Teaching a voice: the settings window ticks the sentences off as they are heard.
    if event.cancelled then
      noctalia.state.set("enroll", { active = false, outcome = "Nothing was heard for a while, so it was abandoned. Nothing has changed." })
    elseif (event.count or 0) >= (event.want or 6) then
      noctalia.state.set("enroll", { active = false, outcome = `{event.name}'s voice is taught. {who()} now answers only to voices it has been taught.` })
    else
      noctalia.state.set("enroll", { active = true, count = event.count or 0, name = event.name })
    end
  elseif event.type == "new" then
    -- A fresh conversation starts with an empty window. What was said is
    -- still in the transcript, and Morgan can still search it.
    log = {}
    noctalia.state.set("log", log)
    noctalia.state.set("partial", "")
  elseif event.type == "dismiss" then
    -- Escape, or a stop from anywhere: gone at once, not after the usual pause.
    show(false)
    clearLevels()
  elseif event.type == "user" then
    -- The popup shows the whole of the turn: what was asked, then the answer as it is spoken.
    noctalia.state.set("caption", "")
    noctalia.state.set("asked", event.text)
    noctalia.state.set("asked_when", tostring(event.when or ""))
    noctalia.state.set("answer", "")
    say("you", event.text, event.when)
  elseif event.type == "continuing" then
    -- The earlier conversation showing is carried on: no way "back", and a line where today begins.
    if log[1] and log[1].who == "past" then
      log[1].who = "carried"
      table.insert(log, { who = "divider", text = "Carried on today" })
      noctalia.state.set("log", log)
    end
  elseif event.type == "partial" then
    noctalia.state.set("partial", event.text)
  elseif event.type == "assistant" then
    noctalia.state.set("partial", "")
    say("morgan", event.text, event.when)
    if heldOracle then
      log[#log].oracle = heldOracle
      heldOracle = nil
      noctalia.state.set("log", log)
    end
  elseif event.type == "sentence" then
    local sofar = noctalia.state.get("answer") or ""
    noctalia.state.set("answer", if sofar == "" then event.text else `{sofar} {event.text}`)
  elseif event.type == "look" then
    noctalia.state.set("caption", `Looking at the {event.source}`)
    local glyph = if event.source == "camera" then "camera" elseif event.source == "clipboard" then "clipboard" else "device-desktop"
    act(glyph, `Looked at the {event.source}`, "")
  elseif event.type == "consult" then
    noctalia.state.set("caption", event.question)
    act("sparkles", "Asked the Oracle", event.question)
  elseif event.type == "oracle" then
    -- Kept to go under the answer it was for, folded away, rather than shown ahead of it.
    heldOracle = if heldOracle then `{heldOracle}\n\n{event.text}` else event.text
  elseif event.type == "tool" then
    local glyph, title = describeTool(event.name)
    act(glyph, title, details(event.args))
    log[#log].tool = true
  elseif event.type == "result" then
    -- What a tool returned, to be opened under its card.
    local last = log[#log]
    if last and last.tool and type(event.text) == "string" then
      last.body = event.text
      noctalia.state.set("log", log)
    end
  elseif event.type == "recall" then
    act("book", "Read from memory", tostring(event.topic or ""), if type(event.body) == "string" then event.body else nil)
  elseif event.type == "confirm" then
    local _, title = describeTool(event.name)
    if event.done == nil then
      act("hand-stop", `Waiting for your yes: {title:lower()}`, details(event.args))
    elseif event.done then
      act("circle-check", `Done: {title:lower()}`, "")
    else
      act("circle-x", `Not done: {title:lower()}`, "")
    end
  elseif event.type == "memory" then
    if event.rewritten then
      act("brain", "Tidied memory", tostring(event.topic or ""), if type(event.body) == "string" then event.body else nil)
    else
      act("bookmark", `Remembered in {event.topic}`, tostring(event.note or ""))
    end
  elseif event.type == "error" then
    noctalia.state.set("caption", event.message)
    act("alert-triangle", "Something went wrong", event.message)
  end
end

noctalia.state.set("state", "idle")
noctalia.state.set("caption", "")
noctalia.state.set("asked", "")
noctalia.state.set("answer", "")
noctalia.state.set("levels", levels)
noctalia.state.set("log", log)
noctalia.state.set("partial", "")

-- Exchanges from the record, with the cards that were shown at the time,
-- replayed through the same handling as live events.
local function replay(items)
  for _, item in ipairs(items) do
    table.insert(log, { who = "you", text = item.user, when = item.askedWhen })
    for _, step in ipairs(if type(item.steps) == "table" then item.steps else {}) do
      onLine(noctalia.json.encode(step))
    end
    table.insert(log, { who = "morgan", text = item.morgan, when = item.when, t = item.t, hidden = item.hidden, good = item.good, review = item.review, oracle = item.oracle })
  end
end

local function trim()
  while #log > LOG do
    table.remove(log, 1)
  end
end

-- Earlier conversations, so the chat window opens with something to scroll
-- back through. What arrived meanwhile goes after.
local function recent(keep: boolean)
  noctalia.runAsync({ heyclaude, "recent", "40" }, function(result)
    local reply = noctalia.json.decode(result.stdout or "")
    if type(reply) ~= "table" or type(reply.items) ~= "table" then
      return
    end
    local meanwhile = if keep then log else {}
    log = {}
    replay(reply.items)
    for _, line in ipairs(meanwhile) do
      table.insert(log, line)
    end
    trim()
    noctalia.state.set("log", log)
  end)
end

recent(true)

-- The chat window's calendar asks for an earlier conversation to be shown in
-- place of the one going on, or ("recent") for the way back.
noctalia.state.watch("load_request", function(request)
  if type(request) ~= "table" or type(request.id) ~= "string" then
    return
  end
  if request.id == "recent" then
    recent(false)
    return
  end
  noctalia.runAsync({ heyclaude, "conversation", request.id }, function(result)
    local reply = noctalia.json.decode(result.stdout or "")
    if type(reply) ~= "table" or not reply.ok then
      return
    end
    local related = {}
    for _, entry in ipairs(if type(reply.earlier) == "table" then reply.earlier else {}) do
      table.insert(related, { id = entry.id, t0 = entry.t0, title = entry.title, when = entry.when, how = "Possibly continues" })
    end
    for _, entry in ipairs(if type(reply.later) == "table" then reply.later else {}) do
      table.insert(related, { id = entry.id, t0 = entry.t0, title = entry.title, when = entry.when, how = "Possibly continued in" })
    end
    log = { { who = "past", id = reply.id, text = tostring(reply.title or ""), detail = tostring(reply.when or ""), related = related,
      similar = if type(reply.similar) == "table" then reply.similar else {} } }
    replay(reply.items or {})
    trim()
    noctalia.state.set("log", log)
  end)
end)

-- A request from the chat window to attach files (see chat.luau).
local function addFiles(paths)
  local files = noctalia.state.get("attachments") or {}
  for _, path in ipairs(paths) do
    table.insert(files, path)
  end
  noctalia.state.set("attachments", files)
end

noctalia.state.watch("attach_request", function(request)
  if type(request) ~= "table" then
    return
  end
  if request.from == "clipboard" then
    -- A copied file arrives as a file:// address; a copied path as plain text.
    noctalia.runAsync("wl-paste --type text/uri-list 2>/dev/null || wl-paste --no-newline 2>/dev/null", function(result)
      local found = {}
      for line in (result.stdout or ""):gmatch("[^\r\n]+") do
        local path = line:match("^file://(.+)$")
        if path then
          table.insert(found, noctalia.string.urlDecode(path))
        elseif line:sub(1, 1) == "/" then
          table.insert(found, line)
        elseif line:sub(1, 2) == "~/" then
          table.insert(found, noctalia.expandPath(line))
        end
      end
      if #found == 0 then
        noctalia.notify(who(), "Nothing copied looks like a file. Copy one in the file manager first.")
      else
        addFiles(found)
      end
    end)
    return
  end
  -- The chooser: this window out of the way first; `heyclaude choose` shows
  -- the chooser, adds what is picked and brings the window back. It is
  -- started without waiting on it, because a command that is waited on is
  -- given up on after a while, and that closed the chooser mid-choice.
  noctalia.runAsync({ shell, "msg", "panel-close", "jpmoo/morgan:chat" }, function()
    noctalia.runAsync({ heyclaude, "choose" })
  end)
end)

-- From outside: `heyclaude attach <file>` puts a file on the next message.
function onIpc(event, payload)
  if event == "attach" and type(payload) == "string" and payload ~= "" then
    addFiles({ payload })
  end
end

noctalia.state.watch("chat_open", function(value)
  if value then
    show(false)
  end
end)

-- The stream ends when the daemon restarts; pick it up again.
noctalia.runStream(`while :; do {heyclaude} watch 2>/dev/null; sleep 2; done`, onLine)

noctalia.setUpdateInterval(200)

function update()
  -- Linger a moment on idle: a follow-up or the next sentence often comes straight after.
  if open and noctalia.state.get("state") == "idle" and noctalia.nowMs() - idleSince >= 1200 then
    show(false)
    clearLevels()
  end
end

function onExit()
  noctalia.runAsync(`{shell} msg panel-close {PANEL}`)
end
