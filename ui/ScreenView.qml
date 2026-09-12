import QtQuick
import qs.Commons

// The screen, drawn on the grid it was computed for.
//
// Every run is placed at the column the terminal put it in, and made to occupy
// exactly the cells it owns. Letting the font decide instead is what makes a
// drawn table stop lining up: a monospace face's CJK glyph is not reliably
// twice its latin advance, so a row with wide characters in it comes out a few
// pixels short and every vertical rule below it drifts.
//
// This is the only place in the window where colour appears. Everything else is
// two greys, so that what an agent actually printed is what the eye lands on.
Item {
  id: root

  // Array of { runs: [{ text, style, column, cells }] }, from the sidecar.
  property var rows: []
  // { row, column, visible }
  property var cursor: ({ row: 0, column: 0, visible: false })
  property AnsiPalette palette: null
  property int fontSize: Style.font.bodySmall
  property string fontFamily: "monospace"
  property bool focused: false

  /** A link the pointer is over, or an empty string. */
  property string hoveredLink: ""

  /**
   * Where a drag began and where it has reached, in cells.
   *
   * Held against the viewport rather than against the terminal's buffer, which
   * means a selection drifts if the pane keeps printing under it. That is the
   * honest trade: the panel is shown one screenful at a time and has no buffer
   * of its own to anchor to, and text that is being selected is usually text
   * that has stopped moving.
   */
  property var selectionAnchor: null
  property var selectionHead: null

  readonly property bool hasSelection: selectionAnchor !== null && selectionHead !== null
    && !(selectionAnchor.row === selectionHead.row
         && selectionAnchor.column === selectionHead.column)

  // The selection with its ends the right way round, so everything downstream
  // reads first-to-last and not whichever way the pointer happened to move.
  readonly property var selectionRange: {
    if (!hasSelection) return null
    var a = selectionAnchor
    var b = selectionHead
    var forward = a.row < b.row || (a.row === b.row && a.column <= b.column)
    var first = forward ? a : b
    var last = forward ? b : a
    return {
      firstRow: first.row, firstColumn: first.column,
      lastRow: last.row, lastColumn: last.column
    }
  }

  signal linkActivated(string url)

  function clearSelection() {
    selectionAnchor = null
    selectionHead = null
  }

  // Which cell a point lands on. Rounded rather than floored, so the boundary
  // sits between two characters the way a text caret does: dragging from the
  // left half of a character takes it, and from the right half leaves it.
  function cellAt(point) {
    return {
      row: Math.max(0, Math.min(Math.max(0, rows.length - 1),
                                Math.floor(point.y / Math.max(1, cellHeight)))),
      column: Math.max(0, Math.round(point.x / Math.max(1, cellWidth)))
    }
  }

  /**
   * One row as a cell-by-cell array.
   *
   * A cell, not a character: a Chinese character occupies two of them, so it
   * takes its first cell and leaves the second empty. Selecting by cell is what
   * makes a rectangle drawn on the grid and the text it copies agree.
   */
  function rowCells(index) {
    var out = []
    var row = rows[index]
    if (!row) return out
    for (var i = 0; i < row.runs.length; i++) {
      var run = row.runs[i]
      while (out.length < run.column) out.push(" ")
      var characters = Array.from(run.text)
      for (var c = 0; c < characters.length; c++) out.push(characters[c])
      for (var pad = characters.length; pad < run.cells; pad++) out.push("")
    }
    return out
  }

  /** What is selected, as text. Trailing blanks are dropped, as a terminal's are. */
  function selectedText() {
    var range = selectionRange
    if (!range) return ""
    var parts = []
    for (var r = range.firstRow; r <= range.lastRow; r++) {
      var cells = rowCells(r)
      var from = r === range.firstRow ? range.firstColumn : 0
      var to = r === range.lastRow ? range.lastColumn : cells.length
      parts.push(cells.slice(from, to).join("").replace(/[ \t]+$/, ""))
    }
    return parts.join("\n")
  }

  readonly property real cellWidth: metrics.advanceWidth
  readonly property real cellHeight: Math.ceil(metrics.height)
  readonly property int columnCount: Math.max(20, Math.floor(width / Math.max(1, cellWidth)))
  readonly property int rowCount: Math.max(6, Math.floor(height / Math.max(1, cellHeight)))

  clip: true

  // One measurement for the whole grid. A monospace face advances the same
  // amount for every latin character, and that advance is the column width.
  TextMetrics {
    id: metrics
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    text: "M"
  }

  function colorOf(spec, fallback) {
    if (!spec || !root.palette) return fallback
    if (spec.kind === "rgb") return Qt.rgba(spec.r / 255, spec.g / 255, spec.b / 255, 1)
    if (spec.kind === "indexed") return root.palette.indexed(spec.index)
    return fallback
  }

  Column {
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    spacing: 0

    Repeater {
      // Counted rather than handed the array. A Repeater given a new array
      // throws away every delegate and builds them all again, so a screen on
      // which one row had changed was fifty rows of items destroyed and remade
      // twenty times a second, and the shell that also draws the bar spent half
      // a core on it. Given a count it keeps its rows, and each row watches its
      // own entry in the array: only a row that was actually replaced rebuilds
      // its runs, and the sidecar replaces only the rows that changed.
      model: root.rows.length

      Item {
        id: line
        required property int index
        readonly property var row: root.rows[index]
        width: parent.width
        // A blank row still occupies a line. A terminal's empty lines are part
        // of how its output is laid out, not whitespace to collapse.
        height: root.cellHeight

        Repeater {
          model: line.row ? line.row.runs : []

          Item {
            id: cellRun
            required property var modelData

            x: modelData.column * root.cellWidth
            y: 0
            width: modelData.cells * root.cellWidth
            height: root.cellHeight

            // `inverse` is SGR 7, which swaps the two colours rather than
            // picking a third. Resolving it once here keeps the swap in one
            // place instead of at every use.
            readonly property color foreground: root.colorOf(
              modelData.style.inverse ? modelData.style.bg : modelData.style.fg,
              modelData.style.inverse ? root.palette.terminalBackground
                                      : root.palette.terminalForeground)
            readonly property color background: root.colorOf(
              modelData.style.inverse ? modelData.style.fg : modelData.style.bg,
              modelData.style.inverse ? root.palette.terminalForeground : "transparent")

            readonly property string link: modelData.style.link || ""

            Rectangle {
              anchors.fill: parent
              color: cellRun.background
              visible: cellRun.background !== "transparent"
            }

            // A link is a link when the pointer is on it. Hover underlines it
            // and the cursor changes, which is the whole of what tells someone
            // a piece of terminal text can be clicked.
            HoverHandler {
              id: linkHover
              enabled: cellRun.link !== ""
              cursorShape: Qt.PointingHandCursor
              onHoveredChanged: root.hoveredLink = hovered ? cellRun.link : ""
            }

            TapHandler {
              enabled: cellRun.link !== ""
              onTapped: root.linkActivated(cellRun.link)
            }

            Text {
              id: runText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: cellRun.modelData.text
              color: cellRun.modelData.style.invisible ? "transparent" : cellRun.foreground
              // Faint is opacity rather than a darker colour, because the right
              // darker colour depends on a background that changes with the
              // theme.
              opacity: cellRun.modelData.style.faint ? 0.55 : 1
              font.family: root.fontFamily
              font.pixelSize: root.fontSize
              font.bold: cellRun.modelData.style.bold
              font.italic: cellRun.modelData.style.italic
              font.underline: cellRun.modelData.style.underline > 0 || linkHover.hovered
              font.strikeout: cellRun.modelData.style.strikethrough
              // Nothing is added between characters. Every run starts at the
              // column the terminal put it in, and a wide character is a run of
              // its own, so each glyph sits at its own cell with whatever room
              // is left over to its right. That is what a terminal does, and
              // padding the difference back in is what spread CJK text apart.
              textFormat: Text.PlainText
            }
          }
        }
      }
    }
  }

  // A drag selects. A plain click does not: a handler only takes the grab once
  // the pointer has moved, so a click still reaches the link underneath it.
  DragHandler {
    id: selector
    target: null
    cursorShape: Qt.IBeamCursor

    onActiveChanged: {
      if (!active) return
      root.selectionAnchor = root.cellAt(centroid.pressPosition)
      root.selectionHead = root.cellAt(centroid.position)
    }

    onCentroidChanged: {
      if (!active) return
      root.selectionHead = root.cellAt(centroid.position)
    }
  }

  // The selection, drawn over the text rather than under it. Terminals invert
  // the cells; a wash is the same idea with one colour instead of two, and it
  // survives a row that already has a background of its own.
  Item {
    anchors.fill: parent
    visible: root.hasSelection
    z: 3

    Repeater {
      model: root.selectionRange
        ? root.selectionRange.lastRow - root.selectionRange.firstRow + 1
        : 0

      Rectangle {
        required property int index
        readonly property int rowIndex: root.selectionRange.firstRow + index
        readonly property int from: rowIndex === root.selectionRange.firstRow
          ? root.selectionRange.firstColumn : 0
        readonly property int to: rowIndex === root.selectionRange.lastRow
          ? root.selectionRange.lastColumn : root.columnCount

        x: from * root.cellWidth
        y: rowIndex * root.cellHeight
        width: Math.max(0, to - from) * root.cellWidth
        height: root.cellHeight
        color: Color.accent
        opacity: 0.26
      }
    }
  }

  // The cursor, where the far side says it is.
  //
  // A block, filled when this window has the keyboard and outlined when it does
  // not, which is what every terminal does and therefore what the eye already
  // knows how to read.
  Rectangle {
    x: root.cursor.column * root.cellWidth
    y: root.cursor.row * root.cellHeight
    width: root.cellWidth
    height: root.cellHeight
    visible: root.cursor.visible && root.rows.length > 0
    color: root.focused ? Color.accent : "transparent"
    border.width: root.focused ? 0 : 1
    border.color: Color.accent
    opacity: root.focused ? 0.65 : 0.5

    // The cursor glides rather than jumps. Short enough that typing never
    // feels behind the keys, long enough that the eye can follow it across a
    // line, which is what a jump loses.
    Behavior on x { NumberAnimation { duration: 50 } }
    Behavior on y { NumberAnimation { duration: 50 } }
    Behavior on color { ColorAnimation { duration: 120 } }
    Behavior on opacity { NumberAnimation { duration: 120 } }
  }
}
