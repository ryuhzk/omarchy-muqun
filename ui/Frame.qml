import QtQuick
import qs.Commons

// A hairline seam, the way a terminal divides itself.
//
// One pixel of the text colour at a tenth of its weight. It is here because
// three regions with different jobs have to read as three regions; without a
// seam they are three piles of text on one field, which is what this window
// looked like before.
Rectangle {
  property bool vertical: false

  implicitWidth: vertical ? 1 : 0
  implicitHeight: vertical ? 0 : 1
  color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.10)
}
