import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "ui"

// Muqun: the coding agents running on your other machines, from the bar.
//
// The bar carries one number -- how many agents are waiting on a human -- and
// clicking it opens a window holding the pane that is asking, live, with the
// keyboard pointed at it. Typing goes to the remote pane and the pane's own
// echo is what comes back, which is what happens when you ssh in.
//
// It opens as an ordinary floating window, so it behaves like every other
// window on the desktop: super-drag to move it, drag an edge to resize, and it
// stays put beside the work it is about. A shell overlay would have looked
// similar and answered to none of that.
//
// Everything that touches a network lives in the sidecar, a Bun process this
// file starts and speaks JSON lines to. The panel holds no host credentials, no
// protocol knowledge, and no parsing: it draws what arrives and sends what was
// typed. That is also why nothing here polls -- the sidecar keeps a blocking
// `herdr agent wait` open per agent, so a change arrives when it happens.
Panel {
  id: root

  moduleName: "ryuhzk.muqun"
  ipcTarget: "ryuhzk.muqun"

  readonly property var hostAliases: String(setting("hosts", "")).split(":")
    .map(function(entry) { return entry.trim() })
    .filter(function(entry) { return entry !== "" })
  readonly property int windowWidth: parseInt(setting("panelWidth", 940), 10) || 940
  readonly property string simfarmUrl: String(setting("simfarmUrl", "")).trim()
  readonly property string simfarmSshHost: String(setting("simfarmSshHost", "")).trim()
  readonly property int simfarmLocalPort: parseInt(setting("simfarmLocalPort", 8801), 10) || 8801

  property var hosts: []
  property int attention: 0
  property var screenRows: []
  property var screenCursor: ({ row: 0, column: 0, visible: false })
  property string selectedAlias: ""
  property string selectedPane: ""
  property string lastError: ""
  property bool sidecarReady: false
  property bool simfarmOpen: false
  property var simfarmDevices: []
  property string simfarmDevice: ""
  property string simfarmFramePath: ""
  property int simfarmFrameRevision: 0
  property string simfarmOpenUrl: ""

  // The terminal's size in characters, as the surface last measured it.
  //
  // Held here rather than read off the surface, because a pane is chosen the
  // moment a host answers and that can be long before the window has been
  // opened, when the surface does not exist to ask. The far side is told this,
  // and told again the moment the surface has a real size of its own.
  property int termRows: 24
  property int termColumns: 80

  /** The shape the far side was last told about, so it is not told twice. */
  property int sentRows: 0
  property int sentColumns: 0

  /**
   * How wide the pane list is, as a share of the window.
   *
   * A share rather than a number of pixels, so the split survives the window
   * being resized. Dragging the seam sets it, and it is bounded so neither side
   * can be dragged away entirely.
   */
  property real listShare: 0.20

  /**
   * The same, for the simulator strip on the other side.
   *
   * Wider than the pane list, because a phone is tall: at a narrower share the
   * picture ran out of width long before it ran out of height and sat in a band
   * of empty. This is about the width at which a phone fills the height it has.
   */
  property real simfarmShare: 0.28

  /** Whether the pane list is showing. ctrl-b, or the machine name. */
  property bool listOpen: true

  /** Whether the machine list is being edited. */
  property bool setupOpen: false

  /**
   * When the setup form stands in for the terminal.
   *
   * Always on the first run, because a window that opens onto an empty column
   * with nothing to press has not said what it wants.
   *
   * Decided from the configured list rather than from the answered one. Nothing
   * has answered yet at the moment this matters, because with no machines the
   * sidecar is not running: it was gated on a reply that was never coming, and
   * the first run showed an empty terminal saying "pick a pane on the left"
   * over a list with nothing in it.
   */
  readonly property bool showSetup: setupOpen || hostAliases.length === 0

  // A guess at the screen, for the size the window asks for before it exists.
  // Corrected to whichever screen it actually opened on once it has one.
  readonly property var firstScreen: Quickshell.screens.length > 0
    ? Quickshell.screens[0] : null
  readonly property int screenWidth: firstScreen ? firstScreen.width : 0
  readonly property int screenHeight: firstScreen ? firstScreen.height : 0

  /**
   * How big the window should be on a screen of a given size.
   *
   * A share of the screen rather than a number of pixels, so a laptop gets a
   * window in proportion to a laptop and a desktop one in proportion to a
   * desktop. The floor keeps it usable on a small screen, and it never exceeds
   * the screen it is on: below the floor, the screen wins.
   */
  function preferredWidth(available) {
    if (available <= 0) return windowWidth
    return Math.min(available, Math.max(640, Math.round(available * 0.72)))
  }

  function preferredHeight(available) {
    if (available <= 0) return 900
    return Math.min(available, Math.max(420, Math.round(available * 0.82)))
  }

  readonly property string pluginDir: decodeURIComponent(
    String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, ""))

  // The font Omarchy is configured with, not a list of guesses. The material
  // here is terminal output, and a window on the same character grid as the
  // thing it shows reads as part of it rather than as a viewer wrapped around
  // it -- which is also why the family has to be the one the person actually
  // set rather than whichever of my guesses happened to be installed.
  readonly property string mono: Style.font.family

  readonly property var currentHost: {
    for (var h = 0; h < hosts.length; h++) {
      if (hosts[h].alias === selectedAlias) return hosts[h]
    }
    return hosts.length > 0 ? hosts[0] : null
  }

  /**
   * What a host says about itself, when there is something to say.
   *
   * Only ever a state. What the machine turned out to have belongs over the
   * part of the list it fills, where `agents` and `terminals` are already
   * named; sitting up here beside the buttons it read as a label for them.
   */
  function hostNote(host) {
    if (!host) return ""
    if (host.state === "connecting") return "connecting"
    if (host.state === "offline") return "offline"
    if (host.state === "error") return "not answering"
    return ""
  }

  readonly property var selectedPaneRecord: {
    for (var h = 0; h < hosts.length; h++) {
      if (hosts[h].alias !== selectedAlias) continue
      for (var p = 0; p < hosts[h].panes.length; p++) {
        if (hosts[h].panes[p].id === selectedPane) return hosts[h].panes[p]
      }
    }
    return null
  }

  function send(command) {
    if (!sidecarProcess.running) return
    sidecarProcess.write(JSON.stringify(command) + "\n")
  }

  function publishHosts() {
    send({
      type: "setHosts",
      hosts: hostAliases.map(function(alias) { return { alias: alias } })
    })
  }

  /**
   * Take a screen update in.
   *
   * The sidecar sends the rows that changed, not the screen, and says how many
   * rows there are. The rows that did not change are kept as the very objects
   * they already were, which is what lets the view leave them alone. A patch
   * for a screen of a different size than the one held here is a patch for a
   * screen this panel has let go of, and the full frame that follows any new
   * attachment is what fills it back in.
   */
  function applyScreen(event) {
    var rows
    if (event.full) {
      rows = []
    } else {
      if (root.screenRows.length !== event.rowCount) return
      rows = root.screenRows.slice()
    }
    while (rows.length < event.rowCount) rows.push({ runs: [] })
    for (var i = 0; i < event.changed.length; i++) {
      rows[event.changed[i].index] = event.changed[i].row
    }
    root.screenRows = rows
    root.screenCursor = event.cursor
  }

  // Attaching replaces whatever was attached. One pane is watched at a time,
  // which is what a person means by looking at a pane.
  function attachPane(alias, paneId) {
    root.selectedAlias = alias
    root.selectedPane = paneId
    root.lastError = ""
    root.repoContext = null
    root.screenRows = []
    root.sentRows = root.termRows
    root.sentColumns = root.termColumns
    send({
      type: "attach", alias: alias, paneId: paneId,
      rows: root.termRows, columns: root.termColumns
    })
  }

  /** Set while waiting for a pane whose name we will not know until it exists. */
  property bool adoptNextPane: false
  /** What the screen is waiting on, while it is empty for a reason worth naming. */
  property string pendingNote: ""
  /** Where the attached pane's work lives, from the sidecar. Null until it says. */
  property var repoContext: null

  // A terminal that was not there before, on a named machine or on the one
  // being looked at. It is a tmux window: herdr's terminals belong to the
  // agents it started in them, and tmux will make one for anybody.
  function newTerminal(alias, command) {
    var target = alias || (currentHost ? currentHost.alias : "")
    if (target === "") return
    root.setupOpen = false
    root.adoptNextPane = true
    root.screenRows = []
    send({
      type: "newTerminal", alias: target,
      rows: root.termRows, columns: root.termColumns,
      command: command || ""
    })
  }

  // An agent that was not there before, on a herdr host. The place for it and
  // the agent itself are made on the far side; the pane is adopted when its
  // first screen arrives, the same way a new terminal is.
  function newAgent(alias, kind, where) {
    if (alias === "") return
    root.setupOpen = false
    root.adoptNextPane = true
    root.screenRows = []
    root.pendingNote = "Starting " + kind + " on " + alias + "."
    var command = {
      type: "newAgent", alias: alias, kind: kind, where: where,
      rows: root.termRows, columns: root.termColumns
    }
    if (root.selectedAlias === alias && root.selectedPaneRecord
        && root.selectedPaneRecord.source === "herdr") {
      command.besidePane = root.selectedPane
    }
    send(command)
  }

  function sendText(text) {
    if (selectedPane === "") return
    send({ type: "type", text: text })
  }

  function sendKey(key) {
    if (selectedPane === "") return
    send({ type: "keys", keys: [key] })
  }

  // A click on the grid, as a press and a release together, because that is
  // what a click is to the program reading it. The sidecar drops both unless
  // something over there is tracking the mouse.
  function clickPane(column, row) {
    if (selectedPane === "") return
    send({ type: "click", column: column, row: row, pressed: true })
    send({ type: "click", column: column, row: row, pressed: false })
  }

  /**
   * Write the list of machines back into the shell's own settings.
   *
   * The same file this plugin is configured in, so a machine added here is
   * there next time and is what the settings screen shows. A shell that does
   * not offer this says so rather than appearing to save.
   */
  function persistHosts(aliases) {
    if (!bar || !bar.shell || typeof bar.shell.updateEntryInline !== "function") {
      root.lastError = "This shell will not let a plugin save its own settings. "
        + "Add machines in Setup, Plugins, Muqun."
      return
    }
    bar.shell.updateEntryInline(moduleName, { id: moduleName, hosts: aliases.join(":") })
  }

  function addHost(alias) {
    var wanted = String(alias).trim()
    if (wanted === "" || hostAliases.indexOf(wanted) >= 0) return
    persistHosts(hostAliases.concat([wanted]))
  }

  function removeHost(alias) {
    var kept = hostAliases.filter(function(entry) { return entry !== alias })
    if (kept.length === hostAliases.length) return
    if (selectedAlias === alias) {
      root.selectedAlias = ""
      root.selectedPane = ""
      root.screenRows = []
    }
    persistHosts(kept)
  }

  onHostAliasesChanged: if (sidecarReady) publishHosts()

  // The sidecar runs while the window is open, and for as long as the bar wants
  // a badge. Closing the window does not stop it: the badge is the point.
  Process {
    id: sidecarProcess
    running: root.hostAliases.length > 0
    // Without this the process gets no stdin and every command written to it is
    // dropped in silence: the panel looks attached, the sidecar was never asked
    // for anything, and nothing anywhere says so.
    stdinEnabled: true
    command: ["bun", "run", root.pluginDir + "/backend/interface/main.ts"]
    // Whatever the sidecar says that is not a protocol line. Without this it
    // goes nowhere: a command it could not read, a layer that failed to build,
    // a crash on the way up, all silent, with the panel waiting on a reply that
    // was never going to come.
    stderr: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (line.trim() === "") return
        console.warn("muqun sidecar:", line)
      }
    }
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (line.trim() === "") return
        var event
        try {
          event = JSON.parse(line)
        } catch (error) {
          return
        }
        if (event.type === "ready") {
          root.sidecarReady = true
          root.publishHosts()
          root.syncSimfarm()
          return
        }
        if (event.type === "hosts") {
          list.pulsePanes = root.newlyBlocked(root.hosts, event.hosts)
          // A snapshot that says nothing new would still rebuild every row in
          // the list, so one that reads the same is not taken.
          if (JSON.stringify(root.hosts) !== JSON.stringify(event.hosts)) {
            root.hosts = event.hosts
          }
          root.attention = event.attention
          if (root.selectedPane === "") root.selectMostUrgent()
          return
        }
        if (event.type === "screen") {
          // Normally the panel already knows which pane it asked for. The one
          // exception is a terminal it asked the far side to make, whose name
          // only exists once it exists -- so for that one screen, the sidecar
          // says what is attached and the panel follows.
          var mine = event.alias === root.selectedAlias
            && event.paneId === root.selectedPane
          if (!mine && !root.adoptNextPane) return
          root.adoptNextPane = false
          root.pendingNote = ""
          // A screen arriving is the pane opening; whatever went wrong before
          // is over, and a message about it left standing would be about a
          // pane that is plainly working.
          if (event.full) root.lastError = ""
          root.applyScreen(event)
          if (!mine) {
            root.repoContext = null
            root.selectedAlias = event.alias
            root.selectedPane = event.paneId
            // A terminal somebody just asked for is the one they want to type
            // in. Picking a pane in the list hands the keyboard over at the
            // click; this one cannot, because until this frame there was no
            // pane to hand it to and the input is disabled while nothing is
            // selected. So it is handed over here, once there is.
            Qt.callLater(function() { surface.focusInput() })
          }
          return
        }
        if (event.type === "context") {
          if (event.alias !== root.selectedAlias || event.paneId !== root.selectedPane) return
          root.repoContext = event.context
          return
        }
        if (event.type === "simulators") {
          root.simfarmDevices = event.devices
          root.simfarmOpenUrl = event.openUrl
          // Show something without being asked: the first booted device, but
          // only until the person picks one for themselves.
          if (root.simfarmDevice === "") {
            for (var i = 0; i < event.devices.length; i++) {
              if (!event.devices[i].booted) continue
              root.showDevice(event.devices[i].id)
              break
            }
          }
          return
        }
        if (event.type === "simulatorFrame") {
          root.simfarmFramePath = event.path
          root.simfarmFrameRevision = event.revision
          return
        }
        if (event.type === "simulatorsUnreachable") {
          root.simfarmDevices = []
          root.simfarmFramePath = ""
          return
        }
        if (event.type === "error") {
          root.lastError = event.message
          root.pendingNote = ""
        }
      }
    }
    onExited: function(code) {
      root.sidecarReady = false
      if (code !== 0) root.lastError = "the sidecar stopped (exit " + code + ")"
    }
  }

  /** The panes that are waiting now and were not in the snapshot before. */
  function newlyBlocked(before, after) {
    var was = {}
    for (var h = 0; h < before.length; h++) {
      for (var p = 0; p < before[h].panes.length; p++) {
        var pane = before[h].panes[p]
        was[before[h].alias + "\u0000" + pane.id] = pane.status
      }
    }
    var fresh = []
    for (var i = 0; i < after.length; i++) {
      for (var j = 0; j < after[i].panes.length; j++) {
        var now = after[i].panes[j]
        if (now.status !== "blocked") continue
        if (was[after[i].alias + "\u0000" + now.id] === "blocked") continue
        fresh.push(now.id)
      }
    }
    return fresh
  }

  // The number on the bar gives one beat when it goes up. Down is relief and
  // needs no announcing.
  property int seenAttention: 0
  onAttentionChanged: {
    if (attention > seenAttention) badgePulse.restart()
    seenAttention = attention
  }

  function selectMostUrgent() {
    var best = null
    var bestAlias = ""
    var order = ["blocked", "working", "done", "idle", "unknown"]
    for (var h = 0; h < hosts.length; h++) {
      for (var p = 0; p < hosts[h].panes.length; p++) {
        var pane = hosts[h].panes[p]
        if (!pane.agent) continue
        if (best === null || order.indexOf(pane.status) < order.indexOf(best.status)) {
          best = pane
          bestAlias = hosts[h].alias
        }
      }
    }
    if (best !== null) attachPane(bestAlias, best.id)
  }

  function markFor(status) {
    if (status === "blocked") return "●"
    if (status === "working") return "◐"
    if (status === "done") return "✓"
    if (status === "idle") return "·"
    return " "
  }

  function markColor(status) {
    if (status === "blocked") return Color.urgent
    if (status === "working") return Color.accent
    if (status === "done") return Color.foreground
    return Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.35)
  }

  AnsiPalette { id: ansi }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  visible: hostAliases.length > 0

  // The connection lives as long as the window does.
  //
  // A closed window is not watching anything, and an attached pane is a held
  // ssh channel and, on herdr, a terminal taken from whoever else had it. So
  // closing lets go and opening picks the same pane up again. The badge does
  // not depend on this: what counts agents is a separate watch that stays.
  onOpenedChanged: {
    if (opened) {
      if (selectedPane !== "") attachPane(selectedAlias, selectedPane)
      Qt.callLater(function() { surface.focusInput() })
      return
    }
    if (simfarmOpen) simfarmOpen = false
    root.screenRows = []
    send({ type: "detach" })
  }

  // One place that says what the sidecar should be holding, called from every
  // event that could change the answer. Hanging the request off a single
  // property change was wrong: a sidecar that restarted, or a window reopened
  // with the strip already out, left the far side holding nothing.
  function syncSimfarm() {
    if (!sidecarReady) return
    if (!simfarmOpen || simfarmUrl === "") {
      send({ type: "simulators", url: "", sshHost: "", localPort: 0 })
      return
    }
    send({
      type: "simulators",
      url: simfarmUrl,
      sshHost: simfarmSshHost,
      localPort: simfarmLocalPort,
      deviceId: simfarmDevice
    })
  }

  onSimfarmOpenChanged: {
    if (!simfarmOpen) {
      root.simfarmDevices = []
      root.simfarmDevice = ""
      root.simfarmFramePath = ""
    }
    syncSimfarm()
  }

  /**
   * The address the simulator farm is configured at, in short.
   *
   * Shown when nothing answers, because "nothing is answering" is only useful
   * next to where it was looked for.
   */
  readonly property string simfarmAddress: {
    var url = simfarmUrl
    if (url === "") return ""
    return url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  }

  /**
   * The port the farm is configured at.
   *
   * Taken from the address rather than kept beside it, so the server cannot be
   * started on one port and looked for on another. simfarm's own default is
   * 8801 and so is this, which is why an address with no port still works.
   */
  readonly property int simfarmPort: {
    var match = /:(\d+)/.exec(simfarmAddress)
    return match ? parseInt(match[1], 10) : 8801
  }

  /**
   * What starts it, on the machine it should be running on.
   *
   * `--host 0.0.0.0` because the point is to reach it from here, and the port
   * is the configured one. iOS and Android are what this panel shows.
   */
  readonly property string simfarmCommand:
    "npx simfarm --providers ios,android --host 0.0.0.0 --port " + simfarmPort

  /** Which machine to start it on: the one it tunnels through, else this one. */
  readonly property string simfarmMachine:
    simfarmSshHost !== "" ? simfarmSshHost : (currentHost ? currentHost.alias : "")

  // Switching device reopens the socket against the new one, which is what
  // detaches the old stream without a second command for it.
  function showDevice(deviceId) {
    if (deviceId === root.simfarmDevice) return
    root.simfarmDevice = deviceId
    root.simfarmFramePath = ""
    syncSimfarm()
  }

  // The mark itself, read once.
  //
  // It is drawn with a white fill, which is a placeholder: the fill is replaced
  // with the bar's own colour before Qt is given the picture. That is what lets
  // one drawing work in a light theme and a dark one, the way every other icon
  // up there does, instead of carrying a background of its own.
  property string markSvg: ""

  FileView {
    id: markFile
    path: root.pluginDir + "/assets/pocket.svg"
    blockLoading: true
    onLoaded: root.markSvg = text()
  }

  function markSource(color) {
    if (markSvg === "") return ""
    return "data:image/svg+xml;utf8,"
      + encodeURIComponent(markSvg.replace("#ffffff", String(color)))
  }

  // The mark, and a count only when there is something to count.
  //
  // A drawing rather than a glyph, because this one is ours: the character the
  // phone app is named after, traced flat so it reads at bar size.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    fontSize: Style.bar.iconFont
    horizontalMargin: 6
    // This button paints text; this one paints a picture, so the label is
    // turned off and the button is told there is still something to show.
    labelVisible: false
    hasVisualContent: true
    fixedWidth: mark.implicitWidth + Style.spaceReal(12)
    dimmed: root.attention === 0
    tooltipText: root.tooltip()
    onPressed: function() { root.toggle() }

    Behavior on fixedWidth {
      NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
    }

    SequentialAnimation {
      id: badgePulse
      NumberAnimation {
        target: mark; property: "scale"; to: 1.25
        duration: 110; easing.type: Easing.OutCubic
      }
      NumberAnimation {
        target: mark; property: "scale"; to: 1
        duration: 260; easing.type: Easing.OutBack
      }
    }

    // A little under the size the bar's other icons are set in. A glyph draws
    // its ink inside its em with room above and below; this drawing fills its
    // whole box, so matching the numbers made it the largest thing up there.
    readonly property real markSize: Math.round(Style.bar.iconFont * 0.95)

    Row {
      id: mark
      anchors.centerIn: parent
      spacing: Style.space(4)
      transformOrigin: Item.Center

      Item {
        width: button.markSize
        height: button.markSize
        anchors.verticalCenter: parent.verticalCenter

        Image {
          id: pocket
          anchors.fill: parent
          // The colour is written into the drawing rather than laid over it.
          // Tinting a picture through a shader is the usual way and it is one
          // more thing that has to be supported wherever this runs; the mark is
          // a single shape, so substituting its fill and handing Qt the result
          // gives the exact colour with nothing in the way.
          source: root.markSource(
            root.attention > 0 ? button.activeColor : button.foreground)
          // Decoded at physical pixels, or a HiDPI bar gets a picture drawn for
          // a fraction of the dots it has.
          sourceSize.width: Math.round(width * Screen.devicePixelRatio)
          sourceSize.height: Math.round(height * Screen.devicePixelRatio)
          fillMode: Image.PreserveAspectFit
          smooth: true
        }
      }

      // A number that is almost always zero teaches people to stop reading it,
      // so there is no number until there is one.
      Text {
        textFormat: Text.PlainText
        anchors.verticalCenter: parent.verticalCenter
        opacity: root.attention > 0 ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: 140 } }
        text: root.attention
        color: button.activeColor
        font.family: button.fontFamily
        font.pixelSize: Style.bar.iconFont
        renderType: Text.NativeRendering
      }
    }
  }

  function tooltip() {
    if (!sidecarReady) return "Muqun — starting"
    if (hosts.length === 0) return "Muqun — no hosts set"
    var lines = []
    for (var h = 0; h < hosts.length; h++) {
      var host = hosts[h]
      if (host.state === "offline") {
        lines.push(host.label + " — offline")
        continue
      }
      if (host.state === "error") {
        lines.push(host.label + " — " + (host.error || "not answering"))
        continue
      }
      var waiting = 0
      var agents = 0
      for (var p = 0; p < host.panes.length; p++) {
        if (!host.panes[p].agent) continue
        agents++
        if (host.panes[p].status === "blocked") waiting++
      }
      lines.push(host.label + " — " + agents + " agents, " + waiting + " waiting")
    }
    return lines.join("\n")
  }

  FloatingWindow {
    id: window
    title: "Muqun"
    color: Color.popups.background
    // Big by default, as a share of the screen rather than a number of pixels.
    // This is a window you read for a minute and work in; the first thing
    // anyone did with a small one was drag it bigger, and a fixed size is the
    // wrong size on every display but the one it was picked on.
    implicitWidth: sizedWidth > 0 ? sizedWidth : root.preferredWidth(root.screenWidth)
    implicitHeight: sizedHeight > 0 ? sizedHeight : root.preferredHeight(root.screenHeight)
    minimumSize: Qt.size(640, 420)
    visible: root.opened

    /** The size once the screen it opened on is known. Zero until then. */
    property int sizedWidth: 0
    property int sizedHeight: 0

    // The size above is a share of the first screen the shell knows about,
    // which is all there is to go on before the window exists. Once it does
    // exist it knows its own screen, and on a laptop with a monitor beside it
    // those are not the same size. Done once, so resizing it by hand sticks.
    Item { id: onScreen }

    onVisibleChanged: {
      if (!visible) {
        if (root.opened) root.close()
        return
      }
      if (sizedWidth === 0 && onScreen.Screen.width > 0) {
        sizedWidth = root.preferredWidth(onScreen.Screen.width)
        sizedHeight = root.preferredHeight(onScreen.Screen.height)
      }
      Qt.callLater(function() { surface.focusInput() })
    }

    FocusScope {
      anchors.fill: parent
      focus: true

      Keys.onEscapePressed: root.close()

      // One header band across the whole window, so the three columns start at
      // the same line and each one says what it is. Before this the host name,
      // its capabilities and the pane title were crowded into one row and the
      // simulators had no label at all.
      Item {
        id: header
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(38)

        Text {
          id: hostName
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.leftMargin: Style.space(16)
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(Style.space(90), body.listReserve - Style.space(16))
          text: root.currentHost ? root.currentHost.label : "Muqun"
          color: nameHover.hovered ? Color.accent : Color.popups.text
          font.family: root.mono
          font.pixelSize: Style.font.title
          elide: Text.ElideRight

          Behavior on color { ColorAnimation { duration: 120 } }

          // The name of the machine is also the way back to the list of them.
          // A settings button would be one more thing in a header that already
          // has three, for something people reach for twice.
          HoverHandler { id: nameHover; cursorShape: Qt.PointingHandCursor }
          TapHandler {
            onTapped: {
              root.setupOpen = !root.setupOpen
              if (!root.setupOpen) surface.focusInput()
            }
          }
        }

        // The pane's name, and beside it where its work lives. The name takes
        // what it needs and the chips take what is left, up to the machine's
        // own facts on the right; a long name gives way before the chips do,
        // because a name that is elided is still recognisable and a chip that
        // is elided is not a link anyone can read.
        Item {
          id: titleRow
          anchors.left: parent.left
          anchors.leftMargin: Style.space(16) + hostName.width + Style.space(16)
          anchors.right: hostNote.visible ? hostNote.left : simfarmToggle.left
          anchors.rightMargin: Style.space(16)
          anchors.top: parent.top
          anchors.bottom: parent.bottom

          readonly property real chipsWidth: contextStrip.visible
            ? contextStrip.implicitWidth + Style.space(14) : 0

          Text {
            id: paneTitle
            textFormat: Text.PlainText
            anchors.left: parent.left
            // On the host name's baseline. It is not a sibling any more, so
            // the line is computed rather than anchored: this row starts at
            // the header's top, so the header's coordinates are this row's.
            y: hostName.y + hostName.baselineOffset - baselineOffset
            width: Math.max(Style.space(60),
                            Math.min(implicitWidth, titleRow.width - titleRow.chipsWidth))
            text: root.showSetup
              ? ""
              : root.selectedPaneRecord
                ? root.selectedPaneRecord.title
                : "Nothing selected"
            color: Color.popups.text
            font.family: root.mono
            font.pixelSize: Style.font.subtitle
            elide: Text.ElideRight

            // A new name settles in rather than replacing the old one in place.
            onTextChanged: titleIn.restart()
            NumberAnimation {
              id: titleIn
              target: paneTitle; property: "opacity"; from: 0.3; to: 1
              duration: 200; easing.type: Easing.OutCubic
            }
          }

          ContextStrip {
            id: contextStrip
            anchors.left: paneTitle.right
            anchors.leftMargin: Style.space(14)
            anchors.verticalCenter: parent.verticalCenter
            height: parent.height
            fontFamily: root.mono
            context: root.showSetup ? null : root.repoContext
            onOpened: function(url) { root.openLink(url) }
          }
        }

        // What the host turned out to have, or why it cannot be read. Words
        // with spaces between them: they are facts about the machine, not
        // controls, and a string joined with punctuation is chrome.
        Text {
          id: hostNote
          textFormat: Text.PlainText
          anchors.right: simfarmToggle.left
          anchors.rightMargin: Style.space(16)
          anchors.baseline: hostName.baseline
          visible: root.currentHost !== null && root.simfarmOpen === false
          text: root.hostNote(root.currentHost)
          color: list.muted
          font.family: root.mono
          font.pixelSize: Style.font.caption
        }

        // What you can do to what is on screen, in the order they are reached
        // for: open one, close one, show the phones.
        Row {
          id: simfarmToggle
          anchors.right: parent.right
          anchors.rightMargin: Style.space(16)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(16)

          // Opening a terminal and closing one both live in the list, over the
          // section they act on. Up here they were two small marks a hand's
          // width from the window's own close button, which is a bad place to
          // put a thing that takes a pane down.

          // U+F013 is the Nerd Font gear. What this window does not offer --
          // the simulator address, the tunnel -- lives in the shell's own
          // configuration, and this opens that file in the editor Omarchy is
          // set to use. Machines are not in there: they are in the window.
          IconAction {
            text: ""
            fontFamily: root.mono
            hint: "Settings"
            onActivated: root.openSettings()
          }

          // U+F08E is the Nerd Font "open in a new window" arrow. The farm's
          // own web page, for what the strip does not do. It lived at the foot
          // of the strip as two words under the device's buttons, where it
          // read as one more button; it is a way out of this window, so it
          // sits with the other things that are.
          IconAction {
            text: ""
            fontFamily: root.mono
            hint: "Open in browser"
            visible: root.simfarmOpen && root.simfarmOpenUrl !== ""
            onActivated: root.openSimfarm()
          }

          // U+F10B is the Nerd Font phone glyph, written as an escape because a
          // raw private-use character does not reliably survive being edited.
          IconAction {
            text: ""
            fontFamily: root.mono
            hint: "Simulators"
            on: root.simfarmOpen
            visible: root.simfarmUrl !== ""
            onActivated: root.simfarmOpen = !root.simfarmOpen
          }
        }
      }

      Frame {
        id: headerSeam
        anchors.top: header.bottom
        anchors.left: parent.left
        anchors.right: parent.right
      }

      // The three columns, top-aligned, divided by seams rather than by
      // guesswork about where one ends.
      Item {
        id: body
        anchors.top: headerSeam.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom

        /**
         * How much of the window the simulator strip and its seam have taken.
         *
         * One animated number that everything on the right reads, rather than
         * each piece deciding for itself whether the strip is open. Switching
         * the terminal's anchor the moment the strip appeared resized it in one
         * step while the strip slid in over a fifth of a second, and a resize
         * is what reopens the terminal on the other machine -- so opening the
         * simulators blanked the terminal beside them.
         */
        property real stripReserve: root.simfarmOpen
          ? Math.round(width * root.simfarmShare) + Style.space(24)
          : 0
        readonly property real stripWidth: Math.max(0, stripReserve - Style.space(24))

        Behavior on stripReserve {
          NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
        }

        /**
         * The same number for the pane list, so it can slide away too.
         *
         * Nothing on the first run: a column of nothing is not worth a fifth of
         * the window, and the form beside it wants the room.
         */
        property real listReserve: root.listOpen && root.hostAliases.length > 0
          ? Math.round(width * root.listShare) + Style.space(12)
          : 0
        readonly property real listWidth: Math.max(0, listReserve - Style.space(24))

        Behavior on listReserve {
          NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
        }

        HostList {
          id: list
          x: Style.space(12)
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: Style.space(12)
          anchors.bottomMargin: Style.space(12)
          width: body.listWidth
          visible: width > 0
          clip: true
          hosts: root.hosts
          fontFamily: root.mono
          selectedAlias: root.selectedAlias
          selectedPane: root.selectedPane
          markFor: root.markFor
          markColor: root.markColor
          onPanePicked: function(alias, paneId) {
            root.setupOpen = false
            root.attachPane(alias, paneId)
            surface.focusInput()
          }
          onPaneClosed: function(alias, paneId) {
            root.send({ type: "closePane", alias: alias, paneId: paneId })
            if (alias === root.selectedAlias && paneId === root.selectedPane) {
              root.selectedPane = ""
              root.screenRows = []
            }
          }
          onTerminalRequested: function(alias) { root.newTerminal(alias, "") }
          selectedSource: root.selectedPaneRecord ? root.selectedPaneRecord.source : ""
          onAgentRequested: function(alias, kind, where) { root.newAgent(alias, kind, where) }
        }

        Frame {
          id: listSeam
          vertical: true
          visible: body.listWidth > 0
          x: body.listReserve
          anchors.top: parent.top
          anchors.bottom: parent.bottom
        }

        // The seam is the handle. A separate grip would be one more thing on
        // screen saying what the seam already says, so the seam itself takes a
        // few pixels of hit area either side of its single drawn pixel.
        MouseArea {
          anchors.horizontalCenter: listSeam.horizontalCenter
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(10)
          visible: body.listWidth > 0
          cursorShape: Qt.SplitHCursor
          hoverEnabled: true

          onPositionChanged: function(mouse) {
            if (!pressed) return
            var x = mapToItem(parent, mouse.x, 0).x
            // Bounded so neither side can be dragged away entirely: the list
            // stays readable and the terminal stays a terminal.
            root.listShare = Math.max(0.12, Math.min(0.42, x / window.width))
          }
        }

        Column {
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.leftMargin: Style.space(12) + body.listReserve
          anchors.rightMargin: Style.space(12) + body.stripReserve
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: Style.space(12)
          anchors.bottomMargin: Style.space(12)
          spacing: Style.space(8)

          // The terminal, or the machine list standing in for it.
          Item {
            width: parent.width
            height: parent.height - notice.height - (notice.visible ? parent.spacing : 0)

            MachineList {
              anchors.fill: parent
              z: 1
              opacity: root.showSetup ? 1 : 0
              visible: opacity > 0
              Behavior on opacity { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }
              hosts: root.hosts
              fontFamily: root.mono
              onHostAdded: function(alias) { root.addHost(alias) }
              onHostRemoved: function(alias) { root.removeHost(alias) }
              onDismissed: {
                root.setupOpen = false
                surface.focusInput()
              }
            }

            TerminalSurface {
              id: surface
              anchors.fill: parent
              visible: !root.showSetup
              focus: true
              rows: root.screenRows
              cursor: root.screenCursor
              palette: ansi
              fontFamily: root.mono
              fontSize: Style.font.bodySmall
              connected: root.selectedPane !== ""
              pending: root.pendingNote
              onTextEntered: function(text) { root.sendText(text) }
              onKeyEntered: function(key) { root.sendKey(key) }
              onLinkActivated: function(url) { root.openLink(url) }
              onCopyRequested: function(text) { root.copyToClipboard(text) }
              onClicked: function(column, row) { root.clickPane(column, row) }
              onPasteRequested: root.pasteFromClipboard()
              onListToggled: root.listOpen = !root.listOpen
              onSimfarmToggled: {
                if (root.simfarmUrl === "") return
                root.simfarmOpen = !root.simfarmOpen
              }
              onScrolled: function(rows, column, row) {
                if (root.selectedPane === "") return
                root.send({ type: "scroll", rows: rows, column: column, row: row })
              }
              onResized: function(rows, columns) {
                root.termRows = rows
                root.termColumns = columns
                // Only when the grid actually changed shape. The surface
                // reports a size whenever its pixels move, and telling the far
                // side means reopening the terminal there, because a pty's size
                // is fixed when it is opened. A window nudged two pixels wider
                // is the same eighty columns, and reopening for it took the
                // keyboard away mid-sentence.
                if (rows === root.sentRows && columns === root.sentColumns) return
                root.sentRows = rows
                root.sentColumns = columns
                if (root.selectedPane === "") return
                root.send({ type: "resize", rows: rows, columns: columns })
              }
            }
          }

          Text {
            id: notice
            textFormat: Text.PlainText
            width: parent.width
            clip: true
            height: root.lastError !== "" ? implicitHeight : 0
            opacity: root.lastError !== "" ? 1 : 0
            visible: height > 0
            Behavior on height { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
            Behavior on opacity { NumberAnimation { duration: 160 } }
            text: root.lastError
            // Read it, click it, it goes.
            HoverHandler { cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: root.lastError = "" }
            color: Color.urgent
            font.family: root.mono
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        Frame {
          id: stripSeam
          vertical: true
          visible: body.stripWidth > 0
          x: simfarmStrip.x - Style.space(12)
          anchors.top: parent.top
          anchors.bottom: parent.bottom
        }

        // The other seam, and the same handle. A phone is tall, so how much
        // room it gets is a thing people want to change.
        MouseArea {
          anchors.horizontalCenter: stripSeam.horizontalCenter
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(10)
          visible: body.stripWidth > 0
          cursorShape: Qt.SplitHCursor
          hoverEnabled: true

          onPositionChanged: function(mouse) {
            if (!pressed) return
            var x = mapToItem(parent, mouse.x, 0).x
            root.simfarmShare = Math.max(0.14, Math.min(0.5, 1 - x / window.width))
          }
        }

        SimfarmPanel {
          id: simfarmStrip
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: Style.space(12)
          anchors.bottomMargin: Style.space(12)
          // Placed from the right edge by hand rather than anchored to it, so
          // that it slides in and out on the same number everything else reads.
          x: body.width - Style.space(12) - body.stripWidth
          width: body.stripWidth
          visible: width > 0
          clip: true
          configured: root.simfarmUrl !== ""
          devices: root.simfarmDevices
          selectedId: root.simfarmDevice
          framePath: root.simfarmFramePath
          frameRevision: root.simfarmFrameRevision
          fontFamily: root.mono
          onDevicePicked: function(deviceId) { root.showDevice(deviceId) }
          onTapped: function(phase, x, y) {
            root.send({ type: "tap", phase: phase, x: x, y: y })
          }
          onScrolled: function(dx, dy, x, y) {
            root.send({ type: "deviceScroll", dx: dx, dy: dy, x: x, y: y })
          }
          onButtonPressed: function(button) {
            root.send({ type: "deviceButton", button: button })
          }
          startCommand: root.simfarmCommand
          shortAddress: root.simfarmAddress
          canStart: root.simfarmMachine !== ""
          onStartRequested: {
            root.newTerminal(root.simfarmMachine, root.simfarmCommand)
            root.simfarmOpen = false
          }
          onRepoRequested: root.openLink("https://github.com/BANG88/simfarm")
        }
      }
    }
  }

  Process {
    id: clipboardProcess
    command: ["wl-copy"]
    // Written to rather than quoted into a command line. Terminal output can
    // contain anything at all, and the one way to hand it over that cannot be
    // read as syntax is a pipe.
    stdinEnabled: true
  }

  function copyToClipboard(text) {
    if (text === "") return
    clipboardProcess.stdinEnabled = true
    clipboardProcess.running = true
    clipboardProcess.write(text)
    // Closing the pipe is what tells wl-copy it has the whole thing.
    clipboardProcess.stdinEnabled = false
  }

  // Pasting is asked for, not performed here.
  //
  // What the clipboard holds decides what a paste means: text is typed, and a
  // picture has to reach the machine the pane is running on before the pane can
  // be told where it is. Both are the sidecar's job, and reading the clipboard
  // in one place means it is read once.
  function pasteFromClipboard() {
    if (selectedPane === "") return
    send({ type: "pasteClipboard" })
  }

  /**
   * Whether an address is one this window will hand to the desktop.
   *
   * `xdg-open` acts on whatever it is given, and a scheme is a choice of
   * program: `file:` opens a file, and others open worse. The sidecar already
   * refuses anything that is not http or https on the way out of a pane, and
   * this refuses it again on the way in, because the two are not the same
   * boundary and a setting is not a pane.
   */
  function openable(url) {
    return /^https?:\/\//.test(String(url))
  }

  // Opening what a pane printed, or a link this window offers.
  //
  // Detached rather than run as a child of this window: what it opens outlives
  // the window, and a child would be taken down with it.
  function openLink(url) {
    if (!openable(url)) return
    Quickshell.execDetached(["xdg-open", url])
  }

  // The shell's own configuration, in whichever editor Omarchy is set to use.
  //
  // Which editor that is, and which terminal it wants, is Omarchy's answer and
  // not this plugin's: `omarchy-launch-editor` is the same path the rest of the
  // desktop takes to a config file.
  function openSettings() {
    Quickshell.execDetached(
      ["omarchy-launch-editor", Quickshell.env("HOME") + "/.config/omarchy/shell.json"])
  }

  // The device panel decodes H.264, which browsers only enable on a secure
  // origin, so opening one is a browser's job and not this window's. This only
  // hands over the address.
  function openSimfarm() {
    openLink(simfarmOpenUrl)
  }
}
