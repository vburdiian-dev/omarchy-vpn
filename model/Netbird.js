.pragma library
.import "Shared.js" as Shared

// NetBird, via the `netbird` CLI talking to its daemon over
// /var/run/netbird.sock. Parsing and row-building only — the process plumbing
// lives in NetbirdBackend.qml.
//
// NetBird is a mesh, not a pick-a-country VPN: the daemon joins whatever
// network its management server hands it. The connectable list is therefore
// the CLI's profiles — one per management server or account — and `up` /
// `down` are the whole of connecting. The socket is world-writable as the
// package installs it, so none of this needs root.

// nf-md-lan. A mesh of peers rather than an exit somewhere.
var GLYPH_NETBIRD = String.fromCodePoint(0xF0317)

// `netbird status --json` while the daemon has a config prints one object whose
// `daemonStatus` is one of the daemon's states (client/internal/state.go):
// Idle, Connecting, Connected, NeedsLogin, LoginFailed, SessionExpired.
//
// NeedsLogin and LoginFailed never reach the JSON: status.go prints a plain
// "Daemon status: NeedsLogin" paragraph and exits 0 instead, `--json` or not.
// Both shapes are read. Anything else is "no idea", not disconnected.
function parseNetbirdStatus(raw) {
  var result = {
    state: "", connected: false, daemonStatus: "",
    ip: "", fqdn: "", managementUrl: "", managementConnected: false,
    peersConnected: 0, peersTotal: 0, sessionExpiresAt: "", profile: ""
  }

  var text = String(raw || "").trim()
  var payload = netbirdJson(text)
  if (payload && typeof payload.daemonStatus === "string") {
    result.daemonStatus = payload.daemonStatus
    result.ip = String(payload.netbirdIp || "").replace(/\/\d+$/, "")
    result.fqdn = String(payload.fqdn || "")
    if (payload.management && typeof payload.management === "object") {
      result.managementUrl = String(payload.management.url || "")
      result.managementConnected = payload.management.connected === true
    }
    if (payload.peers && typeof payload.peers === "object") {
      if (typeof payload.peers.connected === "number") result.peersConnected = payload.peers.connected
      if (typeof payload.peers.total === "number") result.peersTotal = payload.peers.total
    }
    result.sessionExpiresAt = String(payload.sessionExpiresAt || "")
    result.profile = String(payload.profileName || "")
  } else {
    var match = /daemon status:\s*([A-Za-z]+)/i.exec(text)
    if (!match) return result
    result.daemonStatus = match[1]
  }

  result.state = netbirdState(result.daemonStatus)
  result.connected = result.state === "connected"
  return result
}

function netbirdJson(text) {
  if (text === "" || text.charAt(0) !== "{") return null
  try {
    var parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    return null
  }
}

function netbirdState(daemonStatus) {
  var value = String(daemonStatus || "").toLowerCase()
  if (value === "connected") return "connected"
  if (value === "connecting") return "connecting"
  if (value === "idle") return "disconnected"
  if (value === "needslogin" || value === "loginfailed" || value === "sessionexpired") return "login"
  return "unknown"
}

// `https://vpn.example.org:443` -> `vpn.example.org`.
function netbirdHost(url) {
  return String(url || "").replace(/^[a-z]+:\/\//i, "").replace(/[:\/].*$/, "")
}

// `netbird profile list` prints a header and one profile per line, the active
// one ticked:
//
//   NAME     ACTIVE
//   default  ✓
//
// Returns [{ name, active }].
function parseNetbirdProfiles(raw) {
  var profiles = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    var fields = line.split(/\s+/)
    if (fields[0] === "NAME") continue
    profiles.push({ name: fields[0], active: fields.length > 1 && fields[1] !== "" })
  }
  return profiles
}

function netbirdActiveProfile(profiles, status) {
  if (status && status.profile !== "") return status.profile
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].active) return profiles[i].name
  }
  return ""
}

// One row per profile. Only the active one's management server is known
// without switching to it, so the others say nothing beyond their name.
function netbirdTargets(profiles, status) {
  var active = netbirdActiveProfile(profiles, status)
  var host = netbirdHost(status ? status.managementUrl : "")
  var list = profiles.length > 0 ? profiles : (active !== "" ? [{ name: active, active: true }] : [])
  return list.map(function(profile) {
    var isActive = profile.name === active
    return {
      key: "profile:" + profile.name,
      label: profile.name,
      detail: isActive && host !== "" ? host : "NetBird profile",
      glyph: GLYPH_NETBIRD,
      args: [profile.name]
    }
  })
}

