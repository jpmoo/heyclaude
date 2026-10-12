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
    noctalia.state.set("state", event.state)
    if event.state == "idle" then
      idleSince = noctalia.nowMs()
    else
      if event.state == "listening" then
        noctalia.state.set("caption", "")
        clearLevels()
      end
      show(true)
    end
  elseif event.type == "dismiss" then
    -- Escape, or a stop from anywhere: gone at once, not after the usual pause.
    show(false)
    clearLevels()
  elseif event.type == "user" then
    noctalia.state.set("caption", event.text)
    say("you", event.text)
  elseif event.type == "assistant" then
    say("morgan", event.text)
  elseif event.type == "sentence" then
    noctalia.state.set("caption", event.text)
  elseif event.type == "look" then
    noctalia.state.set("caption", `Looking at the {event.source}`)
    say("note", `Looking at the {event.source}`)
  elseif event.type == "consult" then
    noctalia.state.set("caption", event.question)
    say("note", `Asking the Oracle: {event.question}`)
  elseif event.type == "oracle" then
    say("oracle", event.text)
  elseif event.type == "tool" then
    local with = if event.args and next(event.args) then ` {noctalia.json.encode(event.args)}` else ""
    say("note", `Used {(event.name :: string):gsub("__", ": "):gsub("_", " ")}{with}`)
  elseif event.type == "recall" then
    say("note", `Looked up: {event.topic}`)
  elseif event.type == "confirm" then
    local what = (event.name :: string):gsub("__", ": "):gsub("_", " ")
    if event.done == nil then
      say("note", `Proposed: {what} {noctalia.json.encode(event.args or {})}`)
    else
      say("note", if event.done then `Carried out: {what}` else `Dropped, not done: {what}`)
    end
  elseif event.type == "memory" then
    say("note", if event.rewritten then `Tidied the topic {event.topic}` else `Remembered: {event.note}`)
  elseif event.type == "error" then
    noctalia.state.set("caption", event.message)
    say("note", event.message)
  end
end

noctalia.state.set("state", "idle")
noctalia.state.set("caption", "")
noctalia.state.set("levels", levels)
noctalia.state.set("log", log)

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
