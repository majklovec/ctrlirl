# GRETAP transport research & bring-up

Live investigation + fix of the GRETAP-based Ctrlink transport.
Goal: pass bigcml's home-LAN interface **`eno2`** (192.168.1.0/24) through a kernel
GRETAP tunnel to the rpi4 encoder, and make that LAN usable from the rpi4.

This file is a running log. It is updated after every significant step/finding.

## Hosts & topology

| host                       | role    | iface  | IP                                        | notes                                                |
| -------------------------- | ------- | ------ | ----------------------------------------- | ---------------------------------------------------- |
| bigcml (this box)          | relay   | `eno1` | 192.168.10.1/24                           | **rpi4-segment iface**; bigcml is the rpi4's gateway |
| bigcml                     | relay   | `eno2` | 192.168.1.136/24                          | **home LAN interface to pass through**               |
| rpi4 (`pi@192.168.10.103`) | encoder | `eth0` | 192.168.10.103/24 (DHCP, gw 192.168.10.1) | runs old pre-rename `client-arm` build               |

Key facts:

-   bigcml `eno1` = `192.168.10.1` is the rpi4's gateway → the only rpi4-reachable IP on bigcml.
-   rpi4 has **no firewall** (iptables INPUT/FORWARD/OUTPUT all ACCEPT; no ufw).
-   bigcml: `ip_forward=1`, **ufw INACTIVE**, irlctrl client NOT running. No pre-existing gretap/bridge devices (except `gre0`/`gretap0` which are DOWN leftovers).
-   rpi4's default route is `192.168.10.1` (bigcml eno1). So rpi4 reaches bigcml's `eno2` IP (192.168.1.136) via `192.168.10.1` (confirmed: `ip route get 192.168.1.136` = via 192.168.10.1, and it pings at L3).

## Root cause (code)

`ctrlink_relay/backend.ts` **creates no gretap device** on the relay side.

-   `createUdpRelay(...)` is a documented **no-op** (returns a `NoopRelay`); `relay.port` is ignored.
-   The relay only: dials the encoder WS, advertises its interfaces, and registers
    per-iface vif routes (`installVifRoute`, VIF_TABLE_BASE=200).
-   The **encoder** side (`ctrlink_streamer` → `virtual_interface.ts` `VifImpl`) IS
    implemented and creates its gretap + bridge; it is pointed at the relay's
    _advertised_ iface IP via `defaultSourceIp()`/`egressIface()`.

⇒ With no relay-side gretap, a tunnel can never form. **Fix = add relay-side
gretap+bridge in `ctrlink_relay`.**

## GRE key derivation (must match both ends)

`greKeyForEndpoints(relayIp, encIp)` (shared/lib/gretap_relay/src/gretap.ts:88):
md5(`${relayIp}|${encIp}`) → first 4 bytes BE, `& 0x7fffffff`, `% 0xFFFFFFFF` (min 1).

For this PoC: `greKeyForEndpoints("192.168.1.136","192.168.10.103")` = **7175427** (**0x6d7d03**).
Kernel keyed GRETAP demux is by (proto 47, key); outer IPs and device names may differ between ends.

## Kernel PoC (manual, matching the intended `setUpGretap` shape)

Commands used (encoder/rpi4 side):

```
ip link add gretap000 type gretap remote 192.168.1.136 local 192.168.10.103 key 7175427 ikey 7175427
ip link add br-gretap000 type bridge
ip link set gretap000 master br-gretap000
ip addr add 10.99.0.1/24 dev gretap000
ip link set gretap000 up; ip link set br-gretap000 up
```

Relay/bigcml side (mirrors, with eno2 bridged):

```
ip link add gretapenc1 type gretap remote 192.168.10.103 local 192.168.1.136 key 7175427 ikey 7175427
ip link add br-gretapenc1 type bridge
ip link set gretapenc1 master br-gretapenc1
ip addr add 10.99.0.2/24 dev gretapenc1
ip link set gretapenc1 up; ip link set br-gretapenc1 up
ip link set eno2 master br-gretapenc1
```

### Findings (chronological)

