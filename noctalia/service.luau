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

local function say(who: string, text: string)
  table.insert(log, { who = who, text = text })
  while #log > LOG do
    table.remove(log, 1)
  end
  noctalia.state.set("log", log)
end

-- A step Morgan took, for the chat window to show as a small card.
local function act(glyph: string, title: string, detail: string)
  table.insert(log, { who = "act", glyph = glyph, text = title, detail = detail })
  while #log > LOG do
    table.remove(log, 1)
  end
  noctalia.state.set("log", log)
end

-- An icon and a plain title for a tool, from its name: "HermesNotes__calendar_events"
-- becomes a calendar and "Calendar events · HermesNotes".
local ICONS = {
  { "calendar", "calendar" }, { "event", "calendar" }, { "task", "checklist" }, { "todo", "checklist" },
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
  if want and noctalia.state.get("chat_open") then
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
        noctalia.state.set("caption", "")
        clearLevels()
      end
      show(true)
    end
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
    noctalia.state.set("caption", event.text)
    say("you", event.text)
  elseif event.type == "partial" then
    noctalia.state.set("partial", event.text)
  elseif event.type == "assistant" then
    noctalia.state.set("partial", "")
    say("morgan", event.text)
  elseif event.type == "sentence" then
    noctalia.state.set("caption", event.text)
  elseif event.type == "look" then
    noctalia.state.set("caption", `Looking at the {event.source}`)
    local glyph = if event.source == "camera" then "camera" elseif event.source == "clipboard" then "clipboard" else "device-desktop"
    act(glyph, `Looked at the {event.source}`, "")
  elseif event.type == "consult" then
    noctalia.state.set("caption", event.question)
    act("sparkles", "Asked the Oracle", event.question)
  elseif event.type == "oracle" then
    say("oracle", event.text)
  elseif event.type == "tool" then
    local glyph, title = describeTool(event.name)
    act(glyph, title, details(event.args))
  elseif event.type == "recall" then
    act("book", "Read from memory", tostring(event.topic or ""))
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
      act("brain", "Tidied memory", tostring(event.topic or ""))
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
noctalia.state.set("levels", levels)
noctalia.state.set("log", log)
noctalia.state.set("partial", "")

-- Earlier conversations, so the chat window opens with something to scroll back through.
noctalia.runAsync({ heyclaude, "recent", "40" }, function(result)
  local reply = noctalia.json.decode(result.stdout or "")
  if type(reply) ~= "table" or type(reply.items) ~= "table" then
    return
  end
  local earlier = {}
  for _, item in ipairs(reply.items) do
    table.insert(earlier, { who = "you", text = item.user })
    table.insert(earlier, { who = "morgan", text = item.morgan })
  end
  for _, line in ipairs(log) do
    table.insert(earlier, line)
  end
  log = earlier
  noctalia.state.set("log", log)
end)

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
