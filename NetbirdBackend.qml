import QtQuick
import Quickshell.Io
import "model/Shared.js" as Shared
import "model/Netbird.js" as Netbird

// NetBird backend, driven by the `netbird` CLI talking to its daemon.
// Implements the backend contract documented in VpnController.qml.
//
// The targets are the CLI's profiles, and connecting is `netbird up`. When the
// daemon needs an SSO login, `up` opens the browser itself and blocks until the
// login lands, so the panel shows "Connecting…" for as long as that takes.
Item {
  id: root
  visible: false

  property var settings: ({})
  property string filter: ""

  readonly property string backendId: "netbird"
  readonly property string label: "NetBird"
  readonly property var installNames: ["NetBird"]
  readonly property string glyph: Netbird.GLYPH_NETBIRD
  readonly property bool supportsFilter: false
  readonly property string filterPlaceholder: ""

  property var status: Netbird.parseNetbirdStatus("")
  property var profiles: []
  property string actionStatus: ""
  property string lastError: ""

  property bool _present: false
  property bool _probed: false
  // Sticky once the daemon answered: a later hiccup is an error on the chip,
  // not a reason to make the chip vanish.
  property bool _reachable: false
  property bool _daemonDown: false

  readonly property bool detected: _present && _reachable

  readonly property var _probe: ({ present: _present, reachable: _reachable, daemonDown: _daemonDown })
  readonly property string setupHint: Netbird.netbirdSetupHint(_probe)
  readonly property string setupCommand: Netbird.netbirdSetupCommand(_probe)

  // -1 follows the daemon, 0/1 while an up/down is in flight.
  property int _desired: -1
  property var _queue: []

  readonly property bool connected: _desired === -1 ? status.connected : (_desired === 1)
  readonly property bool _working: commandProcess.running || chainTimer.running || _queue.length > 0
  readonly property bool busy: _working || statusProcess.running
  readonly property string summary: Netbird.netbirdSummary(status)
  readonly property var details: Netbird.netbirdDetails(status, Date.now())
  readonly property var targets: Netbird.netbirdTargets(profiles, status)
  readonly property string currentKey: Netbird.netbirdCurrentKey(profiles, status)
  readonly property string emptyText: "No NetBird profile. Run netbird up --management-url <url> in a terminal."

  function detect(force) {
    if (presenceProcess.running || probeProcess.running) return
    if (_probed && force !== true) return
    presenceProcess.running = true
  }

  function refresh() {
    if (!detected || statusProcess.running) return
    statusProcess.running = true
    if (!profileProcess.running) profileProcess.running = true
  }

  function connectTo(target) {
    if (!detected || _working || !target) return
    start(1, "Connecting to " + target.label + "…", Netbird.netbirdConnectPlan(profiles, status, target))
  }

  function disconnect() {
    if (!detected || _working) return
    start(0, "Disconnecting…", [["down"]])
  }

  function toggleConnection() {
    if (connected) {
      disconnect()
      return
    }
    if (!detected || _working) return
    start(1, "Connecting…", [["up"]])
  }

  function start(desired, message, plan) {
    _desired = desired
    lastError = ""
    actionStatus = message
    _queue = plan.slice(1)
    runCommand(plan[0])
  }

  function runCommand(args) {
    commandProcess.command = ["netbird"].concat(args)
    commandProcess.running = true
  }

  function applyStatus(raw) {
    var parsed = Netbird.parseNetbirdStatus(raw)
    // An answer that does not parse is not news; keep the last reading.
    if (parsed.state === "") return
    root.status = parsed
    if (_desired !== -1 && parsed.connected === (_desired === 1)) _desired = -1
  }

  // `up` returns once the engine starts, before peers and routes settle, so
  // poll for a few seconds before trusting the answer.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1000
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refresh()
      if (settleTimer.ticks >= 8) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root._desired = -1
      }
    }
  }

  // Starting the next command from inside onExited would re-enter the process
  // that is still finishing, so the chain hops through the event loop first.
  Timer {
    id: chainTimer
    interval: 0
    repeat: false
    onTriggered: {
      var next = root._queue[0]
      root._queue = root._queue.slice(1)
      root.runCommand(next)
    }
  }

  Process {
    id: presenceProcess
    command: ["omarchy-cmd-present", "netbird"]
    running: true
    onExited: function(exitCode) {
      root._present = exitCode === 0
      if (root._present) probeProcess.running = true
      else root._probed = true
    }
  }

  // Whether the daemon answers at all, and — on the way — the first status
  // reading, since the controller's refresh() for this round already returned
  // while `detected` was still false.
  Process {
    id: probeProcess
    running: false
    command: ["netbird", "status", "--json"]
    stdout: StdioCollector { id: probeStdout; waitForEnd: true }
    stderr: StdioCollector { id: probeStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._probed = true
      var output = String(probeStdout.text || "") + "\n" + String(probeStderr.text || "")
      if (exitCode === 0) {
        root._reachable = true
        root._daemonDown = false
        root.applyStatus(String(probeStdout.text || ""))
        if (!profileProcess.running) profileProcess.running = true
      } else {
        root._daemonDown = Netbird.netbirdDaemonUnreachable(output)
      }
    }
  }

  Process {
    id: statusProcess
    running: false
    command: ["netbird", "status", "--json"]
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.applyStatus(String(statusStdout.text || ""))
        if (!root._working) root.lastError = ""
        return
      }
      // Stale, not empty: say what went wrong and leave the last reading up.
      var output = String(statusStderr.text || "") + "\n" + String(statusStdout.text || "")
      root.lastError = Netbird.describeNetbirdFailure(output, "Could not read NetBird status")
    }
  }

  Process {
    id: profileProcess
    running: false
    command: ["netbird", "profile", "list"]
    stdout: StdioCollector { id: profileStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var parsed = Netbird.parseNetbirdProfiles(String(profileStdout.text || ""))
      if (parsed.length > 0) root.profiles = parsed
    }
  }

  Process {
    id: commandProcess
    running: false
    command: []
    stdout: StdioCollector { id: commandStdout; waitForEnd: true }
    stderr: StdioCollector { id: commandStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0 && root._queue.length > 0) {
        chainTimer.restart()
        return
      }

      if (exitCode !== 0) {
        var output = String(commandStderr.text || "") + "\n" + String(commandStdout.text || "")
        root._desired = -1
        root._queue = []
        root.lastError = Netbird.describeNetbirdFailure(output, "NetBird command failed")
      } else {
        root.lastError = ""
      }

      root.actionStatus = ""
      if (!profileProcess.running) profileProcess.running = true
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }
}
