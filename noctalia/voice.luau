--!nonstrict
-- The pop-up: who has the floor, a waveform of their voice, and the words.

-- One accent of the user's choosing in place of the theme's colours, which in
-- a monochrome theme are all grey. A theme role takes its transparency as
-- "role/0.2"; a colour written out takes it as two more hex digits.
local custom = noctalia.getConfig("accent_source") ~= "theme"
local accent = if custom then (noctalia.getConfig("accent") or "#6f9bb3") else nil

-- The window's frame: see-through, but dimmed enough that what is behind it
-- does not compete with what is in it. The areas holding text are solid.
local FRAME = "surface/0.6"

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
  speaking = { glyph = "volume", title = "", color = role("primary") },
  idle = { glyph = "microphone", title = "", color = accent or "on_surface_variant" },
}

local MAX = 44 -- tallest bar, px
local PANEL = 356 -- the popup's height, as plugin.toml declares it

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

local shell = noctalia.expandPath("~/.local/bin/noctalia")

local function render()
  local look = LOOK[noctalia.state.get("state") or "idle"] or LOOK.idle
  local asked = noctalia.state.get("asked") or ""
  local answer = noctalia.state.get("answer") or ""
  local caption = noctalia.state.get("caption") or ""
  local words = {}
  if asked ~= "" then
    local when = noctalia.state.get("asked_when") or ""
    if when ~= "" then
      table.insert(words, ui.label({ key = "when", text = when, color = "on_surface_variant", fontSize = 9 }))
    end
    table.insert(words, ui.label({ key = "asked", text = asked, color = "on_surface_variant", fontSize = 11, maxWidth = 372 }))
  end
  if answer ~= "" then
    table.insert(words, ui.label({ key = "answer", text = answer, color = "on_surface", fontSize = 12, maxWidth = 372 }))
  end
  if caption ~= "" then
    table.insert(words, ui.label({ key = "caption", text = caption, color = look.color, fontSize = 11, maxWidth = 372 }))
  end

  local working = WORKING[noctalia.state.get("state") or "idle"] == true
  local bars = {}
  for i, level in ipairs(if working then {} else (noctalia.state.get("levels") or {})) do
    table.insert(bars, ui.box({
      key = tostring(i),
      width = 4,
      height = 4 + math.floor(math.sqrt(level) * (MAX - 4)),
      radius = 2,
      fill = look.color,
    }))
  end

  panel.render(ui.column({ padding = 8, gap = 8, fill = FRAME, radius = 12, height = PANEL - 2 * 16 }, {
    ui.column({ fill = "surface", radius = 10 }, { ui.row({ gap = 8, align = "center", fill = tint(look.color, 0.16), radius = 10, paddingH = 10, paddingV = 4 }, {
      ui.glyph({ name = look.glyph, size = 18, color = look.color }),
      ui.label({ text = if look.title == "" then who() else look.title, color = look.color, fontSize = 12, fontWeight = "bold" }),
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
    }) }),
    ui.row({ gap = 3, align = "center", justify = "center", minHeight = MAX, fill = "surface", radius = 10 }, if working then scanner(26, 9, 7, look.color) else bars),
    -- The turn so far, to read along with or scroll back through: the wheel
    -- works here although the popup never takes the keyboard.
    ui.scroll({ fill = "surface_variant", radius = 10, padding = 10, gap = 6, flexGrow = 1, stickToBottom = true }, words),
  }))
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
  if sinceDraw >= 40 then
    sinceDraw = 0
    render()
  end
end

noctalia.state.watch("state", animate)

noctalia.state.watch("name", render)
noctalia.state.watch("levels", render)
noctalia.state.watch("caption", render)
noctalia.state.watch("asked", render)
noctalia.state.watch("answer", render)

function onOpen()
  animate()
  render()
end

render()
