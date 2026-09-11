import QtQuick
import qs.Commons

// Which machines this plugin watches.
//
// A host is an ssh destination and nothing else: no pairing, no token, no URL.
// If you can already reach it from a terminal you can reach it from here, and
// what it turns out to have -- herdr, tmux, both -- is asked rather than
// declared. That is the whole configuration, which is why it fits on one line.
//
// It stands in for the terminal when there are no machines yet, because a
// window that opens onto an empty column with nothing to press has not said
// what it wants.
Item {
  id: root

  property var hosts: []
  property string fontFamily: "monospace"
  /** Whether this is the first run, as opposed to a list being edited. */
  property bool firstRun: hosts.length === 0

  signal hostAdded(string alias)
  signal hostRemoved(string alias)
  signal dismissed()

  readonly property color muted: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                                         Color.popups.text.b, 0.42)

  function submit() {
    var alias = entry.text.trim()
    if (alias === "" || alias.startsWith("-")) return
    root.hostAdded(alias)
    entry.text = ""
  }

  function focusEntry() {
    entry.forceActiveFocus()
  }

  // One column of a readable width, in the middle of whatever room there is.
  // On the first run that room is the whole window, and a form pinned to the
  // left edge of it is a form nobody's eye lands on.
  Column {
    id: form
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.verticalCenter: parent.verticalCenter
    width: Math.min(parent.width - Style.space(80), Style.space(560))
    spacing: Style.space(10)

    readonly property real columnWidth: width

    Text {
      textFormat: Text.PlainText
      width: form.columnWidth
      text: root.firstRun ? "Add a machine" : "Machines"
      color: Color.popups.text
      font.family: root.fontFamily
      font.pixelSize: Style.font.title
    }

    Text {
      textFormat: Text.PlainText
      width: form.columnWidth
      bottomPadding: Style.space(6)
      text: "An ssh destination, the way you would type it: a name from your ssh "
        + "config, or you@machine. There is nothing else to set up. What the "
        + "machine has is found when it answers."
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      lineHeight: 1.4
      wrapMode: Text.WordWrap
    }

    // The field. A rule under it rather than a box around it: this is one line
    // of text, and a border would be four lines spent saying so.
    Item {
      width: form.columnWidth
      height: entry.implicitHeight + Style.space(14)

      TextInput {
        id: entry
        anchors.left: parent.left
        anchors.right: addButton.left
        anchors.rightMargin: Style.space(12)
        anchors.top: parent.top
        anchors.topMargin: Style.space(2)
        color: Color.popups.text
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        selectByMouse: true
        selectionColor: Color.accent
        clip: true

        onAccepted: root.submit()
        Keys.onEscapePressed: root.dismissed()

        Text {
          textFormat: Text.PlainText
          anchors.fill: parent
          visible: entry.text === ""
          text: "you@machine"
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }
      }

      Rectangle {
        id: addButton
        anchors.right: parent.right
        anchors.top: parent.top
        width: addLabel.implicitWidth + Style.space(20)
        height: addLabel.implicitHeight + Style.space(8)
        radius: Style.cornerRadius
        readonly property bool ready: entry.text.trim() !== ""
        color: !ready ? Style.normalFill
             : addHover.hovered ? Style.hoverFill
             : Style.selectedFill

        HoverHandler { id: addHover; enabled: addButton.ready }
        TapHandler {
          enabled: addButton.ready
          onTapped: root.submit()
        }

        Text {
          id: addLabel
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: "Add"
          color: addButton.ready ? Color.popups.text : root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: addButton.left
        anchors.rightMargin: Style.space(12)
        anchors.bottom: parent.bottom
        height: 1
        color: entry.activeFocus
          ? Color.accent
          : Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.18)
      }
    }

    // What is already there. Each row is the destination and a way to take it
    // off the list; removing one stops watching it and leaves the machine
    // itself alone.
    Column {
      width: form.columnWidth
      spacing: Style.space(1)
      topPadding: root.hosts.length > 0 ? Style.space(10) : 0

      Repeater {
        model: root.hosts

        Rectangle {
          required property var modelData

          width: parent.width
          height: aliasLabel.implicitHeight + Style.space(10)
          radius: Style.cornerRadius
          color: rowHover.hovered ? Style.hoverFill : "transparent"

          HoverHandler { id: rowHover }

          Text {
            id: aliasLabel
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - Style.space(90)
            text: modelData.label || modelData.alias
            color: Color.popups.text
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: removeMark.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.state === "ready"
              ? modelData.panes.length + " open"
              : modelData.state
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            id: removeMark
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "×"
            color: removeHover.hovered ? Color.urgent : root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.body

            HoverHandler { id: removeHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.hostRemoved(modelData.alias) }
          }
        }
      }
    }

    Text {
      textFormat: Text.PlainText
      visible: !root.firstRun
      topPadding: Style.space(10)
      text: "Done"
      color: doneHover.hovered ? Color.accent : root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall

      HoverHandler { id: doneHover; cursorShape: Qt.PointingHandCursor }
      TapHandler { onTapped: root.dismissed() }
    }
  }
}
