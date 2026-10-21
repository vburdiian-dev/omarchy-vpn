// NetBird: `netbird status --json` and `netbird profile list`, and the rows
// built from them. The connected payload is real netbird 0.81.3 output, cut to
// two peers and with keys shortened.
const { test, eq, Netbird } = require("../harness.js")

const CONNECTED = `{"peers":{"total":10,"connected":0,"details":[{"fqdn":"iphone.netbird.selfhosted","netbirdIp":"100.122.9.90","status":"Idle"},{"fqdn":"home.netbird.selfhosted","netbirdIp":"100.122.201.211","status":"Idle"}]},"cliVersion":"0.81.3","daemonVersion":"0.81.3","daemonStatus":"Connected","management":{"url":"https://vpn.capturecore.org:443","connected":true,"error":""},"signal":{"url":"https://vpn.capturecore.org:443","connected":true,"error":""},"netbirdIp":"100.122.1.213/16","fqdn":"omarchy.netbird.selfhosted","lazyConnectionEnabled":true,"profileName":"default","sessionExpiresAt":"2026-10-22T16:34:21.988780735Z"}`

const IDLE = `{"peers":{"total":0,"connected":0,"details":[]},"daemonStatus":"Idle","management":{"url":"","connected":false,"error":""},"netbirdIp":"","fqdn":"","profileName":"default","sessionExpiresAt":""}`

// What status.go prints for NeedsLogin instead of JSON, `--json` or not.
const NEEDS_LOGIN = `Daemon status: NeedsLogin

Run UP command to log in with SSO (interactive login):

 netbird up
`

const PROFILES = "NAME     ACTIVE\ndefault  ✓\nwork\n"

test("parseNetbirdStatus reads a connected payload", () => {
  const status = Netbird.parseNetbirdStatus(CONNECTED)
  eq(status.state, "connected")
  eq(status.connected, true)
  eq(status.ip, "100.122.1.213")
  eq(status.fqdn, "omarchy.netbird.selfhosted")
  eq(status.managementConnected, true)
  eq(status.peersTotal, 10)
  eq(status.peersConnected, 0)
  eq(status.profile, "default")
})

test("parseNetbirdStatus reads Idle as disconnected", () => {
  const status = Netbird.parseNetbirdStatus(IDLE)
  eq(status.state, "disconnected")
  eq(status.connected, false)
})

test("parseNetbirdStatus reads the plain-text NeedsLogin answer", () => {
  const status = Netbird.parseNetbirdStatus(NEEDS_LOGIN)
  eq(status.state, "login")
  eq(Netbird.netbirdSummary(status), "Login required")
})

test("parseNetbirdStatus treats unparseable output as no idea", () => {
  eq(Netbird.parseNetbirdStatus("").state, "")
  eq(Netbird.parseNetbirdStatus("{not json").state, "")
  eq(Netbird.parseNetbirdStatus("failed to connect to daemon error: context deadline exceeded").state, "")
})

test("netbirdSummary names the management host and stays free of peer counts", () => {
  eq(Netbird.netbirdSummary(Netbird.parseNetbirdStatus(CONNECTED)), "vpn.capturecore.org")
  eq(Netbird.netbirdSummary(Netbird.parseNetbirdStatus(IDLE)), "Not connected")
})

test("parseNetbirdProfiles skips the header and reads the tick", () => {
  eq(Netbird.parseNetbirdProfiles(PROFILES), [
    { name: "default", active: true },
    { name: "work", active: false }
  ])
})

test("netbirdTargets lists profiles and marks the connected one current", () => {
  const status = Netbird.parseNetbirdStatus(CONNECTED)
  const profiles = Netbird.parseNetbirdProfiles(PROFILES)
  const targets = Netbird.netbirdTargets(profiles, status)
  eq(targets.map(t => t.key), ["profile:default", "profile:work"])
  eq(targets[0].detail, "vpn.capturecore.org")
  eq(Netbird.netbirdCurrentKey(profiles, status), "profile:default")
  eq(Netbird.netbirdCurrentKey(profiles, Netbird.parseNetbirdStatus(IDLE)), "")
})

test("netbirdTargets falls back to the status profile when the list is unread", () => {
  const targets = Netbird.netbirdTargets([], Netbird.parseNetbirdStatus(CONNECTED))
  eq(targets.map(t => t.key), ["profile:default"])
})

test("netbirdConnectPlan only switches profile when it has to", () => {
  const profiles = Netbird.parseNetbirdProfiles(PROFILES)
  const up = Netbird.parseNetbirdStatus(CONNECTED)
  const idle = Netbird.parseNetbirdStatus(IDLE)
  eq(Netbird.netbirdConnectPlan(profiles, idle, { args: ["default"] }), [["up"]])
  eq(Netbird.netbirdConnectPlan(profiles, idle, { args: ["work"] }), [["profile", "select", "work"], ["up"]])
  eq(Netbird.netbirdConnectPlan(profiles, up, { args: ["work"] }), [["down"], ["profile", "select", "work"], ["up"]])
})

test("netbirdDetails shows address, peers and expiry while connected", () => {
  const status = Netbird.parseNetbirdStatus(CONNECTED)
  const now = Date.parse("2026-10-21T16:36:00Z")
  eq(Netbird.netbirdDetails(status, now), [
    { label: "NetBird IP", value: "100.122.1.213" },
    { label: "Name", value: "omarchy.netbird.selfhosted" },
    { label: "Peers", value: "0 of 10 connected" },
    { label: "Management", value: "vpn.capturecore.org" },
    { label: "Session expires", value: "in 23h 58m" }
  ])
  eq(Netbird.netbirdDetails(Netbird.parseNetbirdStatus(IDLE), now), [])
})

test("setup hint asks for the daemon only when it never answered", () => {
  eq(Netbird.netbirdSetupHint({ present: false }), "")
  eq(Netbird.netbirdSetupHint({ present: true, reachable: true, daemonDown: true }), "")
  eq(Netbird.netbirdSetupCommand({ present: true, reachable: false, daemonDown: true }),
    "sudo netbird service install; sudo netbird service start")
})

test("describeNetbirdFailure recognises a stopped daemon", () => {
  eq(Netbird.describeNetbirdFailure("failed to connect to daemon error: dial unix /var/run/netbird.sock: connect: connection refused", "x"),
    "The NetBird daemon is not running. Start it with: sudo netbird service start")
  eq(Netbird.describeNetbirdFailure("", "NetBird command failed"), "NetBird command failed")
})