1. **GRE transport works** between the two boxes (tcpdump on bigcml `eno1`, `ip proto 47`).
   No firewall drops (rpi4 iptables ACCEPT; bigcml ufw inactive).
2. First failures were PoC-wiring, not transport:
    - (a) bigcml `gretapenc1` **lost its 10.99.0.2 address** after I pulled it off the bridge →
      no on-link route, no ARP answers. Fixed by re-adding `10.99.0.2/24`.
    - (b) **`arp_ignore`/`arp_announce` were NOT the issue** (both 0/0).
3. **ROOT CAUSE #1 — outer source routing:** with `local 192.168.1.136` (the advertised eno2 IP),
   `ip route get 192.168.10.103 from 192.168.1.136` = `via 192.168.1.1 dev eno2`. So bigcml routed the
   **outer GRE to the encoder out `eno2`'s home-LAN router**, where the rpi4 is not reachable →
   **no GRE left `eno1`** (verified by capture: 0 packets bigcml→rpi4).
   Fix: gretap `local` = the relay's **on-path** IP `192.168.10.1` (routes to rpi4 via eno1). After this,
   bigcml **transmits** GRE out `eno1` (9 pkt captured).
4. **ROOT CAUSE #2 — keyed-GRE RX matches destination IP to the tunnel `local`:** with
   gretapenc1 `local=192.168.10.1` but rpi4 sending GRE dst `192.168.1.136`, bigcml `gretapenc1 rx=0`
   (packets arrive on eno1 but are NOT decapsulated). ⇒ **both ends must address the outer GRE to the
   same relay IP.**
5. **ROOT CAUSE #3 — the encoder must point its gretap `remote` at the relay's ON-PATH IP, not the
   advertised (pass-through) iface IP.** The rpi4's `remote 192.168.1.136` (eno2) is only reachable by
   the rpi4 via its gateway `192.168.10.1` (bigcml eno1) — the two IP spaces differ. Setting rpi4
   `remote 192.168.10.1` (with the SAME key from eno2IP) → **tunnel pings 5/5, 0.18ms.**

### ✅ PoC tunnel PINGING (point-to-point, no bridge)

```
# encoder (rpi4)
ip link add gretap000 type gretap remote 192.168.10.1 local 192.168.10.103 key 7175427 ikey 7175427
ip addr add 10.99.0.1/24 dev gretap000; ip link set gretap000 up
# relay (bigcml)
ip link add gretapenc1 type gretap remote 192.168.10.103 local 192.168.10.1 key 7175427 ikey 7175427
ip addr add 10.99.0.2/24 dev gretapenc1; ip link set gretapenc1 up
# => ping -I gretap000 10.99.0.2 from rpi4: 5 received, 0% loss
```

-   key still = `greKeyForEndpoints(192.168.1.136 /*eno2 advertised*/, 192.168.10.103 /*enc*/)`.
-   **outer endpoint = relay on-path IP (192.168.10.1), NOT the advertised iface IP.**

### ⚠️ Code design implications (THE core fix)

The encoder `VifImpl.start` does `setUpGretap({name, peerIp: target.relayHost, ...})` where
`target.relayHost` = the **advertised iface IP (192.168.1.136)**. That is wrong for the outer `remote`.
The relay must advertise a **separate `outerIp`/`relayIp` = its on-path IP** (the IP the encoder reaches
it by), and the encoder must use that for `remote`. The **key** continues to use the advertised iface IP.

-   Relay picks its on-path IP per encoder = `egressIface(enc.ip)`'s address (on bigcml, eno1=192.168.10.1,
    since `ip route get <enc>` = via eno1). For an encoder on the eno2 LAN, it'd be eno2's IP.
