--!nonstrict
-- The chat window: the conversation so far, a box to type in, and a button to
-- speak instead. Typed turns are answered in text; spoken ones aloud as well.

local heyclaude = noctalia.expandPath("~/.local/bin/heyclaude")
local shell = noctalia.expandPath("~/.local/bin/noctalia")

-- One accent of the user's choosing in place of the theme's colours, which in
-- a monochrome theme are all grey. A theme role takes its transparency as
-- "role/0.2"; a colour written out takes it as two more hex digits.
local custom = noctalia.getConfig("accent_source") ~= "theme"
local accent = if custom then (noctalia.getConfig("accent") or "#6f9bb3") else nil

-- The window's frame: see-through, but dimmed enough that what is behind it
-- does not compete with what is in it. The areas holding text are solid.
local FRAME = "surface/0.6"
-- The shell keeps a 16 px margin inside a panel, so what is drawn has that
-- much less height than the panel was declared with. Drawn taller, the
-- backing hangs out below the window.
local INSIDE = 720 - 2 * 16

local function tint(color: string, alpha: number): string
  if color:sub(1, 1) == "#" then
    return color:sub(1, 7) .. string.format("%02x", math.floor(alpha * 255 + 0.5))
  end
  return `{color}/{alpha}`
end

-- The theme role, or the accent standing in for it.
local function role(name: string): string
  return accent or name
end

-- The assistant's name is a setting, and comes from the daemon.
local function who(): string
  return noctalia.state.get("name") or "Morgan"
end

local LOOK = {
  listening = { glyph = "microphone", title = "Listening", color = role("secondary") },
  transcribing = { glyph = "ear", title = "Listening", color = role("secondary") },
  thinking = { glyph = "brain", title = "Thinking", color = role("primary") },
  consulting = { glyph = "eye", title = "Consulting the Oracle", color = role("tertiary") },
  speaking = { glyph = "volume", title = "Speaking", color = role("primary") },
  idle = { glyph = "message-circle", title = "", color = accent or "on_surface_variant" },
}

local WIDTH = 640 - 2 * 16 - 2 * 10 -- the panel's width, less the shell's margin and our own
local draft = 0 -- bumped to hand the input a new key, which empties it

-- While Morgan is working something out there is no voice to draw, so the
-- bars run as a slow wave instead and the title counts its dots.
local WORKING = { thinking = true, consulting = true, transcribing = true }
local phase = 0
local sinceDraw = 0

-- Thinking is shown as a light sweeping back and forth along a bar, as on a
-- Cylon's visor: a moving waveform reads as sound, and there is none while it
-- thinks.
local function scanner(count: number, width: number, height: number, color: string)
  -- Where the light is, going out and coming back.
  local travel = (phase * 1.15) % 2
  local at = 1 + (count - 1) * (if travel < 1 then travel else 2 - travel)
  local cells = {}
  for i = 1, count do
    local near = math.max(0, 1 - math.abs(i - at) / 3.2)
    table.insert(cells, ui.box({ key = `scan{i}`, width = width, height = height, radius = height / 2, fill = color, opacity = 0.10 + 0.90 * near * near }))
  end
  return cells
end

local opened = 0 -- bumped on each open, to start at the newest message
local render -- defined below; the buttons need to call it

local unfolded = {} -- by message: whether what the Oracle said is showing
local selecting = nil -- index of the message opened up for selecting text in
local copied = nil -- index of the message just copied, for a moment's tick

-- Rendered text cannot be selected, so a message can be copied whole, or
-- opened as plain text in a field where any part of it can be selected.
local function tools(index: number, text: string, line)
  local marks = {}
  if line and line.t then
    -- Thumbs down keeps the answer on the record but out of Morgan's sight for
    -- good; thumbs up marks one to prefer. Pressing the lit one clears it.
    table.insert(marks, ui.button({
      glyph = "thumb-up", variant = if line.good then "primary" else "ghost", controlSize = "sm",
      tooltip = if line.good then "Marked as a good answer. Click to clear." else "A good answer: prefer it when recalling",
      onClick = function()
        noctalia.runAsync({ heyclaude, "rate", tostring(line.t), if line.good then "none" else "up" })
      end,
    }))
    table.insert(marks, ui.button({
      glyph = "thumb-down", variant = if line.hidden then "destructive" else "ghost", controlSize = "sm",
      tooltip = if line.hidden then "Hidden from Morgan. Click to bring it back." else "A wrong answer: hide it from Morgan from now on",
      onClick = function()
        noctalia.runAsync({ heyclaude, "rate", tostring(line.t), if line.hidden then "none" else "down" })
      end,
    }))
  end
  local out = { ui.spacer({ flexGrow = 1 }) }
  for _, mark in ipairs(marks) do
    table.insert(out, mark)
  end
  for _, button in ipairs({
    ui.button({
      glyph = if selecting == index then "x" else "cursor-text",
      variant = "ghost",
      controlSize = "sm",
      tooltip = if selecting == index then "Back to the formatted message" else "Select part of this message",
      onClick = function()
        selecting = if selecting == index then nil else index
        render()
      end,
    }),
    ui.button({
      glyph = if copied == index then "check" else "copy",
      variant = "ghost",
      controlSize = "sm",
      tooltip = "Copy this message",
      onClick = function()
        noctalia.copyToClipboard(text, "text/plain")
        copied = index
        render()
      end,
    }),
    }) do
    table.insert(out, button)
  end
  return out
