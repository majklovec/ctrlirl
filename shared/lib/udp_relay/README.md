# @irlctrl/udp-relay

A transport primitive for irlctrl: move UDP payloads between a Linux **TUN**
device and a bound **UDP socket**, using the kernel for routing and NAT. It
knows nothing about SRTLA, Moblink, authentication, or configuration.

Two sides, one wire protocol:

| Side               | Factory                  | Creates                                        |
| ------------------ | ------------------------ | ---------------------------------------------- |
| Encoder (streamer) | `createVirtualInterface` | TUN + relay-facing UDP socket                  |
| Relay box          | `createUdpRelay`         | **One** UDP socket (`0.0.0.0:port`) + **one** TUN |

## Design: one socket + kernel forwarding

The relay owns **one** UDP listener (bound to `0.0.0.0`, so it is reached on
whatever uplink NIC the encoder used) and **one** TUN device per leg. It strips
the 8-byte frame header and hands the raw IPv4 packet to the kernel; the kernel
does everything else:

```
encoder → UDP → [relay 0.0.0.0:port] → TUN (vif /32)
    → `ip rule iif <tun> table <T>` → `default via <gw> dev <uplink>` in <T>
    → MASQUERADE (s=encoder-vif/32, o=uplink) → uplink NIC
reply  → conntrack de-NAT (dst=vif) → `to vif/32 dev <tun>` (main)
    → TUN → relay → encoder
```

No raw sockets, no user-space NAT, no header rewrites in the hot path: a packet
costs **one UDP delivery callback + one TUN write** (or the reverse). The kernel
side is provisioned by the deployment/backend via `nat_rules.ts` — see `NAT.md`.

> **The NAT + reply route are keyed on the encoder's vif, not the uplink IP.**
> The relay reads the vif from each frame header and fires `onEncoderVifLearned`
> so the backend installs the vif-specific rules when the first frame arrives.
> Keying NAT on the uplink's own local IP is a dead end (local source fails
> strict `rp_filter` on the forward path, and a reply to it is local delivery
> — never forwarded). See `NAT.md` and `optimize-udp-relay.md` §16.

## Wire protocol (v2 — transparent L3 bridge, big-endian)

-   **Data frame** `0x01` + flags (1B) + reserved (2B) + **vifIp (4B)** + the
    full raw IPv4 packet. `DATA_HEADER_LEN = 8`. `flags`/`reserved` MUST be 0 on
    send, MUST be ignored on receive.
-   **Keepalive frame** `0x02` + timestamp (8B).
-   The `vifIp` in the header is the encoder's dedicated virtual-interface /32
    (e.g. `10.{90+x}.{y}.1`) this packet belongs to — the relay keys its egress
    and, via the backend, its NAT on it.
-   Max data payload = `mtu − 28` (default mtu 1400 → 1372 B). Oversized packets
    are dropped and counted.
-   Malformed input (truncated header, unknown type) is rejected as a
    `{ type: "malformed" }` result, never thrown.

There are **no destination IPs/ports in the frame** — flow state is out-of-band
(one TUN = one flow).

## API

```ts
import {
    createVirtualInterface,
    createUdpRelay,
    listInterfaces,
    // leg netplan (kernel provisioning - see NAT.md):
    planLegBaseCommands,
    planVifCommands,
    applyLegPlan,
    applyVifPlan,
    removeLegPlan,
    removeVifPlan,
    relayTunName,
    legTable,
    // low-level: protocol, ip, tun-linux
} from "@irlctrl/udp-relay";

// ---- Encoder side: a TUN bridged to the relay ----
const vif = await createVirtualInterface({
    name: "moblink0",      // 1..15 chars
    localIp: "10.3.3.1",   // the vif /32
    prefixLength: 24,
    relay: { host, port }, // the relay's listen socket
    bindAddress?,          // default localIp (never 0.0.0.0)
    mtu?,                  // default 1400
    keepaliveIntervalMs?,  // default 5000
    onStats?,
    // tunDevice?,        // test seam: makeMockTunDevice().device
});
await vif.start();
// ... srtla_send targets 10.3.3.1 ...
await vif.stop(); // idempotent: close fd → ip link del → close socket

// ---- Relay side: one socket + one TUN; the kernel is the bridge ----
const relay = await createUdpRelay({
    interfaceName,                    // uplink this leg exits through (e.g. "eno1")
    listenPort,                       // the encoder dials this
    vifIp,                            // the leg's /32 (the TUN address)
    tunName?,                         // default "rtltun_eth0" (rtltun_<iface>)
    listenAddress?,                   // default "0.0.0.0" (NIC-agnostic)
    onStats?,
    statsIntervalMs?,
    onEncoderVifLearned: (vifIp) => {
        // Fired the FIRST time a frame for this vif arrives on the wire.
        // Install the vif-specific reply route + MASQUERADE here:
        void applyVifPlan(runCommand, legPlan, vifIp);
    },
});
await relay.start();
await relay.stop();
```

