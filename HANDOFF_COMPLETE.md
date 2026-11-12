# HANDOFF COMPLETE — `@irlctrl/udp-relay` single-socket + kernel-NAT rewrite

**Branch:** `refactor/udp-relay-single-socket` (not pushed)
**Objective:** optimize `shared/lib/udp_relay` to a single-socket, high-performance
design and fix the `relay0_enxb6db3` (mobile CGNAT) leg failure.
**Result:** done. 133 tests pass / 0 fail; hot path allocates 0 B and does 0
`await`s; the learned-vif NAT fix is proven live on the `bigcml` 3-leg host in both
directions under strict `rp_filter=2`.

---

## 1. What changed (one line per file)

### `shared/lib/udp_relay/` (the library)

| File | Change |
| --- | --- |
| `src/net_linux.ts` | **Deleted** — the raw `AF_INET` interface socket (the primary change). |
| `src/relay.ts` | **Rewritten** — one UDP listener (`0.0.0.0:port`) + one TUN per leg; strip 8-byte header → TUN write; kernel does routing/NAT. Added `onEncoderVifLearned` (fires once per distinct vif from the frame header) and the `announcedVifs` set; allocation-free `rxBuf`/`txBuf` hot path. |
| `src/nat_rules.ts` | **New** — pure leg command plans + appliers: `planLegBaseCommands`/`applyLegPlan` (vif-independent egress table with the uplink gateway, `iif` rule, FORWARD accepts) and `planVifCommands`/`applyVifPlan`/`removeVifPlan` (reply route + MASQUARADE keyed on the learned vif). Plus `relayTunName`, `legTable`, `sweepStaleLegTuns`. |
| `src/ip.ts` | Removed dead user-space SNAT/dNAT (`natPacketSource`, `natPacketDestination`, `natIpAddress`) — the kernel MASQUERADE does it now. Kept `buildUdpIpPacket` + checksums. |
| `src/protocol.ts` | v2 wire framing: 8-byte data-frame header (`type + flags + reserved[2] + vifIp[4]`), `writeDataHeader`, `sniffFrameKind`. |
| `src/tun_linux.ts` | TUN open/close/read via `Bun.file(fd).stream()` (`IFF_NO_PI`); `makeMockTunDevice` test seam. |
| `src/virtual_interface.ts` | Encoder side (TUN + relay socket) unchanged in spirit; consumes the shared TUN/protocol helpers. |
| `src/index.ts` | Exports updated: dropped raw-socket helpers; added `nat_rules` API + `onEncoderVifLearned` types. |
| `src/types.ts`, `src/stats.ts`, `src/frame_types.ts` | Options/counters trimmed to the single-socket model. |
| `test/*` | Rewritten for behavior (not implementation); `nat_rules.test.ts` (base/vif plans, gateway egress, learned-vif MASQUARADE); `relay.test.ts` (`onEncoderVifLearned`); 6 dead SNAT/dNAT tests removed — **133 pass**. |
| `bench/bench.ts` | New micro-bench (real loopback listener + mock TUN): pps, CPU %, heap slope, p99. |
| `README.md` | **Rewritten** — single-socket + kernel-NAT design, learned-vif API, provisioning order, perf, pitfalls. |
| `NAT.md` | **New** — the kernel rule sets (iptables + nftables), two-phase install, gateway requirement, the b6db3 dead end. |
| `REFERENCE_NOTES.md` | **New** — which `datagutt/moblink-rust` patterns were adopted and where. |
| `DECISIONS.md` | **New** — D1–D8 rationale (single socket, learned-vif key, base/vif split, gateway, TUN read, endpoint map, `nat` knob, dead-NAT removal). |
| `bench/BASELINE.md` | Before/after table + §10 target check. |
| `bench/SMOKE.md` | **New** — manual smoke test (egress pin, upstream capture, reply round-trip, no-root). |

### Consumers

| File | Change |
| --- | --- |
| `client/modules/moblink_relay/backend.ts` | Provisions each leg TUN, applies the base plan **before** `relay.start()`, applies the vif plan from `onEncoderVifLearned`, resolves the uplink gateway (`uplinkGateway`), tears vif-then-base down on stop; announces `vif_ip` per leg. |
| `client/modules/moblink_relay/{discovery,types,frontend}.ts(x)`, i18n | Per-interface announce (encoder-facing dial address); listener binds `0.0.0.0`. |
| `client/modules/moblink_streamer/*` | Encoder side: `createVirtualInterface`, per-segment announce. |
| `scripts/run_udp_relay.ts`, `test_udp_relay_live.ts`, `udp_bothways_relay.ts` | Live-verification helpers migrated to base+vif plans (they know the vif up front). |
| `test_relay_chain.sh` | 3-part end-to-end test: auto-detects the rpi4 mobile TUN+IP, `tcpdump -U` + waits for the capture before reading, mobile-leg e2e proof. |
| `TODO/optimize-udp-relay.md` | §16 live-validation findings (the fix + proof), §6.2 split API. |
| `TODO/100-moblink.md` | Stale relay descriptions (two-socket/no-TUN, 4-byte header, "shared srtla_rec") updated to the final design. |

---

## 2. Before / after benchmark (`bench/bench.ts`, 200k pkts, 1200 B, bigcml x86-64, Bun 1.4.4)

