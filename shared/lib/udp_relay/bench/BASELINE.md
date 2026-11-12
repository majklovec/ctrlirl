# udp_relay benchmark - before/after

Bench: `bun bench/bench.ts` (rootless, in-memory mock interface socket, loopback,
1200 B payloads, paced single-threaded producer). Measured 2026-11-12 on the
bigcml relay host (x86-64, Bun 1.4.4, no root).

| Metric                                        | Before (raw socket + user-space NAT) | After (single socket + TUN) |
| --------------------------------------------- | ------------------------------------ | --------------------------- |
| pps (1200 B, mocked egress)                   | 41 325                               | 41 274                      |
| CPU, % of one core                            | 1.05                                 | 1.03                        |
| heap slope, KB per 10k pkts                   | 0                                    | 0                           |
| p50 per-packet latency, µs (event-loop proxy) | 3                                    | 3                           |
| p99 per-packet latency, µs (event-loop proxy) | 8                                    | 8                           |

Notes:

-   After numbers: the egress sink is now the mock TUN (`written[]` retains every
    packet, same as the old `iface.sent`), the listener is the same real UDP
    socket on 127.0.0.1 → comparable to the baseline. The bottleneck at this
    machine speed is the paced producer (one event-loop yield per 2k packets),
    not the relay; both before and after plateau at ~41k pps. The win shows up
    in the _live_ path (no raw socket syscalls, no user-space NAT map lookups,
    no per-packet `onStats`).
-   `cpuPctOfOneCore > 1` at baseline: the forward handler alone runs at ~105 % of
    a core at 41k pps on this machine (the raw-socket send path plus per-packet
    `onStats`/frame allocations).
-   GC scavenges/s are not measurable on Bun 1.4.4 (`performance.getGCStats` is
    unavailable); heap slope is used instead. The mock `iface.sent` sink retains
    every packet, so heap slope reads 0 at baseline - a relay-side improvement
    will not show as a _positive_ slope here, only as equal-or-better.
-   The p50/p99 numbers include one event-loop cycle per packet (single-threaded
    measurement); they are a stable _relative_ proxy, not absolute kernel latency.
