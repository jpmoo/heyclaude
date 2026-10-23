--!nonstrict
-- The settings window: memory, voice, listening, files and connections. It
-- holds no settings of its own. Everything shown is asked of the daemon, and
-- every change is a request to it (`heymorgan admin`), so this window and
-- `heymorgan settings` in a terminal are two views of the same thing.

local heymorgan = noctalia.expandPath("~/.local/bin/heymorgan")

local custom = noctalia.getConfig("accent_source") ~= "theme"
local accent = if custom then (noctalia.getConfig("accent") or "#6f9bb3") else "primary"

-- The window's frame: see-through, but dimmed enough that what is behind it
-- does not compete with what is in it. The areas holding text are solid.
local FRAME = "surface/0.6"
-- The shell keeps a 16 px margin inside a panel, so what is drawn has that
-- much less height than the panel was declared with. Drawn taller, the
-- backing hangs out below the window.
local INSIDE = 740 - 2 * 16

local function tint(color: string, alpha: number): string
  if color:sub(1, 1) == "#" then
    return color:sub(1, 7) .. string.format("%02x", math.floor(alpha * 255 + 0.5))
  end
  return `{color}/{alpha}`
end

-- The assistant's name is a setting, and comes from the daemon.
local function who(): string
  return noctalia.state.get("name") or "Morgan"
end

local WIDTH = 900 - 2 * 16
local TABS = {
  { id = "memory", label = "Memory", glyph = "brain" },
  { id = "voice", label = "Voice", glyph = "volume" },
  { id = "listening", label = "Listening", glyph = "ear" },
  { id = "files", label = "Files", glyph = "folder" },
  { id = "connections", label = "Connections", glyph = "plug" },
  { id = "log", label = "Log", glyph = "file-text" },
}

local tab = "memory"
local D = {} -- what the daemon last said, by request
local version = 0 -- bumped whenever D changes, so that text boxes take the new values
local drafts = {} -- text typed but not yet saved, by field
local status = "" -- one line of news: saved, failed, restarting
local settle = 0 -- seconds until a restarted daemon is asked again
local confirming = nil -- the delete button that has been pressed once
local view = {} -- what is opened up: a topic, a note being edited, a document

local render
local refresh

-- ---------------------------------------------------------------- the daemon

local function call(op: string, args, done)
  noctalia.runAsync({ heymorgan, "admin", noctalia.json.encode({ op = op, args = args or {} }) }, function(result)
    local answer = noctalia.json.decode(result.stdout or "")
    if type(answer) ~= "table" then
      answer = { ok = false, error = `{who()} is not running` }
    end
    if done then
      done(answer)
    end
  end)
end

-- Make a change, say how it went, and show things as they now are.
local function change(op: string, args, said: string?)
  confirming = nil
  call(op, args, function(answer)
    if not answer.ok then
      status = `That did not work: {answer.error}`
    elseif answer.restart then
      status = `Saved. {who()} is restarting to take it up…`
      settle = 6
    else
      status = said or "Saved."
    end
    refresh()
  end)
end

local function set(values, said: string?)
  change("config.set", { values = values }, said)
end

local NEEDS = {
  memory = { "memory.list", "config.get", "memory.garden.report" },
  voice = { "voice.list", "voices.status", "config.get" },
  listening = { "config.get", "reminders.list" },
  files = { "config.get" },
  connections = { "client.get", "config.get", "oracle.account", "mcp.list", "ollama.models" },
  log = { "log.recent" },
}

refresh = function()
  local wanted = NEEDS[tab]
  local left = #wanted
  for _, op in ipairs(wanted) do
    call(op, {}, function(answer)
      D[op] = answer
      left -= 1
      if left == 0 then
        version += 1
        drafts = {}
        render()
      end
    end)
  end
end

-- ---------------------------------------------------------------- pieces

local function card(heading: string?, children)
  local inside = {}
  if heading then
    table.insert(inside, ui.label({ text = heading, color = accent, fontSize = 13, fontWeight = "bold" }))
  end
  for _, child in ipairs(children) do
    table.insert(inside, child)
  end
  return ui.column({ gap = 8, padding = 12, radius = 12, fill = "surface", border = "outline/0.3", borderWidth = 1 }, inside)
end

local function hint(text: string)
  return ui.label({ text = text, color = "on_surface_variant", fontSize = 11, maxWidth = WIDTH - 60 })
end

