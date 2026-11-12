# udp_relay benchmark — before/after

Bench: `bun bench/bench.ts` (rootless, in-memory mock interface socket, loopback,
1200 B payloads, paced single-threaded producer). Measured 2026-11-12 on the
bigcml relay host (x86-64, Bun 1.4.4, no root).

| Metric | Before (raw socket + user-space NAT) | After (single socket + TUN) |
|---|---|---|
| pps (1200 B, mocked iface) | 41 325 | _pending_ |
| CPU, % of one core | 1.05 | _pending_ |
| heap slope, KB per 10k pkts | 0 | _pending_ |
| p50 per-packet latency, µs (event-loop proxy) | 3 | _pending_ |
| p99 per-packet latency, µs (event-loop proxy) | 8 | _pending_ |

Notes:
- `cpuPctOfOneCore > 1` at baseline: the forward handler alone runs at ~105 % of
  a core at 41k pps on this machine (the raw-socket send path plus per-packet
  `onStats`/frame allocations).
- GC scavenges/s are not measurable on Bun 1.4.4 (`performance.getGCStats` is
  unavailable); heap slope is used instead. The mock `iface.sent` sink retains
  every packet, so heap slope reads 0 at baseline — a relay-side improvement
  will not show as a *positive* slope here, only as equal-or-better.
- The p50/p99 numbers include one event-loop cycle per packet (single-threaded
  measurement); they are a stable *relative* proxy, not absolute kernel latency.
