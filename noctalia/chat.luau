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

local WIDTH = 640 - 2 * 16 -- the panel's width, less its padding
local draft = 0 -- bumped to hand the input a new key, which empties it
local opened = 0 -- bumped on each open, to start at the newest message
local render -- defined below; the buttons need to call it

local selecting = nil -- index of the message opened up for selecting text in
local copied = nil -- index of the message just copied, for a moment's tick

-- Rendered text cannot be selected, so a message can be copied whole, or
-- opened as plain text in a field where any part of it can be selected.
local function tools(index: number, text: string)
  return {
    ui.spacer({ flexGrow = 1 }),
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
  }
end

-- Choosing a file opens a window of its own, which takes the chat window's
-- place on screen; the chat window is brought back once a choice is made.
local function attach()
  noctalia.runAsync({ "zenity", "--file-selection", "--multiple", "--separator=\n", "--title=Attach to your message" }, function(result)
    local files = noctalia.state.get("attachments") or {}
    for path in (result.stdout or ""):gmatch("[^\n]+") do
      table.insert(files, path)
    end
    noctalia.state.set("attachments", files)
    noctalia.runAsync({ shell, "msg", "panel-open", "jpmoo/morgan:chat" })
  end)
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
        fill = if mine then tint(role("primary"), 0.22) elseif oracle then "tertiary/0.18" else "surface_variant/0.75",
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
          table.unpack(tools(index, line.text)),
        }),
        -- What you typed is shown as typed; answers are markdown.
        if selecting == index
          then ui.input({ key = `s{index}`, value = line.text, multiline = true, frameVisible = false, fontSize = 13, height = fieldHeight(line.text) })
          elseif mine then ui.label({ text = line.text, color = "on_surface", fontSize = 13, maxWidth = WIDTH - 66 })
          else ui.markdown({ text = line.text, width = WIDTH - 66 }),
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
    table.insert(lines, ui.column({ key = "partial", gap = 2, padding = 10, radius = 10, fill = "surface_variant/0.75", border = tint(role("primary"), 0.5), borderWidth = 1 }, {
      ui.label({ text = `{who()}`, color = role("secondary"), fontSize = 10, fontWeight = "bold" }),
      ui.markdown({ text = partial, width = WIDTH - 66 }),
    }))
  end

  local header = ui.row({ gap = 10, align = "center", fill = tint(look.color, 0.14), radius = 12, paddingH = 12, paddingV = 6 }, {
    ui.glyph({ name = look.glyph, size = 20, color = look.color }),
    ui.label({ text = if look.title == "" then who() else look.title, color = "on_surface", fontSize = 13, fontWeight = "bold" }),
    ui.row({ gap = 2, align = "center", minHeight = 24 }, bars),
    ui.spacer({ flexGrow = 1 }),
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

  local composer = ui.row({ gap = 8, align = "center", fill = "surface_variant/0.55", radius = 14, padding = 6 }, {
    ui.button({ glyph = "paperclip", variant = "ghost", tooltip = "Attach files", onClick = attach }),
    ui.input({
      key = `draft{draft}`,
      placeholder = `Type to {who()}, or press the microphone and speak`,
      focus = true,
      flexGrow = 1,
      frameVisible = false,
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
    header,
    ui.scroll({
      gap = 8, padding = 10, flexGrow = 1, radius = 12, fill = "surface_variant/0.22",
      stickToBottom = true, scrollToBottomRev = opened,
    }, lines),
  }
  if #chips > 0 then
    table.insert(body, ui.row({ gap = 6, align = "center" }, chips))
  end
  table.insert(body, composer)
  panel.render(ui.column({ padding = 16, gap = 10, height = 720 }, body))
end

noctalia.state.watch("state", render)
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
