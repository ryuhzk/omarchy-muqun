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

    Behavior on color {
      ColorAnimation { duration: 120 }
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
    visible: hover.hovered && root.hint !== ""
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.top: parent.bottom
    anchors.topMargin: Style.space(6)
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