end

-- Attaching is done by the service, which is always running. The file
-- chooser is a window of its own: opened from here it came up behind this
-- one, and this one was then dismissed with whatever had been typed. So the
-- service closes this window first, shows the chooser, and reopens it; and
-- what has been typed is kept (see "draft" below) and put back.
local function attach()
  noctalia.state.set("attach_request", { from = "chooser", at = noctalia.nowMs() })
end

-- A file copied in the file manager (Ctrl+C on it) can be attached without the chooser.
local function attachCopied()
  noctalia.state.set("attach_request", { from = "clipboard", at = noctalia.nowMs() })
end

-- The notes that may have come from a hidden answer, each with its verdict buttons.
local function reviewRows(line)
  local rows = { ui.label({ text = "These notes in memory may have come from this answer. Keep or delete each:", color = "on_surface", fontSize = 11, fontWeight = "bold", maxWidth = WIDTH - 110 }) }
  for index, entry in ipairs(line.review or {}) do
    local function settle(action: string)
      noctalia.runAsync({ heyclaude, "settle", noctalia.json.encode({ t = line.t, topic = entry.topic, note = entry.note, action = action }) })
    end
    table.insert(rows, ui.row({ key = `rv{line.t}:{index}`, gap = 6, align = "center" }, {
      ui.column({ gap = 0, flexGrow = 1 }, {
        ui.label({ text = entry.note, color = "on_surface", fontSize = 12, maxWidth = WIDTH - 230 }),
        ui.label({ text = entry.topic, color = "on_surface_variant", fontSize = 10 }),
      }),
      ui.button({ text = "Keep", variant = "secondary", controlSize = "sm", onClick = function()
        settle("keep")
      end }),
      ui.button({ text = "Delete", variant = "destructive", controlSize = "sm", onClick = function()
        settle("delete")
      end }),
    }))
  end
  return rows
end

