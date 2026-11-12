# Decisions & rationale — `@irlctrl/udp-relay` single-socket rewrite

Ambiguities resolved during the rewrite, with the reasoning. The wire format is
unchanged (encoders must not update); everything below is relay/kernel-side.

## D1. One socket + one TUN, kernel is the bridge

**Decision:** drop the raw-interface socket and the second UDP socket; the relay
owns a single `0.0.0.0:listenPort` listener and one TUN per leg; the kernel does
routing + NAT.

**Why:** the raw socket required root, did user-space filtering, and forced
per-packet `Buffer.concat` + SNAT/dNAT rewrites. The kernel does all of that in
hardware path (conntrack + routing tables), so the user-space forward is one UDP
callback + one TUN write. This is the primary performance win and removes the
root requirement for the data path (root is only needed to provision the rules).

## D2. NAT + reply route keyed on the **encoder's** vif, not the uplink IP

**Decision:** the leg's MASQUERADE + `to <vif>/32 dev <tun>` reply route are
installed on the encoder's **dedicated, non-local** vif (`10.{90+x}.{y}.1`),
learned from the first frame via `onEncoderVifLearned`.

**Why (the b6db3 bug):** the first build keyed them on the uplink's own local IP.
That is a source-identity no-op for MASQUARADE, fails **strict `rp_filter`** on
the forward path (a local source resolves to `lo`, dropped before `FORWARD`), and
a reply to a local IP is local delivery (never forwarded back through the TUN).
Keying on the encoder's non-local vif fixes all three and is what `relay0_enxb6db3`
(mobile CGNAT leg) required. Proven live, both directions, strict `rp_filter=2`.

## D3. Split the leg plan into **base** (vif-independent) + **vif** (learned)

**Decision:** `planLegBaseCommands`/`applyLegPlan` installed up-front;
`planVifCommands`/`applyVifPlan` installed on `onEncoderVifLearned`.

**Why:** the relay cannot derive the vif up front (x, y are known only to the
encoder). Splitting lets the leg be ready to forward (routing + FORWARD) before
any frame, while the NAT + reply route appear the instant the first frame names
the vif. Both phases are idempotent (`del` before `add`), so restarts/learn
races are safe.

## D4. Egress table carries the uplink **gateway**

**Decision:** `default via <gw> dev <uplink>` in the leg table, with the gateway
resolved at provision time (`uplinkGateway(name)` → `ip -4 route show default dev
<name>`).

**Why:** a no-gateway `scope link` default makes the kernel ARP for the
*destination* on the uplink segment, which fails for public/CGNAT peers (observed
ARP `FAILED`, ~1-in-many egress). Observed gateways on the 3-leg host:
`eno2 → 192.168.1.1`, `enx76ae… → 172.21.254.48`, `wg0 → (none, direct)` — the
WireGuard leg's peer is on-link, so omitting the gateway there is correct.

## D5. TUN reads via `Bun.file(fd).stream()`, not a manual read loop

**Decision:** the TUN fd is read through `Bun.file(fd).stream()`; with
`IFF_NO_PI` each chunk is exactly one IPv4 packet.

**Why:** a TUN fd is a character device that never signals EOF, so a stream
emits one chunk per packet for the device's lifetime with no manual `read`/EOF
handling and no `select`. This keeps the hot path allocation-free and matches the
"one callback per packet" model. The `ioctl(TUNSETIFF)` is loaded from libc via FFI
on first use and guarded so a Bun build without the FFI type API fails with a
clear message from `start()`.

## D6. `vifEndpoints` is a small `Map<u32, endpoint>`, not per-flow state

**Decision:** the relay keeps `vifEndpoints` (one entry per vif /32) to know which
encoder to hand a reply to.

**Why:** the kernel only delivers to the leg TUN packets addressed to that leg's
vif /32, so there is one entry per vif and the map can never grow unbounded. This
is not the "per-5-tuple flow Map" the plan warned against — it is a vif→endpoint
address table, keyed on the 32-bit vif, bounded by the number of encoders on the
leg. (The reply needs the encoder's UDP endpoint for `sendTo`; the kernel has no
way to give that to us.)

## D7. `nat` config knob gates only MASQUARADE + reply route

**Decision:** `config().nat` (default `true`) gates the vif-plan NAT pieces;
routing + FORWARD are always installed.

**Why:** per the plan, NAT is the deployment layer's job. A leg whose vif is
directly reachable by the uplink (no CGNAT) can run with `nat=false` and still
forward; the knob turns off only the masquerade + the vif reply route.

## D8. Removed `natPacketSource`/`natPacketDestination` + tests

**Decision:** deleted the user-space SNAT/dNAT helpers (and their tests).

**Why:** dead after D1/D2 — the kernel's conntrack MASQUARADE does it. Leaving
them would invite a regression to user-space NAT. (6 tests removed; suite is
green.)
