import QtQuick
import qs.Commons

// What is running, everywhere, in one column.
//
// Laid out the way `git status --short` is: a one-character status column on
// the left, then who it is, then what it is doing. Aligning the marks gives the
// eye one place to look, which is the whole job of this list. The question it
// answers is "is anything waiting", not "what is the tree of hosts and tabs and
// panes".
//
// Two sections per machine, because a machine has two kinds of thing on it and
// they are reached for at different moments: the agents that may be waiting on
// an answer, and the terminals you go and do something in. Each section is
// named for the tool that runs it, which is the only place that says whether a
// pane is herdr's or tmux's -- and it is the right place, because the answer is
// the same for every row under the heading.
//
// Rows are not cards. A card around each pane would be four borders and a
// shadow spent on saying "this is a row", which the row already says.
Flickable {
  id: root

  property var hosts: []
  property string fontFamily: "monospace"
  property string selectedAlias: ""
  property string selectedPane: ""
  property var markFor: null
  property var markColor: null

  signal panePicked(string alias, string paneId)
  /** Close this pane, and whatever is running in it. */
  signal paneClosed(string alias, string paneId)
  /** Open a terminal that was not there before, on this machine. */
  signal terminalRequested(string alias)
  /** Start an agent that was not there before, on this machine. */
  signal agentRequested(string alias, string kind, string where)

  /** Which tool described the selected pane, so "beside it" can be offered. */
  property string selectedSource: ""

  /** Which host has the new-agent chooser open, if any. One at a time. */
  property string newAgentHost: ""
  /** Where the next agent goes. Remembered, because it is usually the same answer. */
  property string agentWhere: "tab"

  /**
   * The kinds offered. herdr knows two dozen; these are the ones people run.
   * A kind not listed can still be started from herdr itself.
   */
  readonly property var agentKinds: ["claude", "codex", "gemini", "opencode", "pi", "copilot"]

  /** Which row has its menu open, if any. One at a time. */
  property string menuPane: ""

  /**
   * Panes that have just started waiting on a human.
   *
   * Their mark pulses once when the row is built, which is how a list that is
   * redrawn from a fresh snapshot can still say "this one changed". Set by the
   * panel from what it knew before and what it has now; a row that was
   * already waiting does not pulse again.
   */
  property var pulsePanes: []

  contentWidth: width
  contentHeight: column.height
  clip: true
  boundsBehavior: Flickable.StopAtBounds

  readonly property color muted: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                                         Color.popups.text.b, 0.42)

  // The second line of a row, smaller than the first. It is the same word on
  // most rows, so it answers "which one is this" at a glance and then gets out
  // of the way of the thing that is different.
  readonly property int noteFont: Math.max(9, Math.round(Style.font.caption * 0.9))

  function withAgent(panes) {
    var out = []
    for (var i = 0; i < panes.length; i++) if (panes[i].agent) out.push(panes[i])
    return out
  }

  function withoutAgent(panes) {
    var out = []
    for (var i = 0; i < panes.length; i++) if (!panes[i].agent) out.push(panes[i])
    return out
  }

  /** Which tool a section's panes came from. They all came from the same one. */
  function toolOf(panes) {
    return panes.length > 0 ? panes[0].source : ""
  }

  Column {
    id: column
    width: root.width
    spacing: Style.space(14)

    Repeater {
      model: root.hosts

      Column {
        id: hostBlock
        required property var modelData
        readonly property var host: modelData
        readonly property var agents: root.withAgent(modelData.panes)
        readonly property var shells: root.withoutAgent(modelData.panes)
        readonly property bool canOpen: modelData.capabilities.indexOf("tmux") >= 0
        readonly property bool hasHerdr: modelData.capabilities.indexOf("herdr") >= 0
        readonly property string alias: host ? host.alias : ""
        readonly property bool choosingAgent: root.newAgentHost !== "" && root.newAgentHost === alias
        // "Beside" needs a herdr pane on this host to be beside.
        readonly property bool canSplit: root.selectedAlias === alias && root.selectedSource === "herdr"

        width: column.width
        spacing: Style.space(1)

        // A machine that cannot be read says why, in its own words, rather than
        // showing an empty list that looks like a machine with nothing on it.
        Text {
          textFormat: Text.PlainText
          visible: hostBlock.modelData.error !== undefined
            && hostBlock.modelData.error !== ""
          width: parent.width
          bottomPadding: Style.space(4)
          text: hostBlock.modelData.error || ""
          color: Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        // The heading names the section and the tool behind it. Both are facts
        // rather than controls, so they are two quiet words and not a badge.
        Item {
          width: parent.width
          height: hostBlock.agents.length > 0 || hostBlock.hasHerdr
            ? agentsHeading.implicitHeight + Style.space(6)
            : 0
          visible: height > 0

          Text {
            id: agentsHeading
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            text: "agents"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: root.noteFont
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: newAgent.left
            anchors.rightMargin: Style.space(10)
            anchors.baseline: agentsHeading.baseline
            text: root.toolOf(hostBlock.agents) || (hostBlock.hasHerdr ? "herdr" : "")
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: root.noteFont
          }

          // Where a new agent comes from. herdr will only open a pane that
          // has an agent in it, so on a herdr host what can be made is an
          // agent, and the chooser under this heading says which and where.
          Text {
            id: newAgent
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.baseline: agentsHeading.baseline
            visible: hostBlock.hasHerdr
            text: "+"
            color: hostBlock.choosingAgent || newAgentHover.hovered ? Color.accent : root.muted
            rotation: hostBlock.choosingAgent ? 45 : 0
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall

            Behavior on color { ColorAnimation { duration: 120 } }
            Behavior on rotation { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }

            HoverHandler { id: newAgentHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
              onTapped: root.newAgentHost = hostBlock.choosingAgent ? "" : hostBlock.alias
            }
          }
        }

        // The chooser: where it goes, then which one. Picking a kind starts
        // it; there is no second button to press, because the kind is the
        // last thing there is to decide.
        Item {
          id: chooser
          width: parent.width
          clip: true
          height: hostBlock.choosingAgent ? chooserBody.implicitHeight + Style.space(10) : 0
          opacity: hostBlock.choosingAgent ? 1 : 0
          visible: height > 0
          Behavior on height { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
          Behavior on opacity { NumberAnimation { duration: 140 } }

          Column {
            id: chooserBody
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(6)
            anchors.rightMargin: Style.space(6)
            anchors.top: parent.top
            anchors.topMargin: Style.space(4)
            spacing: Style.space(6)

            Flow {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: [
                  { key: "split", label: "beside this pane" },
                  { key: "tab", label: "new tab" },
                  { key: "workspace", label: "new workspace" }
                ]

                Rectangle {
                  required property var modelData
                  readonly property bool usable: modelData.key !== "split" || hostBlock.canSplit
                  readonly property bool picked: root.agentWhere === modelData.key
                  width: whereLabel.implicitWidth + Style.space(12)
                  height: whereLabel.implicitHeight + Style.space(6)
                  radius: Style.cornerRadius
                  color: picked ? Style.selectedFill
                       : whereHover.hovered && usable ? Style.hoverFill
                       : "transparent"
                  opacity: usable ? 1 : 0.35
                  Behavior on color { ColorAnimation { duration: 120 } }
                  Behavior on opacity { NumberAnimation { duration: 120 } }

                  HoverHandler { id: whereHover; enabled: parent.usable }
                  TapHandler {
                    enabled: parent.usable
                    onTapped: root.agentWhere = parent.modelData.key
                  }

                  Text {
                    id: whereLabel
                    textFormat: Text.PlainText
                    anchors.centerIn: parent
                    text: parent.modelData.label
                    color: parent.picked ? Color.popups.text : root.muted
                    font.family: root.fontFamily
                    font.pixelSize: root.noteFont
                  }
                }
              }
            }

            Flow {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: root.agentKinds

                Rectangle {
                  required property var modelData
                  width: kindLabel.implicitWidth + Style.space(14)
                  height: kindLabel.implicitHeight + Style.space(8)
                  radius: Style.cornerRadius
                  color: kindHover.hovered ? Style.hoverFill : Style.normalFill
                  scale: kindTap.pressed ? 0.94 : 1
                  transformOrigin: Item.Center
                  Behavior on color { ColorAnimation { duration: 120 } }
                  Behavior on scale { NumberAnimation { duration: 90; easing.type: Easing.OutCubic } }

                  HoverHandler { id: kindHover; cursorShape: Qt.PointingHandCursor }
                  TapHandler {
                    id: kindTap
                    onTapped: {
                      // "Beside" with nothing to be beside becomes a tab,
                      // which is what the sidecar does too; said here so the
                      // chip that was picked and the thing that happens agree.
                      var where = root.agentWhere === "split" && !hostBlock.canSplit
                        ? "tab" : root.agentWhere
                      root.newAgentHost = ""
                      root.agentRequested(hostBlock.alias, parent.modelData, where)
                    }
                  }

                  Text {
                    id: kindLabel
                    textFormat: Text.PlainText
                    anchors.centerIn: parent
                    text: parent.modelData
                    color: Color.popups.text
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }
        }

        Repeater {
          model: hostBlock.agents
          delegate: paneRow
        }

        Item {
          width: parent.width
          height: hostBlock.shells.length > 0 || hostBlock.canOpen
            ? shellsHeading.implicitHeight + Style.space(16)
            : 0
          visible: height > 0

          Text {
            id: shellsHeading
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            text: "terminals"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: root.noteFont
          }

          Text {
            id: shellsTool
            textFormat: Text.PlainText
            anchors.right: newTerminal.left
            anchors.rightMargin: Style.space(10)
            anchors.baseline: shellsHeading.baseline
            text: root.toolOf(hostBlock.shells) || (hostBlock.canOpen ? "tmux" : "")
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: root.noteFont
          }

          // Where a new terminal comes from, said where it will appear. The
          // same thing is in the window's header; this one is here because this
          // is the list it lands in.
          Text {
            id: newTerminal
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.baseline: shellsHeading.baseline
            visible: hostBlock.canOpen
            text: "+"
            color: newHover.hovered ? Color.accent : root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall

            Behavior on color { ColorAnimation { duration: 120 } }

            HoverHandler { id: newHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
              onTapped: root.terminalRequested(hostBlock.host ? hostBlock.host.alias : "")
            }
          }
        }

        Repeater {
          model: hostBlock.shells
          delegate: paneRow
        }

        Component {
          id: paneRow

          Rectangle {
            id: row
            required property var modelData
            readonly property var host: hostBlock.host
            readonly property string hostAlias: host ? host.alias : ""
            readonly property bool active: hostAlias !== ""
              && root.selectedAlias === hostAlias
              && root.selectedPane === modelData.id
            readonly property bool menuOpen: root.menuPane === modelData.id

            width: column.width
            height: paneLines.implicitHeight + Style.space(10)
            radius: Style.cornerRadius
            color: active ? Style.selectedFill
                 : hover.hovered || menuOpen ? Style.hoverFill
                 : "transparent"
            z: menuOpen ? 5 : 0

            Behavior on color { ColorAnimation { duration: 120 } }

            HoverHandler { id: hover }

            TapHandler {
              onTapped: {
                root.menuPane = ""
                if (row.hostAlias !== "") root.panePicked(row.hostAlias, modelData.id)
              }
            }

            // The right button opens the one thing that is not a click: closing
            // a pane takes whatever is running in it, so it is deliberately not
            // something a stray click can reach.
            TapHandler {
              acceptedButtons: Qt.RightButton
              onTapped: root.menuPane = row.menuOpen ? "" : modelData.id
            }

            // The title gets the line, and who is running it goes underneath.
            // Side by side, the agent's name took a third of the column from
            // the one thing that says what the pane is, and every title was
            // elided to make room for a word that is the same on most rows.
            Column {
              id: paneLines
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              spacing: 0

              Row {
                width: parent.width
                spacing: Style.space(8)

                // The status column. One character wide, present even when
                // empty, so every title starts at the same x.
                Text {
                  id: markText
                  textFormat: Text.PlainText
                  width: markMetrics.width
                  text: root.markFor ? root.markFor(modelData.status) : ""
                  color: root.markColor ? root.markColor(modelData.status) : Color.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  horizontalAlignment: Text.AlignHCenter
                  transformOrigin: Item.Center

                  // One beat, when an agent starts waiting. Small and once:
                  // the mark is already the colour that says "waiting", and a
                  // pulse that kept going would be a second thing to ignore.
                  SequentialAnimation {
                    id: markPulse
                    NumberAnimation {
                      target: markText; property: "scale"; to: 1.45
                      duration: 120; easing.type: Easing.OutCubic
                    }
                    NumberAnimation {
                      target: markText; property: "scale"; to: 1
                      duration: 260; easing.type: Easing.OutBack
                    }
                  }

                  Component.onCompleted: {
                    if (root.pulsePanes.indexOf(modelData.id) >= 0) markPulse.start()
                  }

                  TextMetrics {
                    id: markMetrics
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    text: "M"
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  width: paneLines.width - markMetrics.width - Style.space(8)
                  text: modelData.title
                  color: modelData.agent ? Color.popups.text : root.muted
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }
              }

              // What is running it, or where it is. An agent pane says which
              // agent; a terminal says which window it is in, which is what
              // tells a dozen shells in a dozen sessions apart.
              Text {
                textFormat: Text.PlainText
                readonly property string note: modelData.agent || modelData.groupLabel || ""

                visible: note !== "" && note !== modelData.title
                height: visible ? implicitHeight : 0
                x: markMetrics.width + Style.space(8)
                width: paneLines.width - markMetrics.width - Style.space(8)
                text: note
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: root.noteFont
                elide: Text.ElideRight
              }
            }

            // One item, so it is a word on a ground rather than a menu with a
            // list of one thing in it.
            Rectangle {
              opacity: row.menuOpen ? 1 : 0
              visible: opacity > 0
              scale: row.menuOpen ? 1 : 0.92
              transformOrigin: Item.Right
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              width: closeLabel.implicitWidth + Style.space(16)
              height: closeLabel.implicitHeight + Style.space(8)
              radius: Style.cornerRadius
              color: Color.popups.background

              Behavior on opacity { NumberAnimation { duration: 120 } }
              Behavior on scale { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
              border.width: 1
              border.color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.45)

              TapHandler {
                onTapped: {
                  root.menuPane = ""
                  if (row.hostAlias !== "") root.paneClosed(row.hostAlias, modelData.id)
                }
              }

              Text {
                id: closeLabel
                textFormat: Text.PlainText
                anchors.centerIn: parent
                text: "Close pane"
                color: Color.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }

    // An empty panel is an invitation, not a blank.
    Text {
      textFormat: Text.PlainText
      visible: root.hosts.length === 0
      width: column.width
      text: "No machines yet. The window beside this is where they are added."
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      lineHeight: 1.35
      wrapMode: Text.WordWrap
    }
  }
}
