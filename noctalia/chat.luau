--!nonstrict
-- The chat window: the conversation so far, a box to type in, and a button to
-- speak instead. Typed turns are answered in text; spoken ones aloud as well.

local heyclaude = noctalia.expandPath("~/.local/bin/heyclaude")

local LOOK = {
  listening = { glyph = "microphone", title = "Listening", color = "secondary" },
  transcribing = { glyph = "ear", title = "Listening", color = "secondary" },
  thinking = { glyph = "brain", title = "Thinking", color = "primary" },
  consulting = { glyph = "eye", title = "Consulting the Oracle", color = "tertiary" },
  speaking = { glyph = "volume", title = "Speaking", color = "primary" },
  idle = { glyph = "message-circle", title = "Morgan", color = "on_surface_variant" },
}

local WIDTH = 640 - 2 * 16 -- the panel's width, less its padding
local SCROLL = 720 - 2 * 16 - 2 * 12 - 32 - 38 -- the panel, less padding, gaps, header and input row
local draft = 0 -- bumped to hand the input a new key, which empties it
local opened = 0 -- bumped on each open, to start at the newest message

local function send(text: string)
  text = text:gsub("^%s+", ""):gsub("%s+$", "")
  if text == "" then
    return
  end
  if text == "/new" or text == "/interview" or text == "/stop" then
    noctalia.runAsync({ heyclaude, text:sub(2) })
  else
    noctalia.runAsync({ heyclaude, "type", text })
  end
  draft += 1
end

local function render()
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
    if line.who == "note" then
      table.insert(lines, ui.label({
        key = `n{index}`,
        text = line.text,
        color = "on_surface_variant",
        fontSize = 11,
        maxWidth = WIDTH - 24,
      }))
    else
      local mine = line.who == "you"
      local oracle = line.who == "oracle"
      table.insert(lines, ui.column({
        key = `m{index}`,
        gap = 2,
        padding = 10,
        radius = 10,
        fill = if mine then "primary/0.14" elseif oracle then "tertiary/0.10" else "surface_variant/0.5",
      }, {
        ui.label({
          text = if mine then "You" elseif oracle then "The Oracle, to Morgan" else "Morgan",
          color = if mine then "primary" elseif oracle then "tertiary" else "on_surface_variant",
          fontSize = 10,
        }),
        -- What you typed is shown as typed; answers are markdown.
        if mine
          then ui.label({ text = line.text, color = "on_surface", fontSize = 13, maxWidth = WIDTH - 44 })
          else ui.markdown({ text = line.text, width = WIDTH - 44 }),
      }))
    end
  end

  panel.render(ui.column({ padding = 16, gap = 12, height = 720 }, {
    ui.row({ gap = 10, align = "center" }, {
      ui.glyph({ name = look.glyph, size = 20, color = look.color }),
      ui.label({ text = look.title, color = "on_surface", fontSize = 13 }),
      ui.row({ gap = 2, align = "center", minHeight = 24 }, bars),
      ui.spacer({ flexGrow = 1 }),
      ui.button({
        glyph = "plus",
        variant = "ghost",
        controlSize = "sm",
        tooltip = "Start a new conversation",
        onClick = function()
          noctalia.runAsync({ heyclaude, "new" })
        end,
      }),
    }),
    -- An explicit height: left to grow, the list pushes the input off the panel.
    ui.scroll({ gap = 8, height = SCROLL, flexGrow = 1, stickToBottom = true, scrollToBottomRev = opened }, lines),
    ui.row({ gap = 8, align = "center" }, {
      ui.input({
        key = `draft{draft}`,
        placeholder = "Type to Morgan, or press the microphone and speak",
        focus = true,
        flexGrow = 1,
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
    }),
  }))
end

noctalia.state.watch("state", render)
noctalia.state.watch("levels", function()
  if (noctalia.state.get("state") or "idle") ~= "idle" then
    render()
  end
end)
noctalia.state.watch("log", render)

function onOpen()
  noctalia.state.set("chat_open", true)
  draft += 1
  opened += 1
  render()
end

function onClose()
  noctalia.state.set("chat_open", false)
end

render()