-   So the relay advertises, per iface: `{name, address /*= key material + LAN identity*/,
outerIp /*= egressIface(enc).ip, per-encoder*/}` — OR the encoder derives the relay's on-path IP via a
    route lookup (it already knows the relay is reachable; needs the relay's source IP from hello/discovery).
-   Simplest contract: **relay announces, in the WS `hello`, its on-path source IP for that encoder**
    (the `local` it used). Encoder uses it as gretap `remote`.

## ✅ Status: PoC COMPLETE — the full requirement is proven

The relay's home-LAN interface (`eno2`, `192.168.1.0/24`) is **usable from the rpi4 encoder**
through the GRETAP L2 tunnel:

| Test (from rpi4)                     | Result          |
| ------------------------------------ | --------------- |
| `192.168.1.1` (home router/gw)       | ✅ 2/2          |
| `192.168.1.131` (**real home host**) | ✅ 4/4, ~1.1 ms |
| (earlier) tunnel p2p `10.99.0.2`     | ✅ 5/5          |

### Final working configuration (L2 bridging mode)

-   **relay (bigcml):** bridge `br-gretapenc1` = `{eno2, gretapenc1}`. **The LAN IP (192.168.1.136) +
    the `192.168.1.0/24` + default routes must be moved from `eno2` onto the bridge** (a bridge port
    cannot host its own IP+routes). `gretapenc1` (key 7175427, remote 192.168.10.103, local
    **192.168.10.1**) has **no IP** — pure L2 port.
-   **encoder (rpi4):** `gretap000` (remote **192.168.10.1**, local 192.168.10.103, key 7175427) with a
    **home-LAN IP (192.168.1.200)** + route `192.168.1.0/24 dev gretap000`.
-   Flow: `rpi4 → gretap000 → GRE(47) over 192.168.10.x → bigcml gretapenc1 → bridge → eno2 → home LAN`.

### PoC teardown — DONE, both machines restored

-   bigcml `eno2` released from the bridge, IP `192.168.1.136/24` + default route restored to `eno2`;
    `gretapenc1`/`br-gretapenc1` deleted. bigcml back on home LAN (4/4 to `.1`).
-   rpi4: `gretap000` + tunnel route removed. (Pre-existing stale `gretap0`/`gre0` on bigcml are
    unrelated leftovers, not created by this PoC.)

## Design requirements captured from the PoC (for the code implementation)

1. **Outer endpoints (both ends):** encode toward the relay's **on-path IP** (192.168.10.1), not the
   advertised iface IP (192.168.1.136). The relay must **advertise its on-path IP** to the encoder
   (new field in WS `hello`); encoder uses it for gretap `remote`.
2. **Key** = f(advertised iface IP, encoder IP) — both ends must agree; **independent** of outer IPs.
   Device names may differ per end (kernel demux is by proto+key).
3. **Relay bridge:** create bridge, move `eno2` in, **move eno2's IP(s)+routes to the bridge**, add the
   IP-less gretap port. Must be **idempotent + restorable** (the relay owns its own connectivity).
4. **Encoder IP:** the encoder's gretap port needs an IP on the **passed subnet** (`192.168.1.0/24`),
   which the relay must advertise (iface IP/prefix), + a route for that subnet via the tunnel.
   (Current encoder vif assigns a `10.x` tunnel subnet — needs to change to the passed subnet.)
5. **MTU:** gretap 1458 (inner); app uses 1400.

### Implementation (done)

-   [x] **Relay-side** GRETAP orchestrator `client/modules/ctrlink_relay/gretap.ts` — opt-in
    (`ctrlink_relay.gretap`, default off, never in DRY_RUN), idempotent, restorable. Per
    (exposed endpoint × encoder) it builds a keyed tunnel + bridge, moves the endpoint's IPs
    onto the bridge, and heals/stale-cleans. Reconciles on encoder (dis)appearance, network
    change, and stop. Wired into `backend.ts` (`configureGretap` + `reconcileGretapsNow`).
-   [x] New lib helpers in `gretap.ts`: `outerEndpointFor`, `listIfaceAddrs`, `createGretapTunnel`
    (reuses `gretapSetupCommands` + `link set local <onPath> remote <enc>`, heals "File exists"),
    `attachToBridge`, `moveAddrsToBridge`, `releaseIfaceFromBridge` — all through the `ip` seam.
-   [x] Relay advertises per-encoder **`outer_ip`** (the on-path IP) + **`prefix`** on the WS
    `hello` + per-iface events (`gretapOuterIpFor` cache, populated in the reconcile before the
    first hello to avoid a race).
-   [x] **Encoder-side** `virtual_interface.ts` gained `remoteIp?` (GRETAP `remote`; falls back to
    `relay.host`); `ctrlink_streamer/backend.ts` `desiredTargets` uses the exposed subnet IP
    (`pickExposedIp` = `<base>.200`, /24) + `outer_ip` when advertised, else the legacy `10.x`
    tunnel IP (non-breaking for legacy relays).

### Next

-   [x] p2p tunnel pings. - [x] eno2 L2 bridge → rpi4 reaches 192.168.1.0/24 (home gw + real host).
-   [x] PoC teardown; both machines restored.
-   [x] Implement relay-side gretap+bridge (idempotent + restorable).
-   [x] Relay advertises on-path `outer_ip` in WS `hello`; encoder uses it for gretap `remote`.
-   [x] Encoder vif: use the passed subnet IP (not `10.x`); route for it via the tunnel.
-   [ ] **e2e on real hw:** deploy new `client-arm` + `relay.json`/`enc.json` (enable `gretap`),
    verify gretap devs exist and rpi4 pings 192.168.1.131 / 192.168.1.1.

### Test/build status

-   `bun test shared/lib/gretap_relay/test/gretap.test.ts` → **29/29 pass** (incl. 7 new helper tests).
-   `bun test client/modules/ctrlink_relay/test/backend.test.ts client/modules/ctrlink_streamer/test/backend.test.ts` → **54/54 pass**.
-   Full suite: 723 pass / 8 fail — the 8 are in untouched modules (network frontend import
    boundary, kick-chat timing, OBS overlays, CSS tokens, uplinks rewrite); none in GRETAP files.
-   `bun run build:client` → **dist/client + dist/client-arm build clean**.

## Live e2e bring-up (bigcml `relay` ↔ rpi4 `encoder`) — findings

Brought the deployed build up on the real pair. Both sides reached L2-up GRETAP
tunnels + bridges; the exposed-IP path (192.168.1.200 on rpi4) never applied because of a
control-loop bug. Fixed in code below; **rpi4 is currently locked out** (see the last item).

### 1. Relay module was not starting (config/role chain)

-   `client/roles/ctrlink_relay/role.json` `requires.modules` was missing `network` (the relay
    module's `bind()` needs `network.interfaces`/`network.uplinks`). Adding it tripped role
    validation: a role's `requires.capabilities` must EXACTLY equal the union of its modules'
    `services.consumes`, and `provides.capabilities` the union of provided capabilities. Fixed
    both to match (`requires: [modems.source, network.interfaces, network.uplinks]`).
-   The config file's top-level `"role"` OVERRIDES the `--role` CLI flag (`effectiveRole()` =
    `state.settings.role ?? ROLE`). relay.json said `"role":"relay"`, so the `ctrlink_relay`
    module was never served/started. Set it to `ctrlink_relay`.
-   The relay reads its config from the TOP-LEVEL `state.data.ctrlink` section (not
    `modules.ctrlink_relay`). Added a top-level `ctrlink` block to relay.json.

### 2. `ip link set … type gretap` is required

Bare `ip link set gretapX local A remote B` fails with *"either 'dev' is duplicate, or
'local' is garbage"*. GRE tunnels need `type gretap` on the set. Fixed in
`shared/lib/gretap_relay/src/gretap.ts` `createGretapTunnel` + test.

### 3. Encoder bridge had no IP/route

`VirtualInterface.start()` built `gretapX`+`br-X` but never put an address on the bridge.
Added `ip addr replace <localIp>/<prefix>` + `ip route replace <net>/<prefix>` to
`virtual_interface.ts` `start()` (+ `cidrNetwork()` helper). Without it the L2 bridge held no
address → the home LAN was unreachable.

### 4. Relay offered its own bridge as an endpoint

`eligibleInterfaces` filtered by state only, so the relay advertised `br-geno2rpi4`
(192.168.1.136) alongside `eno2`. Now filters `^gretap`/`^br-` names. 3 ifaces advertised
(eno2, wg0, wwx).

### 5. ⚠️ Control-loop churn: WS flap every 5s (ROOT of the no-exposed-IP bug)

The encoder's **autostart** kept failing every 5s — `Autostart failed, retrying in 5s:
Unknown pipeline: test/x264_test_pattern` (an OBS pipeline, unrelated to CtrLink). `runAutostart`
iterates every started module and `await`s each `resume()`; the failing OBS module throws, so the
whole resume re-runs every 5s. Two streamer `resume()` side-effects made that fatal:

-   `ensureControlPlane()` unconditionally did `wsServer?.stop(true)` → the live relay WS was
    dropped mid-handshake, before it delivered the exposed-IP `hello`.
-   `ensureDiscovery()`→`startDiscovering()`→`stopDiscovering()` did `relays = new Map()` →
    **wiped the registry** (including the WS relay + its `outer_ip`); the relay then re-entered
    via UDP announce, which carries NO `outer_ip` → the exposed iface regressed to a legacy
    `10.x` tunnel.

**Fix (idempotency guards):** `ensureControlPlane()` now returns early when a server is already
live with the same `wsPort`+`token` (`controlPlaneKey`), and `ensureDiscovery()` returns early
when `discoveryStarted`. Both flags reset in `stop()`. The 5s autostart loop no longer tears the
control plane / registry down.

### 6. ⚠️ GRE key mismatch (frame-level: tunnel up, L2 black-holing)

Keyed-GRE demux matches the *endpoint pair* hash. The relay keys by
`greKeyForEndpoints(ep.ip /* iface LAN IP, e.g. 192.168.1.136 */, encIp /* 192.168.10.103 */)`
(`client/modules/ctrlink_relay/gretap.ts`). The encoder keyed by
`greKeyForEndpoints(target.relayHost /* announce host 192.168.10.1 */, defaultSourceIp())`.
**Different first IP → different FNV-1a key → every frame dropped.** Fixed: `TunnelTarget` now
carries `ifaceIp` (the relay's advertised per-iface IP from the hello) and `startTunnel` keys by
`greKeyForEndpoints(target.ifaceIp, defaultSourceIp())` — mirroring the relay exactly.

### 7. ⚠️ rpi4 LOCKED OUT — GRETAP enslaved its management NIC (recovery needed)

After the fixes, the encoder created `gretapm0_eno2`/`wg0`/`wwx001` + bridges. `setUpGretap`
does `ip link set <localIface> master br-<name>`, and `localIface` was resolved to **`eth0`** —
the rpi4's ONLY physical NIC (192.168.10.103, the management/SSH path, gateway 192.168.10.1).
Bridging `eth0` moved its IP onto the bridge and broke the management connection. rpi4 is now
L2-present (MAC `dc:a6:32:7b:8b:18` still cached on bigcml eno1) but unreachable at IP; no
alternate route to it exists (only 192.168.10.0/24).

**Root cause:** the encoder's GRETAP must NOT bridge the NIC that carries its own management /
on-path address. The relay correctly bridges the *remote-LAN* NIC (eno2) because that IP is
intentionally moved to the bridge. The encoder's own LAN NIC (eth0) must stay up with its IP;
only the GRETAP dev belongs in the bridge (a point-to-point L2 link does not need a second local
port). **TODO:** on the encoder, bridge only the gretap dev (drop the `localIface` enslavement)
or exclude the management NIC; then rpi4 recovers its 192.168.10.103 path and the e2e ping
(eno2 → 192.168.1.1 / 192.168.1.131) can be re-verified.


### §8 — `setUpGretap` now builds the encoder bridge point-to-point (FIX, in progress)

Lockout item 7 has a code fix ready: `shared/lib/gretap_relay/src/gretap.ts` `setUpGretap`
**no longer enslaves the local LAN NIC**. Removed the `ip link set <localIface> master
br-<name>` + `link set <localIface> up` pair. `localIface` is now resolved *only* to name
the outer GRE egress (retained in the return value for logging/egress); it is never made a
bridge member. The encoder bridge therefore holds just the gretap dev. The remote LAN
(192.168.1.0/24) still reaches the encoder because the gretap dev on `br-<name>` carries
its frames, while `eth0` stays an ordinary NIC (keeps its 192.168.10.103 management IP).
The relay side is unchanged and still bridges its real LAN port (`attachToBridge` +
`moveAddrsToBridge`) — that is the correct side, on a box with a separate management path.

- `gretap.test.ts`: `setUpGretap` and `createVirtualInterface().start()` now expect ONLY
  the `gretapSetupCommands` (gretap dev + point-to-point bridge) — no local-NIC enslavement.
- `83/83` unit tests green; arm64 binary rebuilt (md5 `03f6f0bc…`).
- **Pending: rpi4 recovery (physical power-cycle / console), then redeploy + verify that
  `br-m0_eno2` gets 192.168.1.200/24 and `ping 192.168.1.1` works from rpi4 — with `eth0`
  untouched.**


## §9 — Live e2e bring-up: bigcml `eno2` → rpi4 (VERIFIED)

Naming per request: bigcml `eno2` → relay devs `gretap_eno2` / `br-gretap_eno2`
(relay bridge keeps the `192.168.1.136/24` addrs), encoder dev `gretap_eno2` + bridge
`br-gretap_eno2` on `192.168.1.200/24` (`.200` = last-octet convention of
`gretapOuterIfaceFor`). `localIface` is never enslaved on the encoder (see §8), so
`eth0` = `192.168.10.104/24` stays intact.

Bugs found and fixed during the live run (all in `client/` + `shared/lib/gretap_relay/`):

1. **Keyed-GRE source-port collision** — the encoder used source port
   `listenPortBase + 5000` as GRE key, identical to what the relay used as its key on
   the same (outer) pair; the kernel matched the relay's inbound stream first and
   dropped the encoder's. Encoder now uses `base + 5100` (`shared/lib/gretap_relay/src/gretap.ts`
   `GRETAP_SOURCE_PORT`).
2. **`gretap0` flap** — `reconcilePass` saw the peer's dev (same key, different name
   `gretap0` vs `gretap_eno2`) as "missing from desired" and destroyed it, flapping
   until the `gretap0` key stopped arriving. `reconcilePass` now skips devs that
   don't match its own `devNameFor()` (`client/modules/ctrlink_relay/gretap.ts`).
3. **Signature churn (exposure in registry key material)** — the registry `signature()`
   excluded `outer_ip`/`prefix`, so a late WS hello that added `outer_ip` to an
   already-registered relay looked identical and never triggered a rebuild; the tunnel
   stayed on the legacy `10.90.x.y.1`. Signature now includes `outer_ip`/`prefix`
   (`client/modules/ctrlink_streamer/discovery.ts`).
4. **Exposure wipe by compact refresh** — the reverse churn: `registerRelay` did a
   wholesale `relays.set`, so the relay's UDP/mDNS compact record (no `outer_ip`)
   replaced the WS entry and stripped the exposure; after #3 the tunnel then rebuilt
   to the legacy `10.90.0.1`. Fix: source-gated `carryExposure(next, prev)` —
   non-WS sources (`mdns`, `broadcast`) inherit per-iface `outer_ip`/`prefix` from the
   existing entry, WS stays authoritative (a relay genuinely dropping its on-path IP
   must un-expose). `registerRelay(relay, source: "broadcast"|"mdns"|"ws")`.

Binaries: x86 `a523e3de` (relay, bigcml), arm `66e27c24` (encoder, rpi4).
Tests: `87/87` across `ctrlink_streamer/` `ctrlink_relay/` `gretap_relay/`
(incl. regression tests for #3 and #4).

**Verified outcome (rpi4, `br-gretap_eno2`=192.168.1.200/24):**
- `ping -I br-gretap_eno2 192.168.1.1` (home router) → **0% loss, ~0.8 ms**
- `br-gretap_eno2` stays `192.168.1.200` across repeated WS/mDNS refreshes
  (`started gretap_eno2` exactly once — no rebuild churn)
- `eth0` = `192.168.10.104/24` untouched
- Relay side: `br-gretap_eno2` = `192.168.1.136/24`, `eno2` bridged, `gretap_eno2` up
- Pinging the relay's own `192.168.1.136` through its own tunnel is 100% loss by
  design (transparent L2 bridge — the frame leaves the box onto eno2); the point of
  the tunnel is the home LAN behind the relay, which works.