-- Buttons laid out a few to a row, since a row does not wrap.
local function rows(buttons, per: number)
  local out = {}
  for start = 1, #buttons, per do
    local row = {}
    for index = start, math.min(start + per - 1, #buttons) do
      table.insert(row, buttons[index])
    end
    table.insert(out, ui.row({ gap = 6, align = "center" }, row))
  end
  return ui.column({ gap = 6 }, out)
end

local function choice(key: string, text: string, chosen: boolean, onClick)
  return ui.button({ key = key, text = text, variant = if chosen then "primary" else "outline", controlSize = "sm", selected = chosen, onClick = onClick })
end

-- A delete that has to be pressed twice.
local function remove(key: string, tooltip: string, action)
  if confirming == key then
    return ui.button({ key = key, text = "Delete?", variant = "destructive", controlSize = "sm", onClick = action })
  end
  return ui.button({
    key = key, glyph = "trash", variant = "ghost", controlSize = "sm", tooltip = tooltip,
    onClick = function()
      confirming = key
      render()
    end,
  })
end

-- A line of text, saved by pressing Enter in it or by the button beside it.
local function field(key: string, label: string, value: string?, placeholder: string, save)
  return ui.row({ gap = 10, align = "center" }, {
    ui.row({ width = 200, align = "center" }, { ui.label({ text = label, color = "on_surface", fontSize = 12, maxWidth = 196 }) }),
    ui.input({
      key = `{key}#{version}`, value = value or "", placeholder = placeholder, flexGrow = 1, controlSize = "sm",
      onChange = function(text)
        drafts[key] = text
      end,
      onSubmit = save,
    }),
    ui.button({
      key = `save:{key}`, text = "Save", variant = "secondary", controlSize = "sm",
      onClick = function()
        save(if drafts[key] ~= nil then drafts[key] else (value or ""))
      end,
    }),
  })
end

local function slider(key: string, label: string, value: number, low: number, high: number, step: number, save)
  return ui.row({ gap = 10, align = "center" }, {
    ui.row({ width = 200, align = "center" }, { ui.label({ text = label, color = "on_surface", fontSize = 12, maxWidth = 196 }) }),
    ui.slider({
      key = `{key}#{version}`, min = low, max = high, step = step, value = value, flexGrow = 1, controlSize = "sm",
      onDragEnd = function(now)
        save(tonumber(now) or value)
      end,
    }),
    ui.label({ text = tostring(value), color = "on_surface_variant", fontSize = 12, width = 44 }),
  })
end

local function switch(key: string, label: string, on: boolean, save)
  return ui.row({ gap = 10, align = "center" }, {
    ui.toggle({
      key = key, checked = on,
      onChange = function(now)
        save(now == "true")
      end,
    }),
    ui.label({ text = label, color = "on_surface", fontSize = 12 }),
  })
end

local function date(ms: number): string
  return os.date("%d %b %Y", math.floor(ms / 1000))
end

-- ---------------------------------------------------------------- memory

local function memoryTab()
  local list = D["memory.list"] or {}
  local topics = list.topics or {}
  local out = {}

  local chips = {}
  local current = nil
  for _, topic in ipairs(topics) do
    if view.topic == nil then
      view.topic = topic.name
    end
    if topic.name == view.topic then
      current = topic
    end
    table.insert(chips, choice(`t:{topic.name}`, `{topic.name}  {#topic.notes}`, topic.name == view.topic, function()
      view = { topic = topic.name }
      confirming = nil
      render()
    end))
  end
  table.insert(out, card("Topics", {
    rows(chips, 4),
    ui.input({
      key = `newtopic#{version}`, placeholder = "A new topic: type its name and press Enter", controlSize = "sm",
      onSubmit = function(name)
        view = { topic = name }
        change("memory.topic.add", { name = name }, "Topic added.")
      end,
    }),
  }))

  if current then
    local notes = {}
    for index, note in ipairs(current.notes) do
      local at = index - 1 -- the daemon counts from nought
      if view.editing == index then
        table.insert(notes, ui.column({ key = `note{index}`, gap = 6, padding = 8, radius = 8, fill = tint(accent, 0.12) }, {
          ui.input({
            key = `edit{index}#{version}`, value = note, multiline = true, submitOnEnter = true, focus = true, height = 70,
            onChange = function(text)
              drafts.note = text
            end,
            onSubmit = function(text)
              view.editing = nil
              change("memory.note.set", { topic = current.name, index = at, text = text }, "Note changed.")
            end,
          }),
          ui.row({ gap = 6 }, {
            ui.button({ text = "Save", variant = "primary", controlSize = "sm", onClick = function()
              view.editing = nil
              change("memory.note.set", { topic = current.name, index = at, text = drafts.note or note }, "Note changed.")
            end }),
            ui.button({ text = "Cancel", variant = "ghost", controlSize = "sm", onClick = function()
              view.editing = nil
              render()
            end }),
          }),
        }))
      else
        local row = {
          ui.row({ key = `note{index}`, gap = 6, align = "center" }, {
            ui.label({ text = note, color = "on_surface", fontSize = 12, maxWidth = WIDTH - 190, flexGrow = 1 }),
            ui.button({ glyph = "pencil", variant = "ghost", controlSize = "sm", tooltip = "Edit", onClick = function()
              view.editing = index
              view.moving = nil
              drafts.note = note
              confirming = nil
              render()
            end }),
            ui.button({ glyph = "arrow-right", variant = "ghost", controlSize = "sm", tooltip = "Move to another topic", onClick = function()
              view.moving = if view.moving == index then nil else index
              view.editing = nil
              confirming = nil
              render()
            end }),
            remove(`del{index}`, "Delete this note", function()
              change("memory.note.delete", { topic = current.name, index = at }, "Note deleted.")
            end),
          }),
        }
        if view.moving == index then
          local targets = {}
          for _, other in ipairs(topics) do
            if other.name ~= current.name then
              table.insert(targets, choice(`mv:{other.name}`, other.name, false, function()
                view.moving = nil
                change("memory.note.move", { topic = current.name, index = at, to = other.name }, `Moved to {other.name}.`)
              end))
            end
          end
          table.insert(row, ui.column({ gap = 4, padding = 8, radius = 8, fill = tint(accent, 0.12) }, { hint("Move it to:"), rows(targets, 4) }))
        end
        table.insert(notes, ui.column({ gap = 4 }, row))
        table.insert(notes, ui.separator({ color = "outline/0.15" }))
      end
    end
    if #current.notes == 0 then
      table.insert(notes, hint("Nothing here yet."))
    end

    table.insert(out, card(current.name, {
      field(`describe:{current.name}`, "What belongs here", current.description, "A line saying what goes in this topic", function(text)
        change("memory.topic.rename", { topic = current.name, name = current.name, description = text }, "Description changed.")
      end),
      field(`rename:{current.name}`, "Its name", current.name, "", function(text)
        view.topic = text
        change("memory.topic.rename", { topic = current.name, name = text, description = current.description }, "Topic renamed.")
      end),
      ui.separator({ color = "outline/0.3" }),
      ui.column({ gap = 6 }, notes),
      ui.input({
        key = `addnote:{current.name}#{version}`, placeholder = "Add a note: type it and press Enter", controlSize = "sm",
        onSubmit = function(text)
          change("memory.note.add", { topic = current.name, text = text }, "Note added.")
        end,
      }),
      ui.row({ gap = 6, align = "center" }, {
        ui.spacer({ flexGrow = 1 }),
        hint("Delete the whole topic"),
        remove("deltopic", "Delete this topic and its notes", function()
          view = {}
          change("memory.topic.delete", { topic = current.name }, "Topic deleted.")
        end),
      }),
    }))
  end

  local documents = {}
  for _, kept in ipairs(list.documents or {}) do
    table.insert(documents, ui.row({ key = `doc:{kept.title}`, gap = 6, align = "center" }, {
      ui.column({ gap = 0, flexGrow = 1 }, {
        ui.label({ text = kept.title, color = "on_surface", fontSize = 12, fontWeight = "bold" }),
        hint(`{kept.size} characters, kept {date(kept.t)} from {kept.source}`),
      }),
      ui.button({ glyph = "eye", variant = "ghost", controlSize = "sm", tooltip = "Read it", onClick = function()
        if view.document and view.document.title == kept.title then
          view.document = nil
          render()
          return
        end
        call("memory.document.get", { title = kept.title }, function(answer)
          view.document = if answer.ok then answer else nil
          render()
        end)
      end }),
      remove(`deldoc:{kept.title}`, "Delete from memory (the original file is untouched)", function()
        view.document = nil
        change("memory.document.delete", { title = kept.title }, "Document deleted from memory.")
      end),
    }))
    if view.document and view.document.title == kept.title then
      local more = if (view.document.more or 0) > 0 then `\n\n*…and {view.document.more} more characters.*` else ""
      table.insert(documents, ui.column({ padding = 10, radius = 8, fill = "surface/0.6" }, {
        ui.markdown({ text = view.document.text .. more, width = WIDTH - 90 }),
      }))
    end
  end
  if #documents == 0 then
    table.insert(documents, hint(`None. Ask {who()} to remember a file, attached in the chat window or in a folder it may read.`))
  end
  table.insert(out, card("Documents kept in full", documents))

  local pictures = {}
  for _, picture in ipairs(list.pictures or {}) do
    table.insert(pictures, ui.row({ key = `pic:{picture.label}`, gap = 6, align = "center" }, {
      ui.column({ gap = 0, flexGrow = 1 }, {
        ui.label({ text = picture.label, color = "on_surface", fontSize = 12, fontWeight = "bold" }),
        hint(`{if (picture.note or "") ~= "" then picture.note .. ", " else ""}kept {date(picture.t)}`),
      }),
      ui.button({ glyph = "eye", variant = "ghost", controlSize = "sm", tooltip = "Look at it", onClick = function()
        if view.picture and view.picture.label == picture.label then
          view.picture = nil
          render()
          return
        end
        call("memory.picture.view", { label = picture.label }, function(answer)
          view.picture = if answer.ok then { label = picture.label, path = answer.path } else nil
          render()
        end)
      end }),
      remove(`delpic:{picture.label}`, "Delete this picture", function()
        view.picture = nil
        change("memory.picture.delete", { label = picture.label }, "Picture deleted.")
      end),
    }))
    if view.picture and view.picture.label == picture.label then
      table.insert(pictures, ui.image({ path = view.picture.path, width = 320, height = 240, radius = 8, fit = "contain" }))
    end
  end
  if #pictures == 0 then
    table.insert(pictures, hint("None. Say “remember what I look like” or “this is my dog” while the camera can see."))
  end
  table.insert(out, card("Pictures, for recognising people and things", pictures))

  -- What the gardener changed, day by day, each change undoable on its own.
  local tidied = {}
  for dayIndex, day in ipairs((D["memory.garden.report"] or {}).days or {}) do
    table.insert(tidied, ui.label({ key = `gd{dayIndex}`, text = day.when, color = "on_surface", fontSize = 12, fontWeight = "bold" }))
    for _, item in ipairs(day.changes or {}) do
      table.insert(tidied, ui.row({ key = `gc{item.id}`, gap = 10, align = "start" }, {
        ui.column({ gap = 2, flexGrow = 1 }, {
          ui.label({ text = item.said, color = if item.undone then "on_surface_variant" else "on_surface", fontSize = 12, maxWidth = WIDTH - 200 }),
          hint(item.detail or ""),
        }),
        if item.undone then ui.label({ text = "Undone", color = "on_surface_variant", fontSize = 11 })
        else ui.button({ text = "Undo", glyph = "arrow-back-up", variant = "ghost", controlSize = "sm", onClick = function()
          change("memory.garden.undo", { id = item.id }, "Undone.")
        end }),
      }))
    end
  end
  if #tidied == 0 then
    table.insert(tidied, hint(`Nothing tidied yet. Once a day, when nothing is going on, {who()} merges notes that say the same thing, folds small topics it made back into the others, and splits topics grown too big. Topics you made are never folded away.`))
  end
  table.insert(out, card("Kept tidy automatically", {
    ui.row({ gap = 8 }, {
      ui.button({ text = "Tidy now", glyph = "sparkles", variant = "secondary", controlSize = "sm", onClick = function()
        status = "Tidying…"
        render()
        change("memory.garden.run", {}, "Tidied.")
      end }),
    }),
    ui.column({ gap = 8 }, tidied),
  }))

  local config = D["config.get"] or {}
  table.insert(out, card("Earlier conversations", {
    slider("similar", "How alike a conversation must be to be listed as similar", config.similarFloor or 0.7, 0.5, 0.95, 0.05, function(now)
      set({ similarFloor = math.floor(now * 100 + 0.5) / 100 })
    end),
    hint("For the list under a conversation opened from the calendar. Lower lists more; conversations scoring 0.78 or more are also linked as possibly continuing one another."),
  }))
  return out
end

-- ---------------------------------------------------------------- voice

-- What to read aloud: the wake phrase and the name are the ones in use.
local function phrases()
  local config = D["config.get"] or {}
  local wake = config.wakeWord or `Hey {who()}`
  return {
    `{wake}, what's on my calendar for tomorrow afternoon?`,
    "Remind me to pick up the dry cleaning on the way home.",
    "The quick brown fox jumps over the lazy dog by the river.",
    `{wake}, read me the first three things on my task list.`,
    "I'd like to hear the weather for the weekend, please.",
    `{who()}, stop. Never mind, that's all for now, thanks.`,
  }
end

local function kokoroName(voice: string): string
  local kind, who = voice:match("^(%a%a)_(.+)$")
  if not kind then
    return voice
  end
  return `{who:sub(1, 1):upper()}{who:sub(2)} · {if kind:sub(1, 1) == "a" then "US" else "UK"} {if kind:sub(2, 2) == "f" then "woman" else "man"}`
end

local function voiceTab()
  local voice = D["voice.list"] or {}
  local heard = D["voices.status"] or {}
  local config = D["config.get"] or {}
  local out = {}

  local engines = {
    choice("eng:kokoro", "Kokoro: more natural", voice.engine == "kokoro", function()
      set({ engine = "kokoro" })
    end),
    choice("eng:piper", "Piper: lighter, quicker to start", voice.engine ~= "kokoro", function()
      set({ engine = "piper" })
    end),
  }
  table.insert(out, card(`How {who()} speaks`, { ui.row({ gap = 6 }, engines), hint("Click a voice below to hear it, then “Use it”.") }))

  if voice.kokoroInstalled then
    local picked = view.kokoro or voice.kokoroVoice
    local chips = {}
    for _, name in ipairs(voice.kokoro or {}) do
      table.insert(chips, choice(`k:{name}`, kokoroName(name), name == picked, function()
        view.kokoro = name
        call("voice.preview", { engine = "kokoro", voice = name })
        render()
      end))
    end
    table.insert(out, card("Kokoro voices", {
      rows(chips, 5),
      ui.row({ gap = 8, align = "center" }, {
        ui.button({
          text = if picked == voice.kokoroVoice and voice.engine == "kokoro" then `{kokoroName(picked)} is in use` else `Use {kokoroName(picked)}`,
          variant = "primary", controlSize = "sm", enabled = not (picked == voice.kokoroVoice and voice.engine == "kokoro"),
          onClick = function()
            set({ kokoroVoice = picked, engine = "kokoro" })
          end,
        }),
      }),
      slider("speed", "Speaking speed", voice.kokoroSpeed or 1, 0.6, 1.6, 0.1, function(now)
        set({ kokoroSpeed = math.floor(now * 10 + 0.5) / 10 })
      end),
    }))
  end

  local piperPicked = view.piper or voice.piperVoice
  local piper = {}
  for _, name in ipairs(voice.piper or {}) do
    table.insert(piper, choice(`p:{name}`, name, name == piperPicked, function()
      view.piper = name
      call("voice.preview", { engine = "piper", voice = name })
      render()
    end))
  end
  table.insert(out, card("Piper voices", {
    rows(piper, 3),
    ui.row({ gap = 8, align = "center" }, {
      ui.button({ text = `Use {piperPicked or "this voice"}`, variant = "primary", controlSize = "sm", onClick = function()
        set({ voice = piperPicked, engine = "piper" })
      end }),
      hint("More can be downloaded from “heymorgan settings” in a terminal."),
    }),
  }))

  -- Whose voice it answers to.
  local taught = {}
  for _, name in ipairs(heard.enrolled or {}) do
    table.insert(taught, ui.row({ key = `v:{name}`, gap = 6, align = "center" }, {
      ui.label({ text = name, color = "on_surface", fontSize = 12, flexGrow = 1 }),
      remove(`forget:{name}`, "Forget this voice", function()
        change("voices.forget", { name = name }, "Voice forgotten.")
      end),
    }))
  end
  if #taught == 0 then
    table.insert(taught, hint(`No voice has been taught, so {who()} answers anyone.`))
  end

  local teaching = noctalia.state.get("enroll")
  local lesson = {}
  if type(teaching) == "table" and teaching.active then
    table.insert(lesson, hint("Read each line aloud at your usual distance, pausing after each until it is ticked."))
    for index, phrase in ipairs(phrases()) do
      local done = index <= (teaching.count or 0)
      table.insert(lesson, ui.row({ gap = 8, align = "center" }, {
        ui.glyph({ name = if done then "circle-check" else "circle", size = 16, color = if done then accent else "on_surface_variant" }),
        ui.label({ text = phrase, color = if index == (teaching.count or 0) + 1 then "on_surface" else "on_surface_variant", fontSize = 12 }),
      }))
    end
  else
    if type(teaching) == "table" and teaching.outcome then
      table.insert(lesson, hint(teaching.outcome))
    end
    table.insert(lesson, ui.row({ gap = 8, align = "center" }, {
      ui.input({
        key = `teach#{version}`, value = config.userName or "", placeholder = "Whose voice?", controlSize = "sm", width = 220,
        onChange = function(text)
          drafts.teach = text
        end,
      }),
      ui.button({ text = "Teach this voice", variant = "primary", controlSize = "sm", enabled = heard.installed == true, onClick = function()
        local name = drafts.teach or config.userName or ""
        if name == "" then
          status = "Whose voice is it? Type a name first."
          render()
          return
        end
        noctalia.state.set("enroll", { active = true, count = 0, name = name })
        call("voices.enroll", { name = name }, function(answer)
          if not answer.ok then
            noctalia.state.set("enroll", { active = false, outcome = `Could not start: {answer.error}` })
          end
        end)
      end }),
      hint("Six short sentences, about a minute."),
    }))
  end

  local checks = {}
  for index, check in ipairs(heard.checks or {}) do
    if index > #heard.checks - 8 then
      table.insert(checks, hint(`{os.date("%H:%M:%S", math.floor(check.t / 1000))}   {check.seconds}s   score {check.score} (needed {check.need or "?"})   {if check.ok then "accepted as " .. tostring(check.name) else "ignored"}`))
    end
  end
  if #checks == 0 then
    table.insert(checks, hint(`No checks yet. Each time {who()} hears speech it could act on, the score appears here.`))
  end

  table.insert(out, card(`Voices {who()} answers to`, {
    ui.column({ gap = 4 }, taught),
    ui.separator({ color = "outline/0.3" }),
    ui.column({ gap = 6 }, lesson),
    ui.separator({ color = "outline/0.3" }),
    switch("only", "Ignore voices it has not been taught", heard.only ~= false, function(on)
      set({ knownVoicesOnly = on })
    end),
    slider("bar", "How alike a voice must be", heard.threshold or 0.4, 0.1, 0.8, 0.05, function(now)
      set({ voiceThreshold = math.floor(now * 100 + 0.5) / 100 })
    end),
    hint("Lower forgives more. Recent checks:"),
    ui.column({ gap = 2 }, checks),
  }))
  return out
end

-- ---------------------------------------------------------------- listening

local function listeningTab()
  local config = D["config.get"] or {}
  local sight = {}
  for _, source in ipairs(config.sight or {}) do
    sight[source] = true
  end
  local function look(source: string, on: boolean)
    local now = {}
    for _, name in ipairs({ "screen", "clipboard", "camera" }) do
      if (name == source and on) or (name ~= source and sight[name]) then
        table.insert(now, name)
      end
    end
    set({ sight = now })
  end

  local set = {}
  for _, entry in ipairs((D["reminders.list"] or {}).reminders or {}) do
    table.insert(set, ui.row({ key = `r:{entry.id}`, gap = 8, align = "center" }, {
      ui.glyph({ name = "bell", size = 16, color = accent }),
      ui.column({ gap = 0, flexGrow = 1 }, {
        ui.label({ text = if (entry.text or "") ~= "" then entry.text else "A timer", color = "on_surface", fontSize = 12, fontWeight = "bold" }),
        hint(entry.when),
      }),
      remove(`unremind:{entry.id}`, "Cancel this one", function()
        change("reminders.cancel", { id = entry.id }, "Cancelled.")
      end),
    }))
  end
  if #set == 0 then
    table.insert(set, hint(`None. Say “remind me to…” or “set a timer for…”, and {who()} speaks up when it is due.`))
  end

  return {
    card("Timers and reminders", set),
    card("Who is who", {
      field("name", "The assistant's name", config.name, `{who()}`, function(text)
        set({ name = text })
      end),
      field("userName", "Your name", config.userName, "What it calls you", function(text)
        set({ userName = text })
      end),
      field("style", "Manner of speaking", config.style, "Describe how it should talk", function(text)
        set({ style = text })
      end),
      hint("Press Enter in a box, or its Save button, to save it."),
    }),
    card("Waking and interrupting", {
      field("wakeWord", "Wake phrase", config.wakeWord, "Empty turns it off", function(text)
        set({ wakeWord = text })
      end),
      field("interruptWord", "Word that interrupts an answer", config.interruptWord, "Empty turns it off", function(text)
        set({ interruptWord = text })
      end),
      field("hotkey", "Key that opens the chat window", config.hotkey, "For example SUPER, grave", function(text)
        set({ hotkey = text })
      end),
      slider("follow", "Seconds to wait for a reply", config.followUpSeconds or 6, 0, 15, 1, function(now)
        set({ followUpSeconds = now })
      end),
      slider("silence", "Quiet that ends your turn (ms)", config.endSilenceMs or 900, 400, 2000, 100, function(now)
        set({ endSilenceMs = now })
      end),
    }),
    card(`What {who()} may look at, when asked`, {
      switch("sight:screen", "The screen", sight.screen == true, function(on)
        look("screen", on)
      end),
      switch("sight:clipboard", "The clipboard", sight.clipboard == true, function(on)
        look("clipboard", on)
      end),
      switch("sight:camera", "The camera", sight.camera == true, function(on)
        look("camera", on)
      end),
      hint("Pictures are kept only when you say so."),
    }),
  }
end

-- ---------------------------------------------------------------- files

local function filesTab()
  local config = D["config.get"] or {}
  local folders = config.folders or {}
  local function without(gone: string)
    local now = {}
    for _, folder in ipairs(folders) do
      if folder ~= gone then
        table.insert(now, folder)
      end
    end
    return now
  end
  local function with(added: string)
    local now = without(added)
    table.insert(now, added)
    return now
  end

  local list = {}
  for _, folder in ipairs(folders) do
    table.insert(list, ui.row({ key = `f:{folder}`, gap = 6, align = "center" }, {
      ui.glyph({ name = "folder", size = 16, color = accent }),
      ui.label({ text = folder, color = "on_surface", fontSize = 12, flexGrow = 1 }),
      remove(`unfolder:{folder}`, `Stop {who()} reading this folder`, function()
        set({ folders = without(folder) }, "Folder removed.")
      end),
    }))
  end
  if #list == 0 then
    table.insert(list, hint(`None. {who()} can still read a file you attach in the chat window.`))
  end

  return {
    card(`Folders {who()} may read`, {
      ui.column({ gap = 4 }, list),
      ui.row({ gap = 8, align = "center" }, {
        ui.input({
          key = `folder#{version}`, placeholder = "A folder, for example ~/Documents/Notes, then Enter", flexGrow = 1, controlSize = "sm",
          onSubmit = function(text)
            if text ~= "" then
              set({ folders = with(text) }, "Folder added.")
            end
          end,
        }),
        ui.button({ text = "Browse…", variant = "secondary", controlSize = "sm", onClick = function()
          -- Closed first so the chooser is not behind this window; `heymorgan
          -- choose-folder` adds what is picked and reopens it.
          panel.close()
          noctalia.runAsync({ heymorgan, "choose-folder" })
        end }),
      }),
      hint("Markdown, text, code, PDFs and pictures inside these folders can be listed, searched and read. Nothing is ever written."),
    }),
  }
end

-- ---------------------------------------------------------------- connections

-- ---------------------------------------------------------------- log

-- What Morgan has written to its log lately, newest at the bottom: what went
-- wrong, and what it did. Errors stand out; "Problems only" hides the rest.
local function logTab()
  local lines = (D["log.recent"] or {}).lines or {}
  local shown = {}
  local copy = {}
  for index, line in ipairs(lines) do
    local bad = line.level == "error" or line.level == "warn"
    if bad or not view.problemsOnly then
      table.insert(shown, ui.row({ key = `l{index}`, gap = 10, align = "start" }, {
        ui.row({ width = 76 }, { ui.label({ text = line.at or "", color = "on_surface_variant", fontSize = 10 }) }),
        ui.label({ text = line.text or "", color = if line.level == "error" then "error" elseif line.level == "warn" then "tertiary" else "on_surface", fontSize = 11, maxWidth = WIDTH - 140 }),
      }))
      table.insert(copy, `{line.at}  {line.text}`)
    end
  end
  if #shown == 0 then
    table.insert(shown, hint(if view.problemsOnly then "Nothing has gone wrong lately." else `{who()} has not logged anything since it started.`))
  end
  return {
    card(`What {who()} has logged lately`, {
      ui.row({ gap = 8, align = "center" }, {
        ui.button({ text = "Refresh", glyph = "refresh", variant = "secondary", controlSize = "sm", onClick = function()
          refresh()
        end }),
        ui.button({ text = if view.problemsOnly then "Show everything" else "Problems only", glyph = "alert-triangle", variant = if view.problemsOnly then "secondary" else "ghost", controlSize = "sm", onClick = function()
          view.problemsOnly = not view.problemsOnly
          render()
        end }),
        ui.button({ text = "Copy", glyph = "copy", variant = "ghost", controlSize = "sm", onClick = function()
          noctalia.copyToClipboard(table.concat(copy, "\n"), "text/plain")
          status = "Copied the log."
          render()
        end }),
        ui.spacer({ flexGrow = 1 }),
        hint("The latest 200 lines since it last started. `heymorgan log -f` follows it in a terminal."),
      }),
      ui.separator({ color = "outline/0.3" }),
      ui.column({ gap = 3 }, shown),
    }),
  }
end

local function connectionsTab()
  local config = D["config.get"] or {}
  local models = D["ollama.models"] or {}
  local account = D["oracle.account"] or {}
  local servers = (D["mcp.list"] or {}).servers or {}
  local out = {}

  -- Where Morgan lives: wholly on this laptop, or on the home server with
  -- this laptop as a client of it. Changing it starts this laptop's Morgan again.
  local place = D["client.get"] or {}
  local function draft(key: string, value: string?): string
    return if drafts[key] ~= nil then drafts[key] else (value or "")
  end
  local function input(key: string, label: string, value: string?, placeholder: string)
    return ui.row({ gap = 10, align = "center" }, {
      ui.row({ width = 200, align = "center" }, { ui.label({ text = label, color = "on_surface", fontSize = 12, maxWidth = 196 }) }),
      ui.input({
        key = `{key}#{version}`, value = value or "", placeholder = placeholder, flexGrow = 1, controlSize = "sm",
        onChange = function(text)
          drafts[key] = text
        end,
      }),
    })
  end
  table.insert(out, card(`Where {who()} lives`, {
    hint(if place.role == "client"
      then `On the server at {place.server}, as {place.device}; {if place.connected then "connected" else "not reachable just now"}.`
      elseif place.role == "server" then "This is the server."
      else "Wholly on this laptop. Give a server's address and a key from it to make this laptop one of its clients."),
    input("home.server", "Server", place.server, "home-server:8790, or https://your-tailnet-name/heymorgan"),
    input("home.key", "Key", "", if place.hasKey then "(kept; paste a new one to replace it)" else "hc_… from `heymorgan access add <device>` on the server"),
    input("home.device", "This device's name", place.device, "laptop"),
    ui.row({ gap = 8 }, {
      ui.button({ text = "Use this server", glyph = "plug-connected", variant = "secondary", controlSize = "sm", onClick = function()
        change("client.set", { server = draft("home.server", place.server), key = draft("home.key", ""), device = draft("home.device", place.device) },
          `Saved. {who()} is starting again as a client of that server…`)
      end }),
      ui.button({ text = "Run wholly on this laptop", glyph = "device-laptop", variant = "ghost", controlSize = "sm", visible = place.role == "client", onClick = function()
        change("client.set", { server = "" }, `Saved. {who()} is starting again on this laptop…`)
      end }),
    }),
  }))

  local chat = {}
  for _, model in ipairs(models.chat or {}) do
    table.insert(chat, choice(`m:{model.name}`, `{model.name}  {model.gb} GB`, model.name == (config.ollama or {}).model, function()
      set({ ["ollama.model"] = model.name })
    end))
  end
  local embedding = {}
  for _, model in ipairs(models.embedding or {}) do
    local name = model.name:gsub(":latest$", "")
    table.insert(embedding, choice(`e:{model.name}`, name, name == config.embedModel, function()
      set({ embedModel = name })
    end))
  end
  table.insert(out, card("Ollama: the model that does the talking", {
    field("ollama.url", "Server", (config.ollama or {}).url, "http://host:11434", function(text)
      set({ ["ollama.url"] = text })
    end),
    if models.ok == false then hint(`Could not reach the server: {models.error}`) else hint("Model:"),
    rows(chat, 3),
    hint("Embedding model, for finding earlier conversations. Changing it re-reads the whole transcript."),
    rows(embedding, 3),
  }))

  local plans = {}
  for _, model in ipairs({ "haiku", "sonnet", "opus" }) do
    table.insert(plans, choice(`o:{model}`, model, model == config.oracleModel, function()
      set({ ["oracle.model"] = model })
    end))
  end
  table.insert(out, card("The Oracle: Claude, for what the local model cannot do", {
    ui.row({ gap = 8, align = "center" }, {
      ui.label({
        text = if account.loggedIn then `Signed in as {account.email or "someone"} ({account.plan or "plan unknown"})` else "Not signed in",
        color = "on_surface", fontSize = 12, flexGrow = 1,
      }),
      ui.button({ text = if account.loggedIn then "Switch account" else "Sign in", variant = "secondary", controlSize = "sm", onClick = function()
        noctalia.runInTerminal(`{heymorgan} login; echo; echo 'You can close this window.'; read _`)
      end }),
    }),
    hint("Signing in opens a terminal and your browser. This login is the Oracle's own, apart from any other Claude login here."),
    ui.row({ gap = 6, align = "center" }, { hint("Model:"), ui.row({ gap = 6 }, plans) }),
  }))

  for _, server in ipairs(servers) do
    local open = view.server == server.name
    local body = {
      ui.row({ gap = 8, align = "center" }, {
        ui.glyph({ name = if server.connected then "circle-check" else "alert-triangle", size = 16, color = if server.connected then accent else "error" }),
        ui.column({ gap = 0, flexGrow = 1 }, {
          ui.label({ text = server.name, color = "on_surface", fontSize = 12, fontWeight = "bold" }),
          hint(`{server.target}{if server.hasKey then "  ·  access key saved" else ""}`),
        }),
        ui.button({ text = if open then "Hide tools" else `Tools ({#server.tools})`, variant = "secondary", controlSize = "sm", onClick = function()
          view.server = if open then nil else server.name
          render()
        end }),
        ui.button({ glyph = "refresh", variant = "ghost", controlSize = "sm", tooltip = "Connect again and re-read its tools", onClick = function()
          status = `Connecting to {server.name}…`
          render()
          change("mcp.reconnect", {}, "Connected again.")
        end }),
        remove(`unserver:{server.name}`, "Remove this server", function()
          change("mcp.remove", { name = server.name }, "Server removed.")
        end),
      }),
    }
    if not server.connected then
      table.insert(body, hint(`Not connected: {server.error or "no answer"}`))
    end
    if open then
      table.insert(body, switch(`all:{server.name}`, `Give {who()} every tool unless switched off below`, server.allow == "all", function(on)
        change("mcp.allow", { name = server.name, allow = if on then "all" else "read" })
      end))
      table.insert(body, hint("A tool that changes something always waits for your yes before it runs."))
      for _, tool in ipairs(server.tools) do
        table.insert(body, ui.row({ key = `tool:{server.name}:{tool.name}`, gap = 10, align = "center" }, {
          ui.toggle({ key = `tg:{server.name}:{tool.name}`, checked = tool.on, onChange = function(now)
            change("mcp.tool", { name = server.name, tool = tool.name, on = now == "true" })
          end }),
          ui.label({ text = tool.name, color = "on_surface", fontSize = 12, flexGrow = 1 }),
          ui.label({ text = if tool.readOnly then "reads" else "changes things", color = if tool.readOnly then "on_surface_variant" else "tertiary", fontSize = 11 }),
        }))
      end
    end
    table.insert(out, card(nil, body))
  end

  table.insert(out, card("Add an MCP server", {
    ui.row({ gap = 8, align = "center" }, {
      ui.input({ key = `mcpname#{version}`, placeholder = "Short name", width = 160, controlSize = "sm", onChange = function(text)
        drafts.mcpName = text
      end }),
      ui.input({ key = `mcpurl#{version}`, placeholder = "URL, or a command to run", flexGrow = 1, controlSize = "sm", onChange = function(text)
        drafts.mcpTarget = text
      end }),
    }),
    ui.row({ gap = 8, align = "center" }, {
      ui.input({ key = `mcpkey#{version}`, placeholder = "Access key, if it needs one", password = true, flexGrow = 1, controlSize = "sm", onChange = function(text)
        drafts.mcpKey = text
      end }),
      ui.button({ text = "Add", variant = "primary", controlSize = "sm", onClick = function()
        local target = drafts.mcpTarget or ""
        local args = { name = drafts.mcpName or "" }
        if target:match("^https?://") then
          args.url = target
          args.key = drafts.mcpKey
        else
          args.command = target
        end
        status = "Connecting…"
        render()
        change("mcp.add", args, "Server added.")
      end }),
    }),
    hint("Servers that need a browser sign-in cannot be added here; those are reached through the Oracle."),
  }))
  return out
end

-- ---------------------------------------------------------------- the window

render = function()
  local tabs = {}
  for _, entry in ipairs(TABS) do
    table.insert(tabs, ui.button({
      key = `tab:{entry.id}`, text = entry.label, glyph = entry.glyph, variant = if entry.id == tab then "primary" else "ghost", selected = entry.id == tab,
      onClick = function()
        tab = entry.id
        view = {}
        confirming = nil
        status = ""
        render()
        refresh()
      end,
    }))
  end

  local body
  local ready = true
  for _, op in ipairs(NEEDS[tab]) do
    if D[op] == nil then
      ready = false
    end
  end
  if not ready then
    body = { hint(`Asking {who()}…`) }
  elseif tab == "memory" then
    body = memoryTab()
  elseif tab == "voice" then
    body = voiceTab()
  elseif tab == "listening" then
    body = listeningTab()
  elseif tab == "files" then
    body = filesTab()
  elseif tab == "log" then
    body = logTab()
  else
    body = connectionsTab()
  end

  panel.render(ui.column({ padding = 10, gap = 10, height = INSIDE, fill = FRAME, radius = 14 }, {
    ui.column({ fill = "surface", radius = 12 }, { ui.row({ gap = 10, align = "center", fill = tint(accent, 0.14), radius = 12, paddingH = 12, paddingV = 6 }, {
      ui.glyph({ name = "settings", size = 20, color = accent }),
      ui.label({ text = `{who()} settings`, color = "on_surface", fontSize = 13, fontWeight = "bold" }),
      ui.label({ text = status, color = accent, fontSize = 12, maxLines = 1, maxWidth = 460 }),
      ui.spacer({ flexGrow = 1 }),
      ui.button({ glyph = "message-circle", variant = "ghost", controlSize = "sm", tooltip = "Back to the chat window", onClick = function()
        noctalia.runAsync({ noctalia.expandPath("~/.local/bin/noctalia"), "msg", "panel-open", "jpmoo/morgan:chat" })
      end }),
      ui.button({ glyph = "x", variant = "ghost", controlSize = "sm", tooltip = "Close", onClick = function()
        panel.close()
      end }),
    }) }),
    ui.row({ gap = 6, align = "center", fill = "surface", radius = 12, padding = 4 }, tabs),
    ui.scroll({ gap = 10, padding = 4, flexGrow = 1 }, body),
  }))
end

-- A restarted daemon takes a few seconds to answer again.
panel.setWantsSecondTicks(true)
function update()
  if settle > 0 then
    settle -= 1
    if settle == 0 then
      status = `{who()} is back.`
      refresh()
    end
  end
end

noctalia.state.watch("enroll", function(value)
  if tab == "voice" then
    if type(value) == "table" and not value.active then
      refresh()
    else
      render()
    end
  end
end)

-- For driving the window from a script: noctalia msg plugin jpmoo/morgan:settings all tab voice
function onIpc(event, payload)
  if event == "tab" and NEEDS[payload] then
    tab = payload
    view = {}
    render()
    refresh()
  elseif event == "show" then
    -- payload "server=HermesNotes", "editing=1", and so on
    local key, value = tostring(payload):match("^(%w+)=(.*)$")
    if key then
      view[key] = tonumber(value) or value
      render()
    end
  end
end

function onClose()
  noctalia.state.set("settings_open", false)
end

function onOpen()
  noctalia.state.set("settings_open", true)
  status = ""
  confirming = nil
  render()
  refresh()
end

render()
