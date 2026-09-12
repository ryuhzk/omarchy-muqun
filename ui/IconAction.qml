import QtQuick
import qs.Commons

// One thing you can do to what is on screen, in the window's header.
//
// A glyph and nothing else: no border, no fill, no pill. These sit in a row of
// three, and a box around each would be three rectangles spent saying that a
// row of controls is a row of controls. Hover says it is a control, and the
// label under it says which.
//
// An Item around the glyph rather than a bare Text, so that the label hanging
// below cannot take part in measuring the glyph.
Item {
  id: root

  property string text: ""
  property string fontFamily: "monospace"
  property bool on: false
  property string hint: ""

  signal activated()

  implicitWidth: glyph.implicitWidth
  implicitHeight: glyph.implicitHeight

  Text {
    id: glyph
    textFormat: Text.PlainText
    anchors.centerIn: parent
    text: root.text
    color: root.on ? Color.accent
         : hover.hovered ? Color.popups.text
         : Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.42)
    font.family: root.fontFamily
    font.pixelSize: Style.font.icon
    // A touch larger under the pointer, the way the bar's own buttons answer.
    scale: hover.hovered ? 1.12 : 1
    transformOrigin: Item.Center

    Behavior on color {
      ColorAnimation { duration: 120 }
    }
    Behavior on scale {
      NumberAnimation { duration: 110; easing.type: Easing.OutCubic }
    }
  }

  HoverHandler {
    id: hover
    cursorShape: Qt.PointingHandCursor
  }

  TapHandler {
    onTapped: root.activated()
  }

  // The name of the thing, on hover. A glyph is quick to read once you know it
  // and unreadable the first time, which is the whole reason this is here.
  Rectangle {
    id: hintBox
    readonly property bool shown: hover.hovered && root.hint !== ""
    opacity: shown ? 1 : 0
    visible: opacity > 0
    // Centred under the glyph where there is room, and pulled in where there
    // is not. The last of these sits against the window's right edge, and a
    // label centred under it lost its second half to that edge.
    x: {
      var centred = (root.width - width) / 2
      var margin = Style.space(12)
      var atWindow = root.mapToItem(null, centred, 0).x
      var limit = root.Window.width - margin
      if (atWindow + width > limit) return centred - (atWindow + width - limit)
      if (atWindow < margin) return centred + (margin - atWindow)
      return centred
    }
    anchors.top: parent.bottom
    // It settles into place rather than appearing there.
    anchors.topMargin: shown ? Style.space(6) : Style.space(2)

    Behavior on opacity { NumberAnimation { duration: 120 } }
    Behavior on anchors.topMargin {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }
    width: hintLabel.implicitWidth + Style.space(12)
    height: hintLabel.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: Color.popups.background
    border.width: 1
    border.color: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                          Color.popups.text.b, 0.14)
    z: 10

    Text {
      id: hintLabel
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: root.hint
      color: Color.popups.text
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
