import QtQuick
import qs.Commons

// The simulators on the other machine, down the right-hand side.
//
// Not another pane in the list. A simulator is not a terminal, and putting one
// among the panes would say it was.
//
// The picture is drawn from whole frames the sidecar fetches, not from a web
// view: Qt's web engine has to be initialised before the application exists,
// which a plugin loaded into a running shell cannot do, and it takes the shell
// down on the first frame. Touches are their own channel in simfarm's protocol
// and carry fractions of the picture rather than pixels, so the device is as
// operable here as in a browser and the strip can be any width.
Item {
  id: root

  property var devices: []
  property string selectedId: ""
  property string framePath: ""
  property int frameRevision: 0
  property bool configured: false
  property string openUrl: ""
  property string fontFamily: "monospace"
  /** Whether the device list is dropped down. Closed is the resting state. */
  property bool pickerOpen: false

  signal devicePicked(string deviceId)
  signal tapped(string phase, real x, real y)
  signal scrolled(real dx, real dy, real x, real y)
  signal buttonPressed(string button)
  signal openRequested()
  /** Open a terminal on the machine and start the server in it. */
  signal startRequested()
  /** Open the project's page in a browser. */
  signal repoRequested()

  /** The command that would start it, and the address it would then answer at. */
  property string startCommand: ""
  property string shortAddress: ""
  /** Whether there is a machine to start it on. */
  property bool canStart: false

  // What each button is called to a person. Only the ones the device said it
  // has are shown, so an iPhone gets a lock button and an Android gets back.
  readonly property var buttonLabels: ({
    "home": "home",
    "back": "back",
    "app_switch": "apps",
    "lock": "lock",
    "power": "power",
    "volume_up": "vol +",
    "volume_down": "vol −",
    "siri": "siri",
    "menu": "menu",
    "action": "action"
  })

  readonly property color muted: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                                         Color.popups.text.b, 0.42)
  readonly property var selectedDevice: {
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].id === selectedId) return devices[i]
    }
    return null
  }

  Column {
    anchors.fill: parent
    spacing: Style.space(8)

    // The picker, at the top, closed.
    //
    // One device is being watched and the rest are a list you open when you
    // want another, which is how the simfarm panel itself puts it. Showing all
    // ten all the time spent the strip's height on a decision nobody was making.
    //
    // Above the picture rather than below it, because it names what you are
    // looking at: a caption under a phone reads as something about the phone,
    // and this is the control that changes which phone it is.
    Item {
      id: picker
      width: parent.width
      height: pickerHead.height + (root.pickerOpen ? pickerList.height + Style.space(2) : 0)
      clip: true

      Behavior on height {
        NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
      }

      Rectangle {
        id: pickerHead
        width: parent.width
        height: headLabel.implicitHeight + Style.space(8)
        radius: Style.cornerRadius
        color: headHover.hovered ? Style.hoverFill : Style.normalFill

        HoverHandler { id: headHover }
        TapHandler { onTapped: root.pickerOpen = !root.pickerOpen }

        Row {
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          anchors.leftMargin: Style.space(8)
          anchors.rightMargin: Style.space(8)
          spacing: Style.space(6)

          Text {
            textFormat: Text.PlainText
            text: root.selectedDevice && root.selectedDevice.booted ? "●" : " "
            color: Color.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            id: headLabel
            textFormat: Text.PlainText
            width: pickerHead.width - Style.space(44)
            text: root.selectedDevice ? root.selectedDevice.name
                : root.devices.length === 0 ? "No devices" : "Pick a device"
            color: Color.popups.text
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Text {
            textFormat: Text.PlainText
            text: root.pickerOpen ? "\u25b4" : "\u25be"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      Column {
        id: pickerList
        anchors.top: pickerHead.bottom
        anchors.topMargin: Style.space(2)
        width: parent.width
        spacing: Style.space(1)
        opacity: root.pickerOpen ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 120 } }

        Repeater {
          model: root.devices

          Rectangle {
            required property var modelData
            readonly property bool active: modelData.id === root.selectedId

            width: pickerList.width
            height: deviceName.implicitHeight + Style.space(6)
            radius: Style.cornerRadius
            color: active ? Style.selectedFill
                 : deviceHover.hovered ? Style.hoverFill
                 : "transparent"
            // A device that is not booted has nothing to show, so it is listed
            // and not offered.
            opacity: modelData.booted ? 1 : 0.4

            HoverHandler { id: deviceHover; enabled: modelData.booted }
            TapHandler {
              enabled: modelData.booted
              onTapped: {
                root.devicePicked(modelData.id)
                root.pickerOpen = false
              }
            }

            Row {
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(8)
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                text: modelData.booted ? "●" : " "
                color: modelData.booted ? Color.accent : root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Text {
                id: deviceName
                textFormat: Text.PlainText
                width: pickerList.width - Style.space(30)
                text: modelData.name
                color: Color.popups.text
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }
          }
        }
      }
    }

    // The picture. It keeps the device's own proportions and takes whatever
    // room the strip has, so dragging the window bigger makes the phone bigger.
    Item {
      id: stage
      width: parent.width
      height: parent.height - picker.height - footer.height - buttonRow.height
        - Style.space(24)

      readonly property real deviceRatio: root.selectedDevice
          && root.selectedDevice.width > 0 && root.selectedDevice.height > 0
        ? root.selectedDevice.width / root.selectedDevice.height
        : 0.47

      Image {
        id: picture
        anchors.centerIn: parent
        height: Math.min(parent.height, parent.width / stage.deviceRatio)
        width: height * stage.deviceRatio
        // The sidecar writes each frame to a file and alternates two of them,
        // so the one being drawn is never the one being replaced. The revision
        // is what makes Qt fetch it again rather than serve its cache.
        source: root.framePath === ""
          ? ""
          : "file://" + root.framePath + "?" + root.frameRevision
        cache: false
        fillMode: Image.PreserveAspectFit
        smooth: true
        visible: root.framePath !== ""

        // Positions go out as fractions of the picture, which is why nothing
        // here depends on how big the strip happens to be.
        MouseArea {
          anchors.fill: parent
          acceptedButtons: Qt.LeftButton
          onPressed: function(mouse) {
            root.tapped("begin", mouse.x / width, mouse.y / height)
          }
          onPositionChanged: function(mouse) {
            if (!pressed) return
            root.tapped("move", mouse.x / width, mouse.y / height)
          }
          onReleased: function(mouse) {
            root.tapped("end", mouse.x / width, mouse.y / height)
          }
          onWheel: function(wheel) {
            root.scrolled(wheel.angleDelta.x, wheel.angleDelta.y,
                          wheel.x / width, wheel.y / height)
          }
        }
      }

      // An empty stage is an invitation, not a blank.
      //
      // Nothing answering almost always means the server is not running, and
      // what to do about that is one command on the machine it should be
      // running on. So the command is here, and so is a button that runs it.
      // Being told what is wrong and left to go and find the command yourself
      // is half an answer.
      Column {
        anchors.centerIn: parent
        width: parent.width - Style.space(16)
        spacing: Style.space(8)
        visible: root.framePath === ""

        readonly property bool missing: root.configured && root.devices.length === 0

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: !root.configured
              ? "No simulator farm set yet."
              : root.devices.length === 0
                ? "Nothing is answering at " + root.shortAddress + "."
                : "Pick a device above."
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: !root.configured
          text: "Its address goes in this plugin's settings, behind the gear above."
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: parent.missing
          topPadding: Style.space(4)
          text: "simfarm streams a Mac's simulators. Start it there with:"
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
        }

        // The command itself, in full. Someone may want to run it by hand, or
        // change a flag first, and a button that hides what it is about to do
        // is a button nobody should press.
        Rectangle {
          width: parent.width
          height: commandText.implicitHeight + Style.space(12)
          visible: parent.missing
          radius: Style.cornerRadius
          color: Style.normalFill

          Text {
            id: commandText
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)
            text: root.startCommand
            color: Color.popups.text
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WrapAnywhere
          }
        }

        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          width: startLabel.implicitWidth + Style.space(20)
          height: startLabel.implicitHeight + Style.space(10)
          visible: parent.missing && root.canStart
          radius: Style.cornerRadius
          color: startHover.hovered ? Style.hoverFill : Style.selectedFill

          HoverHandler { id: startHover; cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: root.startRequested() }

          Text {
            id: startLabel
            textFormat: Text.PlainText
            anchors.centerIn: parent
            text: "Start it in a new terminal"
            color: Color.popups.text
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: parent.missing
          text: "github.com/BANG88/simfarm"
          color: repoHover.hovered ? Color.accent : root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter

          HoverHandler { id: repoHover; cursorShape: Qt.PointingHandCursor }
          TapHandler { onTapped: root.repoRequested() }
        }
      }
    }

    // The device's own buttons, as the web panel has them. A control the
    // device does not have is a control that does nothing, so the list comes
    // from the device rather than from here.
    Flow {
      id: buttonRow
      width: parent.width
      spacing: Style.space(4)
      visible: root.selectedDevice !== null

      Repeater {
        model: root.selectedDevice ? root.selectedDevice.buttons : []

        Rectangle {
          required property var modelData
          readonly property string label: root.buttonLabels[modelData] || modelData

          visible: root.buttonLabels[modelData] !== undefined
          width: visible ? buttonLabel.implicitWidth + Style.space(12) : 0
          height: visible ? buttonLabel.implicitHeight + Style.space(6) : 0
          radius: Style.cornerRadius
          color: buttonHover.hovered ? Style.hoverFill : Style.normalFill

          HoverHandler { id: buttonHover }
          TapHandler { onTapped: root.buttonPressed(modelData) }

          Text {
            id: buttonLabel
            textFormat: Text.PlainText
            anchors.centerIn: parent
            text: parent.label
            color: Color.popups.text
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }

    Item {
      id: footer
      width: parent.width
      height: openLink.implicitHeight

      Text {
        id: openLink
        textFormat: Text.PlainText
        anchors.left: parent.left
        visible: root.configured && root.openUrl !== ""
        text: "open simfarm"
        color: openHover.hovered ? Color.accent : root.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption

        HoverHandler { id: openHover }
        TapHandler { onTapped: root.openRequested() }
      }
    }
  }
}