-- Tall enough for the text at about seventy characters to the line.
local function fieldHeight(text: string): number
  local rows = 0
  for line in (text .. "\n"):gmatch("(.-)\n") do
    rows += math.max(1, math.ceil(#line / 70))
  end
  return math.min(360, rows * 20 + 20)
end

local function send(text: string)
  text = text:gsub("^%s+", ""):gsub("%s+$", "")
  local files = noctalia.state.get("attachments") or {}
  if text == "" and #files == 0 then
    return
  end
  if text == "/new" or text == "/interview" or text == "/stop" then
    noctalia.runAsync({ heyclaude, text:sub(2) })
  elseif #files > 0 then
    noctalia.runAsync({ heyclaude, "ask", noctalia.json.encode({ text = text, files = files }) })
    noctalia.state.set("attachments", {})
  else
    noctalia.runAsync({ heyclaude, "type", text })
  end
  noctalia.state.set("draft", "")
  draft += 1
end

render = function()
  local state = noctalia.state.get("state") or "idle"
  local look = LOOK[state] or LOOK.idle

  local bars = {}
  if state ~= "idle" then
    local levels = noctalia.state.get("levels") or {}
    for i = math.max(1, #levels - 27), #levels do
      table.insert(bars, ui.box({
        key = tostring(i),
        width = 3,
        height = 3 + math.floor(math.sqrt(levels[i]) * 21),
        radius = 1,
        fill = look.color,
      }))
    end
  end

  local lines = {}
  for index, line in ipairs(noctalia.state.get("log") or {}) do
    if line.who == "act" or line.who == "note" then
      -- A step taken on the way to an answer: an icon, what it was, and with what.
      table.insert(lines, ui.row({
        key = `n{index}`, gap = 10, align = "center", radius = 10, paddingH = 8, paddingV = 5,
        fill = tint(role("secondary"), 0.10), border = tint(role("secondary"), 0.28), borderWidth = 1,
      }, {
        ui.row({ align = "center", justify = "center", width = 26, height = 26, radius = 7, fill = tint(role("secondary"), 0.22) }, {
          ui.glyph({ name = line.glyph or "tool", size = 15, color = role("secondary") }),
        }),
        ui.column({ gap = 0, flexGrow = 1 }, {
          ui.label({ text = line.text, color = "on_surface", fontSize = 12, fontWeight = "bold", maxLines = 1, maxWidth = WIDTH - 110 }),
          ui.label({ text = line.detail or "", color = "on_surface_variant", fontSize = 11, maxLines = 2, maxWidth = WIDTH - 110, visible = (line.detail or "") ~= "" }),
        }),
      }))
    else
      local mine = line.who == "you"
      local oracle = line.who == "oracle"
      table.insert(lines, ui.column({
        key = `m{index}`,
        gap = 2,
        padding = 10,
        radius = 10,
        opacity = if line.hidden and not (line.review and #line.review > 0) then 0.4 else 1,
        fill = if mine then tint(role("primary"), 0.22) elseif oracle then "tertiary/0.18" else "surface",
        border = if mine then tint(role("primary"), 0.5) elseif oracle then "tertiary/0.4" else "outline/0.25",
        borderWidth = 1,
      }, {
        ui.row({ gap = 2, align = "center" }, {
          ui.label({
            text = if mine then "You" elseif oracle then `The Oracle, to {who()}` else `{who()}`,
            color = if mine then role("primary") elseif oracle then "tertiary" else role("secondary"),
            fontSize = 10,
            fontWeight = "bold",
          }),
          table.unpack(tools(index, line.text, if mine then nil else line)),
        }),
        -- What you typed is shown as typed; answers are markdown.
        if selecting == index
          then ui.input({ key = `s{index}`, value = line.text, multiline = true, frameVisible = false, fontSize = 13, height = fieldHeight(line.text) })
          elseif mine then ui.label({ text = line.text, color = "on_surface", fontSize = 13, maxWidth = WIDTH - 66 })
          else ui.markdown({ text = line.text, width = WIDTH - 66 }),
        -- Hidden, and some of what is in memory may have come from it: each
        -- such note is put here to be kept or deleted. Nothing goes unasked.
        ui.column({ visible = line.hidden == true and line.review ~= nil and #line.review > 0, gap = 6, padding = 8, radius = 8, fill = "error/0.10", border = "error/0.35", borderWidth = 1 },
          reviewRows(line)),
        -- What the Oracle told Morgan, under the answer it went into: folded
        -- away until it is asked for.
        ui.column({ visible = line.oracle ~= nil, gap = 6 }, {
          ui.row({
            key = `o{index}`, gap = 6, align = "center", radius = 8, paddingH = 8, paddingV = 4, fill = "tertiary/0.14",
            tooltip = if unfolded[index] then "Fold away" else "Show what the Oracle said",
            onClick = function()
              unfolded[index] = not unfolded[index]
              render()
            end,
          }, {
            ui.glyph({ name = if unfolded[index] then "chevron-down" else "chevron-right", size = 14, color = "tertiary" }),
            ui.glyph({ name = "sparkles", size = 14, color = "tertiary" }),
            ui.label({ text = "What the Oracle said", color = "tertiary", fontSize = 11, fontWeight = "bold" }),
          }),
          ui.column({ visible = unfolded[index] == true, padding = 10, radius = 8, fill = "tertiary/0.10", border = "tertiary/0.35", borderWidth = 1 }, {
            ui.markdown({ text = line.oracle or "", width = WIDTH - 96 }),
          }),
        }),
      }))
    end
  end

  local chips = {}
  for index, path in ipairs(noctalia.state.get("attachments") or {}) do
    table.insert(chips, ui.button({
      key = `a{index}`,
      text = `{path:match("[^/]+$")}  ×`,
      variant = "outline",
      controlSize = "sm",
      tooltip = `{path} (click to remove)`,
      onClick = function()
        local files = noctalia.state.get("attachments") or {}
        table.remove(files, index)
        noctalia.state.set("attachments", files)
      end,
    }))
  end

  -- The answer being written, shown as it comes.
  local partial = noctalia.state.get("partial") or ""
  if partial ~= "" then
    table.insert(lines, ui.column({ key = "partial", gap = 2, padding = 10, radius = 10, fill = "surface", border = tint(role("primary"), 0.5), borderWidth = 1 }, {
      ui.label({ text = `{who()}`, color = role("secondary"), fontSize = 10, fontWeight = "bold" }),
      ui.markdown({ text = partial, width = WIDTH - 66 }),
    }))
  end

  local header = ui.row({ gap = 10, align = "center", fill = tint(look.color, 0.14), radius = 12, paddingH = 12, paddingV = 6 }, {
    ui.glyph({ name = look.glyph, size = 20, color = look.color }),
    ui.label({ text = if look.title == "" then who() else look.title, color = "on_surface", fontSize = 13, fontWeight = "bold" }),
    ui.row({ gap = 2, align = "center", minHeight = 24 }, if WORKING[state] then scanner(12, 6, 5, look.color) else bars),
    ui.spacer({ flexGrow = 1 }),
    ui.button({
      glyph = "external-link",
      variant = "ghost",
      controlSize = "sm",
      tooltip = "Open as a window of its own, to tile or keep on a workspace",
      onClick = function()
        noctalia.runAsync({ heyclaude, "window" })
        panel.close()
      end,
    }),
    ui.button({
      glyph = "settings",
      variant = "ghost",
      controlSize = "sm",
      tooltip = "Settings: memory, voice, listening, files, connections",
      onClick = function()
        noctalia.runAsync({ shell, "msg", "panel-open", "jpmoo/morgan:settings" })
      end,
    }),
    ui.button({
      glyph = "plus",
      variant = "ghost",
      controlSize = "sm",
      tooltip = "Start a new conversation",
      onClick = function()
        noctalia.runAsync({ heyclaude, "new" })
      end,
    }),
  })

  local composer = ui.row({ gap = 8, align = "center", fill = "surface_variant", radius = 14, padding = 6 }, {
    ui.button({
      glyph = "paperclip", variant = "ghost", onClick = attach, onRightClick = attachCopied,
      tooltip = "Attach files. Right-click to attach a file you have copied in the file manager.",
    }),
    ui.input({
      key = `draft{draft}`,
      -- What was typed before the window last closed: it is kept until it is sent.
      value = noctalia.state.get("draft") or "",
      placeholder = `Type to {who()}, or press the microphone and speak`,
      focus = true,
      flexGrow = 1,
      frameVisible = false,
      onChange = function(text)
        noctalia.state.set("draft", text)
      end,
      onSubmit = function(text)
        send(text)
        render()
      end,
    }),
    ui.button({
      glyph = if state == "idle" then "microphone" else "player-stop",
      variant = if state == "listening" then "primary" else "secondary",
      tooltip = if state == "idle" then "Speak" elseif state == "listening" then "Send what you've said" else "Stop",
      onClick = function()
        -- Mid-answer, the button cuts Morgan off; otherwise it starts or ends your turn.
        noctalia.runAsync({ heyclaude, if state == "idle" or state == "listening" then "toggle" else "stop" })
      end,
    }),
  })

  -- The list is the only thing here that stretches: anything else that could
  -- (a placeholder spacer, once) takes half the spare height from it.
  local body = {
    -- A solid backing under the tinted header, so its text is not read against whatever is behind the window.
    ui.column({ fill = "surface", radius = 12 }, { header }),
    ui.scroll({
      gap = 8, padding = 10, flexGrow = 1, radius = 12, fill = "surface_variant",
      stickToBottom = true, scrollToBottomRev = opened,
    }, lines),
  }
  if #chips > 0 then
    table.insert(body, ui.row({ gap = 6, align = "center" }, chips))
  end
  table.insert(body, composer)
  panel.render(ui.column({ padding = 10, gap = 10, height = INSIDE, fill = FRAME, radius = 14 }, body))
end

noctalia.state.watch("state", render)

-- Frames are asked for only while there is something to animate.
local function animate()
  panel.setNeedsFrameTick(WORKING[noctalia.state.get("state") or "idle"] == true)
end

function onFrameTick(deltaMs)
  if not WORKING[noctalia.state.get("state") or "idle"] then
    return
  end
  phase += deltaMs / 1000
  sinceDraw += deltaMs
  if sinceDraw >= 60 then
    sinceDraw = 0
    render()
  end
end

noctalia.state.watch("state", animate)

noctalia.state.watch("name", render)
noctalia.state.watch("levels", function()
  if (noctalia.state.get("state") or "idle") ~= "idle" then
    render()
  end
end)
noctalia.state.watch("log", render)
noctalia.state.watch("attachments", render)
noctalia.state.watch("partial", render)

function onOpen()
  noctalia.state.set("chat_open", true)
  animate()
  draft += 1
  opened += 1
  selecting = nil
  copied = nil
  render()
end

function onClose()
  noctalia.state.set("chat_open", false)
end

render()
