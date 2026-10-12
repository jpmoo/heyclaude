--!nonstrict
-- The pop-up: who has the floor, a waveform of their voice, and the words.

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

local LOOK = {
  listening = { glyph = "microphone", title = "Listening", color = role("secondary") },
  transcribing = { glyph = "ear", title = "Listening", color = role("secondary") },
  thinking = { glyph = "brain", title = "Thinking", color = role("primary") },
  consulting = { glyph = "eye", title = "Consulting the Oracle", color = role("tertiary") },
  speaking = { glyph = "volume", title = "Morgan", color = role("primary") },
  idle = { glyph = "microphone", title = "Morgan", color = accent or "on_surface_variant" },
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

  panel.render(ui.column({ padding = 12, gap = 8 }, {
    ui.row({ gap = 8, align = "center", fill = tint(look.color, 0.16), radius = 10, paddingH = 10, paddingV = 4 }, {
      ui.glyph({ name = look.glyph, size = 18, color = look.color }),
      ui.label({ text = look.title, color = look.color, fontSize = 12, fontWeight = "bold" }),
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
    ui.row({ gap = 3, align = "center", justify = "center", minHeight = MAX, fill = "surface_variant/0.3", radius = 10 }, bars),
    ui.column({ fill = "surface_variant/0.6", radius = 10, paddingH = 10, paddingV = 6, minHeight = 44 }, {
      ui.label({
        text = noctalia.state.get("caption") or "",
        color = "on_surface",
        fontSize = 12,
        maxLines = 2,
        maxWidth = 372,
      }),
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
