import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

// The sixteen terminal colours of the active Omarchy theme.
//
// The plugin defines no colours of its own. Agent output arrives carrying SGR
// indices, and an index means whatever the person's terminal says it means, so
// the palette is read from the theme rather than invented here. Omarchy writes
// one file per terminal into the current theme; ghostty's is the easiest to
// read back, being one `palette = N=#rrggbb` per line.
//
// The file is watched, so switching theme recolours a pane that is already on
// screen without reopening anything.
QtObject {
  id: root

  readonly property string themePath: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme"

  // Sensible until the file is read: the theme's own foreground and background
  // for the two ends, and nothing invented in between.
  property var colors: []
  property color terminalForeground: Color.foreground
  property color terminalBackground: Color.popups.background

  // An SGR index the theme has no colour for. Indices 0-15 come from the
  // palette; 16-255 are the xterm cube and greyscale ramp, which every terminal
  // computes the same way, so they are computed rather than configured.
  function indexed(index) {
    if (index < 0) return root.terminalForeground
    if (index < 16) {
      return index < root.colors.length ? root.colors[index] : root.terminalForeground
    }
    if (index < 232) {
      var value = index - 16
      var steps = [0, 95, 135, 175, 215, 255]
      return Qt.rgba(steps[Math.floor(value / 36) % 6] / 255,
                     steps[Math.floor(value / 6) % 6] / 255,
                     steps[value % 6] / 255, 1)
    }
    var grey = (8 + (index - 232) * 10) / 255
    return Qt.rgba(grey, grey, grey, 1)
  }

  property FileView source: FileView {
    path: root.themePath + "/ghostty.conf"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.parse(text())
    onLoadFailed: root.colors = []
  }

  function parse(text) {
    var parsed = []
    var foreground = root.terminalForeground
    var background = root.terminalBackground
    var lines = String(text || "").split("\n")

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      var palette = line.match(/^palette\s*=\s*(\d+)\s*=\s*(#[0-9a-fA-F]{6})$/)
      if (palette) {
        parsed[parseInt(palette[1], 10)] = palette[2]
        continue
      }
      var pair = line.match(/^(foreground|background)\s*=\s*(#[0-9a-fA-F]{6})$/)
      if (!pair) continue
      if (pair[1] === "foreground") foreground = pair[2]
      else background = pair[2]
    }

    root.colors = parsed
    root.terminalForeground = foreground
    root.terminalBackground = background
  }
}