**Provisioning order (backend):** open the leg TUN, apply the vif-independent
*base* plan (`applyLegPlan`: egress table with the uplink gateway, the `iif`
rule, FORWARD accepts) **before** `relay.start()`, then apply the *vif* plan
(`applyVifPlan`) from `onEncoderVifLearned`. On stop, remove the vif plan (if a
vif was learned) then the base (`removeVifPlan` + `removeLegPlan`).

`Factories throw only on obviously invalid input` (bad name, bad CIDR, port out
of range). Runtime failures (TUN open, socket bind) surface from `start()`.

## Non-blocking TUN reads

`Bun.file(fd).stream()` — a TUN fd is a character device that never signals EOF,
so the stream emits one chunk per packet for the device's lifetime. With
`IFF_NO_PI`, each chunk is exactly one IPv4 packet (no 4-byte packet-info
prefix). The fd is opened with `node:fs.openSync`; the `ioctl(TUNSETIFF)` is
loaded from libc via FFI on first use and guarded so a build without the FFI
type API fails with a clear message from `start()`.

## Performance

-   **0 bytes allocated per packet** on the forward hot path (pre-allocated
    `rxBuf`/`txBuf`; `writeDataHeader` + typed-array `.set`, no
    `Buffer.concat`/`Buffer.from`). Verified: heap slope < 1 KB / 10k packets.
-   **0 `await`s** on the hot path; the `onEncoderVifLearned` callback fires
    once per vif and never blocks forwarding.
-   See `bench/bench.ts` + `bench/BASELINE.md` for measured pps / CPU / p99.

## Platform

Linux only. The factories throw on other platforms (unit tests inject a mock
`tunDevice` to run the packet logic anywhere).

## Testing

```sh
bun test shared/lib/udp_relay/test
```

-   `protocol.test.ts` / `ip.test.ts` — byte-exact framing & checksums.
-   `relay.test.ts` — pure forwarding decisions, loopback round trip, and
    `onEncoderVifLearned` (once per distinct vif from the frame header).
-   `nat_rules.test.ts` — the leg base/vif command plans (gateway egress,
    MASQUERADE keyed on the learned vif, idempotent add/remove).
-   `vif_source_route.test.ts` — the encoder-side per-source egress plan
    (`from <vifIp>` rule + `default dev <tun>` in table 20+n).
-   `virtual-interface.test.ts` — packet logic via the mock TUN seam.
-   `tun-linux.test.ts` — struct layout, no root required.

## Pitfalls

-   **Bind `0.0.0.0` for the relay, never a specific uplink IP** — that is what
    makes the relay NIC-agnostic. The *encoder* must bind a real address
    (never `0.0.0.0`) or its packets leak out the default route.
-   **The encoder vif IP needs a per-source egress route** — a source bound to
    `10.{90+x}.{y}.1` fails the FIB lookup (ENETUNREACH) unless
    `ip rule from <vifIp>` steers it onto the TUN. `vif_source_route.ts`
    provisions that (table 20+n); without it the TUN never sees srtla traffic.
-   **`IFF_NO_PI` is mandatory** — without it the kernel prepends 4 bytes and
    every parse is garbage.
-   **Key NAT + the reply route on the encoder vif**, learned from the first
    frame — not the uplink's own IP (the b6db3 dead end).
-   **The egress table must carry the uplink gateway** (`default via <gw> dev
    <uplink>`) or a public/CGNAT destination ARPs for the peer directly on-link
    and fails.
-   `ip link del` while the fd is open is fine (Linux removes the interface on
    the last close); the library closes the fd first.
-   There is no WebSocket Moblink relay protocol — UDP only.
