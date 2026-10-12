--!nonstrict
-- The pop-up: who has the floor, a waveform of their voice, and the words.

local LOOK = {
  listening = { glyph = "microphone", title = "Listening", color = "secondary" },
  transcribing = { glyph = "ear", title = "Listening", color = "secondary" },
  thinking = { glyph = "brain", title = "Thinking", color = "primary" },
  consulting = { glyph = "eye", title = "Consulting the Oracle", color = "tertiary" },
  speaking = { glyph = "volume", title = "Morgan", color = "primary" },
  idle = { glyph = "microphone", title = "Morgan", color = "on_surface_variant" },
}

local MAX = 44 -- tallest bar, px
local shell = noctalia.expandPath("~/.local/bin/noctalia")

local function render()
  local look = LOOK[noctalia.state.get("state") or "idle"] or LOOK.idle
  local bars = {}
  for i, level in ipairs(noctalia.state.get("levels") or {}) do
    table.insert(bars, ui.box({
      key = tostring(i),
      width = 4,
      height = 4 + math.floor(math.sqrt(level) * (MAX - 4)),
      radius = 2,
      fill = look.color,
    }))
  end

  panel.render(ui.column({ padding = 14, gap = 8 }, {
    ui.row({ gap = 8, align = "center" }, {
      ui.glyph({ name = look.glyph, size = 18, color = look.color }),
      ui.label({ text = look.title, color = "on_surface_variant", fontSize = 11 }),
      ui.spacer({ flexGrow = 1 }),
      ui.button({
        glyph = "keyboard",
        variant = "ghost",
        controlSize = "sm",
        tooltip = "Open the chat window to type or read back",
        onClick = function()
          noctalia.runAsync({ shell, "msg", "panel-open", "jpmoo/morgan:chat" })
        end,
      }),
    }),
    ui.row({ gap = 3, align = "center", justify = "center", minHeight = MAX }, bars),
    ui.label({
      text = noctalia.state.get("caption") or "",
      color = "on_surface",
      fontSize = 12,
      maxLines = 2,
      maxWidth = 392,
    }),
  }))
end

noctalia.state.watch("state", render)
noctalia.state.watch("levels", render)
noctalia.state.watch("caption", render)

function onOpen()
  render()
end

render()
