import QtQuick
import qs.Commons

// Where the pane's work lives, as things to click.
//
// The repository, the branch, the pull request open for it and the issues it
// is about, each a small chip in the header beside the pane's title. They are
// facts read from the machine the pane is on and nothing more: a click opens
// the page in the browser, and that is the whole of what this does.
//
// Chips, because each is a separate place to go. They stay the header's
// quiet colour until pointed at, so the title beside them is still the thing
// the eye lands on.
Row {
  id: root

  /** A RepoContext from the sidecar, or null when there is nothing to say. */
  property var context: null
  property string fontFamily: "monospace"

  /** Open this address. Only ever http or https, built by the sidecar. */
  signal opened(string url)

  spacing: Style.space(6)
  visible: context !== null && chips.count > 0

  readonly property color muted: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                                         Color.popups.text.b, 0.55)

  /** The most issues shown before the rest are folded into a count. */
  readonly property int issueLimit: 4

  // One list, in reading order: where, which branch, what is open, what it
  // is about. Built once per context rather than as four Repeaters, so the
  // chips stay one row with one spacing.
  readonly property var entries: {
    if (!context) return []
    var out = []
    if (context.remote) {
      out.push({ text: context.remote.owner + "/" + context.remote.name,
                 url: context.links.repo, hint: "Open the repository", tone: "muted" })
    }
    if (context.branch !== "") {
      out.push({ text: context.branch, url: context.links.branch,
                 hint: "Open the branch", tone: "muted" })
    }
    if (context.pullRequest) {
      var pr = context.pullRequest
      out.push({ text: "PR #" + pr.number, url: pr.url,
                 hint: pr.title + (pr.state !== "" ? " · " + pr.state : ""),
                 tone: pr.state === "open" ? "accent" : "muted" })
    }
    var issues = context.issues || []
    for (var i = 0; i < issues.length && i < root.issueLimit; i++) {
      out.push({ text: "#" + issues[i].number, url: issues[i].url,
                 hint: "Open issue #" + issues[i].number, tone: "muted" })
    }
    if (issues.length > root.issueLimit) {
      out.push({ text: "+" + (issues.length - root.issueLimit), url: "",
                 hint: "", tone: "muted" })
    }
    return out
  }

  Repeater {
    id: chips
    model: root.entries

    Rectangle {
      id: chip
      required property var modelData
      readonly property bool clickable: modelData.url !== ""

      anchors.verticalCenter: parent.verticalCenter
      width: label.implicitWidth + Style.space(12)
      height: label.implicitHeight + Style.space(6)
      radius: Style.cornerRadius
      color: chipHover.hovered && clickable ? Style.hoverFill : Style.normalFill
      scale: chipTap.pressed ? 0.94 : 1
      transformOrigin: Item.Center
      opacity: 0
      Component.onCompleted: opacity = 1

      Behavior on color { ColorAnimation { duration: 120 } }
      Behavior on scale { NumberAnimation { duration: 90; easing.type: Easing.OutCubic } }
      Behavior on opacity { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }

      HoverHandler { id: chipHover; cursorShape: chip.clickable ? Qt.PointingHandCursor : Qt.ArrowCursor }
      TapHandler {
        id: chipTap
        enabled: chip.clickable
        onTapped: root.opened(chip.modelData.url)
      }

      Text {
        id: label
        textFormat: Text.PlainText
        anchors.centerIn: parent
        text: chip.modelData.text
        color: chip.modelData.tone === "accent" ? Color.accent
             : chipHover.hovered && chip.clickable ? Color.popups.text
             : root.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideMiddle
        // A branch name can be a sentence. It gets a third of the row at most.
        width: Math.min(implicitWidth, Style.space(220))
        Behavior on color { ColorAnimation { duration: 120 } }
      }

      // What it is, on hover. The chip says where; this says what.
      Rectangle {
        readonly property bool shown: chipHover.hovered && chip.modelData.hint !== ""
        opacity: shown ? 1 : 0
        visible: opacity > 0
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.bottom
        anchors.topMargin: shown ? Style.space(6) : Style.space(2)
        width: hintLabel.implicitWidth + Style.space(12)
        height: hintLabel.implicitHeight + Style.space(6)
        radius: Style.cornerRadius
        color: Color.popups.background
        border.width: 1
        border.color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.14)
        z: 10
        Behavior on opacity { NumberAnimation { duration: 120 } }
        Behavior on anchors.topMargin { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

        Text {
          id: hintLabel
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: chip.modelData.hint
          color: Color.popups.text
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          width: Math.min(implicitWidth, Style.space(360))
        }
      }
    }
  }
}
