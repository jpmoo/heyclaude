--!nonstrict
-- Bar widget: shows what Morgan is doing. Click to start or stop listening.

local heymorgan = noctalia.expandPath("~/.local/bin/heymorgan")

local GLYPH = {
  listening = "microphone",
  transcribing = "microphone",
  thinking = "brain",
  consulting = "eye",
  speaking = "volume",
}

local function render()
  local state = noctalia.state.get("state") or "idle"
  barWidget.render(ui.row({ align = "center", justify = "center", paddingH = 6 }, {
    ui.glyph({
      name = GLYPH[state] or "microphone",
      size = 16,
      color = if state == "idle" then "on_surface_variant" else "primary",
    }),
  }))
end

function onClick()
  noctalia.runAsync({ heymorgan, "toggle" })
end

noctalia.state.watch("state", render)

render()