function netbirdCurrentKey(profiles, status) {
  if (!status || (status.state !== "connected" && status.state !== "connecting")) return ""
  var active = netbirdActiveProfile(profiles, status)
  return active === "" ? "" : "profile:" + active
}

// The commands that bring `target` up: switching profile first when it is not
// the active one, which the daemon only accepts with the tunnel down.
function netbirdConnectPlan(profiles, status, target) {
  var wanted = target && target.args && target.args.length > 0 ? String(target.args[0]) : ""
  var active = netbirdActiveProfile(profiles, status)
  if (wanted === "" || wanted === active) return [["up"]]
  var plan = []
  if (status && status.state !== "disconnected" && status.state !== "") plan.push(["down"])
  plan.push(["profile", "select", wanted])
  plan.push(["up"])
  return plan
}

// Stable while connected — the controller refetches the public IP whenever this
// changes, so peer counts stay out of it.
function netbirdSummary(status) {
  if (status.state === "connected") {
    var host = netbirdHost(status.managementUrl)
    return host !== "" ? host : (status.ip !== "" ? status.ip : "Connected")
  }
  if (status.state === "connecting") return "Connecting…"
  if (status.state === "disconnected") return "Not connected"
  if (status.state === "login") {
    if (/expired/i.test(status.daemonStatus)) return "Session expired"
    return "Login required"
  }
  if (status.state === "unknown") return status.daemonStatus
  return "Checking…"
}

// "in 23h 58m", or "" when the daemon gave no expiry (SSO off, or never).
function netbirdExpiry(iso, nowMs) {
  var at = Date.parse(String(iso || ""))
  if (!isFinite(at) || at <= 0) return ""
  var minutes = Math.round((at - nowMs) / 60000)
  if (minutes <= 0) return "expired"
  var days = Math.floor(minutes / 1440)
  var hours = Math.floor((minutes % 1440) / 60)
  var mins = minutes % 60
  if (days > 0) return "in " + days + "d " + hours + "h"
  if (hours > 0) return "in " + hours + "h " + mins + "m"
  return "in " + mins + "m"
}

function netbirdDetails(status, nowMs) {
  if (status.state !== "connected") return []
  var rows = []
  rows.push(Shared.detail("NetBird IP", status.ip))
  rows.push(Shared.detail("Name", status.fqdn))
  if (status.peersTotal > 0) rows.push(Shared.detail("Peers", status.peersConnected + " of " + status.peersTotal + " connected"))
  rows.push(Shared.detail("Management", netbirdHost(status.managementUrl) + (status.managementConnected ? "" : " (unreachable)")))
  rows.push(Shared.detail("Session expires", netbirdExpiry(status.sessionExpiresAt, nowMs)))
  return rows.filter(function(row) { return row.value !== "" })
}

// The CLI could not reach the daemon: the service is stopped or not installed.
// netbird 0.81 says "failed to connect to daemon error: … connection refused"
// or "… no such file or directory" depending on whether the socket exists.
function netbirdDaemonUnreachable(output) {
  return /failed to connect to daemon|connection refused|netbird\.sock: connect/i.test(String(output || ""))
}

var NETBIRD_SETUP = {
  service: {
    command: "sudo netbird service install; sudo netbird service start",
    hint: "NetBird: start its daemon with sudo netbird service start",
    failure: "The NetBird daemon is not running. Start it with: sudo netbird service start"
  },
  login: {
    command: "netbird up",
    failure: "NetBird needs you to log in: run netbird up in a terminal"
  }
}

// What keeps an installed netbird from being `detected`. A daemon that answered
// once stays detected, so a hiccup surfaces as an error on its chip instead.
function netbirdSetupState(probe) {
  if (!probe || !probe.present || probe.reachable) return ""
  return probe.daemonDown ? "service" : ""
}

function netbirdSetupHint(probe) {
  var state = netbirdSetupState(probe)
  return state === "" ? "" : NETBIRD_SETUP[state].hint
}

function netbirdSetupCommand(probe) {
  var state = netbirdSetupState(probe)
  return state === "" ? "" : NETBIRD_SETUP[state].command
}

function describeNetbirdFailure(output, fallback) {
  var text = String(output || "").trim()
  if (netbirdDaemonUnreachable(text)) return NETBIRD_SETUP.service.failure
  if (/needslogin|login required|sso|session expired|unauthenticated/i.test(text)) return NETBIRD_SETUP.login.failure
  return Shared.elide(text || fallback, 140)
}
