import QtQuick
import qs.Commons

// The pane, live, with the keyboard pointed at it.
//
// There is no local input line. What you type goes to the remote terminal and
// what comes back is its own echo, which is what happens when you log in. A
// second place to type would be a second idea of where the cursor is.
//
// The surface measures itself in characters and says so, because the far side
// draws for the size it was told. Getting that wrong is why a remote terminal
// wraps in the wrong place.
FocusScope {
  id: root

  property var rows: []
  property var cursor: ({ row: 0, column: 0, visible: false })
  property AnsiPalette palette: null
  property int fontSize: Style.font.bodySmall
  property string fontFamily: "monospace"
  property bool connected: true

  /** Raw text the person typed, already composed by the input method. */
  signal textEntered(string text)
  /** A key with no character of its own, by name. */
  signal keyEntered(string key)
  /** A hyperlink in the output was clicked. */
  signal linkActivated(string url)
  /** The size in characters changed and the far side should be told. */
  signal resized(int rows, int columns)
  /**
   * A wheel notch over the pane. Positive goes back.
   *
   * The pointer's cell goes with it, because a program that tracks the mouse is
   * told where the wheel turned and scrolls whatever is under it.
   */
  signal scrolled(int rows, int column, int row)
  /** Text the person selected and asked for. */
  signal copyRequested(string text)
  /**
   * A click landed on the grid, in cells.
   *
   * Forwarded to the program, which decides whether it means anything. Most of
   * the time it does not and the click was only ever about where the keyboard
   * points; when a program is tracking the mouse, this is what makes the things
   * it draws work.
   */
  signal clicked(int column, int row)
  /** Put what is on the clipboard into the pane. */
  signal pasteRequested()
  /** Show or hide the pane list beside this. */
  signal listToggled()
  /** Show or hide the simulators beside this. */
  signal simfarmToggled()

  /** Whether there is something selected to copy. */
  readonly property bool hasSelection: view.hasSelection

  readonly property int columnCount: view.columnCount
  readonly property int rowCount: view.rowCount

  function focusInput() {
    capture.forceActiveFocus()
  }

  // The screen gets a ground of its own.
  //
  // Without it an empty terminal is the same colour as the window around it,
  // and a pane that has printed nothing looks exactly like a pane that failed
  // to open. A faint field says "this is the screen" whether or not anything is
  // on it.
  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                   Color.popups.text.b, 0.035)
  }

  ScreenView {
    id: view
    anchors.fill: parent
    anchors.margins: Style.space(10)
    // A screen arrives rather than snaps in: the rows are cleared when a pane
    // is picked and filled by the first frame from the far side, and the fade
    // is what makes that read as one pane giving way to another.
    opacity: root.rows.length > 0 ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
    rows: root.rows
    cursor: root.cursor
    palette: root.palette
    fontSize: root.fontSize
    fontFamily: root.fontFamily
    focused: capture.activeFocus && root.connected
    onLinkActivated: function(url) { root.linkActivated(url) }
  }

  // What to do with a selection, while there is one. It is a keystroke people
  // either know or do not, and the ones who do not would otherwise select text
  // and find no way to take it.
  Text {
    textFormat: Text.PlainText
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.margins: Style.space(10)
    opacity: view.hasSelection ? 1 : 0
    visible: opacity > 0
    Behavior on opacity { NumberAnimation { duration: 120 } }
    text: "ctrl shift c to copy"
    color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.45)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  // What an empty screen means, said rather than left to guess at.
  Text {
    textFormat: Text.PlainText
    anchors.centerIn: parent
    width: parent.width - Style.space(48)
    opacity: root.rows.length === 0 ? 1 : 0
    visible: opacity > 0
    Behavior on opacity { NumberAnimation { duration: 160 } }
    // It says what it knows. Claiming to be attached when all it knows is that
    // a pane is selected is how an empty screen and a failed one came to look
    // the same.
    text: !root.connected
      ? "Pick a pane on the left."
      : "Opening this pane."
    color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.4)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.WordWrap
  }

  // Resizing is coalesced. Dragging a window edge produces a size every frame,
  // and the far side redraws its whole screen for each one it is told about.
  Timer {
    id: settle
    // Longer than the simulator strip takes to slide in beside it, so that
    // opening the strip tells the far side one new size and not a dozen.
    interval: 180
    onTriggered: root.resized(view.rowCount, view.columnCount)
  }

  onWidthChanged: settle.restart()
  onHeightChanged: settle.restart()

  TapHandler {
    // Below the runs, so a click on a link reaches the link first and only a
    // click on ordinary output aims the keyboard. A click also lets go of a
    // selection, which is what clicking does everywhere else.
    onTapped: function(eventPoint) {
      view.clearSelection()
      root.focusInput()
      // And then it goes to the program, which is what makes a close button an
      // agent drew into a close button rather than a picture of one. Where it
      // landed is measured against the grid rather than against this item,
      // because the grid is inset from it.
      if (view.hoveredLink !== "") return
      var point = view.mapFromItem(root, eventPoint.position.x, eventPoint.position.y)
      root.clicked(Math.floor(point.x / Math.max(1, view.cellWidth)),
                   Math.floor(point.y / Math.max(1, view.cellHeight)))
    }
  }

  // The wheel scrolls the pane's own history, in whole rows, the way it does in
  // a terminal. A full-screen program gets nothing here: the far side owns its
  // grid, and the sidecar refuses while the alternate screen is up.
  WheelHandler {
    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
    onWheel: function(event) {
      var steps = event.angleDelta.y / 40
      if (steps === 0) return
      var point = view.mapFromItem(root, event.x, event.y)
      root.scrolled(Math.round(steps),
                    Math.floor(point.x / Math.max(1, view.cellWidth)),
                    Math.floor(point.y / Math.max(1, view.cellHeight)))
    }
  }

  // A field with no size and no visible text. It exists so an input method has
  // somewhere to compose: typing Chinese means a candidate window and a commit,
  // and neither happens to a plain key handler. What it commits is forwarded
  // and cleared at once, so it never accumulates a line of its own.
  TextInput {
    id: capture
    width: 0
    height: 0
    opacity: 0
    enabled: root.connected
    focus: true

    onTextChanged: {
      if (text === "") return
      root.textEntered(text)
      text = ""
    }

    Keys.onPressed: function(event) {
      if (!root.connected) {
        event.accepted = true
        return
      }

      var name = root.keyNameFor(event)
      if (name !== "") {
        root.keyEntered(name)
        event.accepted = true
        return
      }

      // The window's own keys, before anything else reads them. Copy and paste
      // are ctrl-shift because ctrl-c and ctrl-v belong to the program on the
      // other side and this window has to leave those alone.
      var control = (event.modifiers & Qt.ControlModifier) !== 0
      var shift = (event.modifiers & Qt.ShiftModifier) !== 0

      if (control && shift && event.key === Qt.Key_C) {
        if (view.hasSelection) root.copyRequested(view.selectedText())
        event.accepted = true
        return
      }

      if (control && shift && event.key === Qt.Key_V) {
        root.pasteRequested()
        event.accepted = true
        return
      }

      // Showing and hiding what is beside the terminal. Both are ctrl-shift
      // for the same reason copy and paste are: plain ctrl-b is tmux's own
      // prefix and plain ctrl-s stops the flow, and both belong to the program
      // on the other side.
      if (control && shift && event.key === Qt.Key_B) {
        root.listToggled()
        event.accepted = true
        return
      }

      if (control && shift && event.key === Qt.Key_S) {
        root.simfarmToggled()
        event.accepted = true
        return
      }

      // A control combination has no character to commit, so it is named here
      // and turned into its control code by the sidecar.
      if ((event.modifiers & Qt.ControlModifier) && event.key >= Qt.Key_A
          && event.key <= Qt.Key_Z) {
        root.keyEntered("C-" + String.fromCharCode(event.key).toLowerCase())
        event.accepted = true
      }
    }
  }

  // The keys that have no character of their own. Everything printable goes
  // through the field above, so this list stays short and does not need to know
  // about layouts or input methods.
  function keyNameFor(event) {
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      return (event.modifiers & Qt.ShiftModifier) ? "S-Enter" : "Enter"
    }
    if (event.key === Qt.Key_Escape) return "Escape"
    if (event.key === Qt.Key_Backspace) return "BSpace"
    if (event.key === Qt.Key_Delete) return "Delete"
    if (event.key === Qt.Key_Tab) return (event.modifiers & Qt.ShiftModifier) ? "BTab" : "Tab"
    if (event.key === Qt.Key_Up) return "Up"
    if (event.key === Qt.Key_Down) return "Down"
    if (event.key === Qt.Key_Left) return "Left"
    if (event.key === Qt.Key_Right) return "Right"
    if (event.key === Qt.Key_Home) return "Home"
    if (event.key === Qt.Key_End) return "End"
    if (event.key === Qt.Key_PageUp) return "PageUp"
    if (event.key === Qt.Key_PageDown) return "PageDown"
    return ""
  }
}