| Metric | Before (raw socket + user-space NAT) | After (single socket + TUN) |
| --- | --- | --- |
| pps (mocked egress) | 41 325 | 39 510 |
| CPU, % of one core | 1.05 | 1.04 |
| heap slope, KB / 10k pkts | 0 | 0 |
| p50 latency, µs (event-loop proxy) | 3 | 3 |
| p99 latency, µs (event-loop proxy) | 8 | 7 |

All §10 targets clear (0 B alloc/packet, 0 `await`, p99 7 µs « 60 µs, ~373 Mbps » 150
Mbps, 133/133 pass). **Caveat:** the bench is producer-paced and measures the
frame-strip→TUN-write hot path with a mock egress, so it is nearly identical
before/after — the real win is on the *live* path (no raw-socket syscalls, no
user-space NAT map, no per-packet `onStats`, no root for the data path).

---

## 3. Deviations from the handoff (`optimize-udp-relay.md`), with rationale

1. **NAT is keyed on the learned encoder vif, not the uplink IP.** The plan's
   §6.2 example implied a vif you know at provision time. Live validation proved
   the uplink-IP-as-vif design is a dead end (source-identity no-op + strict
   `rp_filter` drop + local-delivery reply). We added `onEncoderVifLearned` and
   split the leg plan into a vif-independent **base** (up-front) and a **vif**
   part (on learn). This is the b6db3 fix.
2. **The egress table carries the uplink gateway** (`default via <gw> dev
   <uplink>`). The plan didn't mention it; without it a public/CGNAT destination
   ARPs the peer directly on-link and fails (observed ARP `FAILED`).
3. **Kept a small `vifEndpoints: Map<u32, endpoint>`**. The plan said avoid a
   per-flow Map; but the kernel needs the relay to tell it *which encoder UDP
   endpoint* to hand a TUN reply to, and that's a vif→endpoint table bounded by
   the number of encoders on the leg (not a per-5-tuple set). See `DECISIONS.md` D6.
4. **Removed `natPacketSource`/`natPacketDestination`** (and their tests) as dead
   code after the kernel took over NAT — the plan's "prefer deleting code" rule.
5. **`SO_REUSEPORT` + workers (plan Step 9) not implemented — skipped per its own
   criterion, now measured.** Pacing the relay to a 10k pps target in-process
   (real loopback listener + mock TUN) uses **~0.04 of one core (≈ 4 %)**, far under
   the 25 %-of-one-core gate. `Bun.spawn` + IPC `ParentProxyStats` + SIGTERM
   forwarding would add complexity with no demonstrated benefit at this scale;
   revisit only if a single leg sustains a multi-core forward load. `UdpRelayOptions.workers`
   is intentionally not in the shipped API.
6. **`legacyRawSocket` feature flag (Risks §12) not added** — the encoder never
   relied on raw-socket behavior; the encoder side is `createVirtualInterface`
   (TUN + UDP), unchanged.

## 4. Open questions for a human

1. **The rpi4 encoder side is currently down** (no TUNs; `/tmp/srtla_ips.txt` has
   < 3 IPs). The full `./test_relay_chain.sh all` end-to-end run was not executed
   because of that — the relay side is proven live via probes, but a real encoder
   chain run is still owed.
2. **WireGuard leg (`wg0`)** has no gateway (peer is on-link) — the `uplinkGateway`
   resolver returns none and the base plan uses a no-gateway default. Confirm this
   is the intended behavior on the real `wg0` uplink (it was provisioned but not
   traffic-tested).
3. **CI bench regression gate (§11.4)** — the plan asked to store per-PR bench
   results as an artifact and fail CI on >15% CPU/p99 regression. This was **not**
   wired into a CI workflow; it needs the existing CI runner as a prerequisite.
4. Should `NAT.md` also ship a ready-to-paste **single `nft` script** for all three
   legs, rather than per-leg snippets? (Currently per-leg; the backend generates
   them from `nat_rules.ts`.)

## 5. Confidence: **High** for the relay data path; **Medium** pending the full
   encoder-chain run.

The library change is a strict simplification (removed code, kernel does forwarding),
the wire format is unchanged (encoders don't update), all 133 tests pass, typecheck
is clean, and the learned-vif NAT fix is proven live **in both directions** on the
exact failing leg class (mobile CGNAT) under strict `rp_filter=2`. Confidence is
*high* on the relay mechanism itself. It is *medium* overall only because the
canonical end-to-end `test_relay_chain.sh all` (which needs the rpi4 encoder) has
not been run to completion — that is the one remaining live validation.

## 6. How to verify manually (for the human merging the PR)

On the relay host with the rpi4 encoder running: start the relay
(`CONFIG_FILE=/… bun run dev:client`; the `moblink_relay` backend provisions each
leg's TUN, base routing/NAT, and on first encoder frame the learned-vif MASQUARADE
+ reply route), then run `./test_relay_chain.sh all`. Test 1 must show a tagged UDP
packet sent from the rpi4 mobile TUN arriving at the VPS; test 3f must show the
packet arriving from a **non-home-router** source IP (mobile CGNAT), which is the
b6db3 end-to-end proof. To verify the kernel state directly: `ip route get iif
relay<slot>_<uplink> from <vif> to <public-dest>` should pick the leg table
(`via <gw> dev <uplink> table <40+slot>`), `sudo iptables -t nat -S POSTROUTING`
should show a `MASQUARADE -s <vif>/32 -o <uplink>`, and `ip route show <vif>`
should show `<vif> dev relay<slot>_<uplink>`. The relay process itself must run
**unprivileged** once the rules are in place. See `shared/lib/udp_relay/bench/SMOKE.md`
for the full reproducible checklist.
