# Reference notes — `datagutt/moblink-rust`

What we **adopted** from the moblink-rust relay, and where. We adopted the
concepts, not the code. The Rust relay (`src/relay.rs`, `src/streamer.rs`) is
an **L4 UDP-payload forwarder** between two sockets; our library is a
**transparent L3 bridge** (frames carry full IPv4 packets; the kernel is the
NAT/routing layer). So we adopt the *shape* of its hot path, not its exact
two-socket model.

## 1. Single socket per flow, `0.0.0.0` bind

**Adopted.** moblink-rust binds `UdpSocket::bind("0.0.0.0:…")` for the
streamer-facing end (`src/relay.rs:372`, `src/streamer.rs:323`) so it is reached
on whatever NIC the peer used. Our `createUdpRelay` binds its listener to
`listenAddress` (default `"0.0.0.0"`) for exactly this reason — the relay is
NIC-agnostic, one leg per uplink selected by `ip rule`, not by bind address.

## 2. Kernel routing is authoritative — no raw socket, no user-space NAT

**Adopted (and the primary win).** The Rust relay does **not** touch IP headers:
the forward loop is `recv_from(&mut buf)` → `send_to(&buf[..size], …)`
(`src/relay.rs:445-448`), no checksums, no `IP_HDRINCL`, no `SO_BINDTODEVICE`.
We removed the old `openIfaceRawSocket` raw-socket path and the user-space
`natPacketSource`/`natPacketDestination` (SNAT/dNAT) helpers entirely — the
kernel now does NAT + routing via conntrack MASQUERADE and the leg `ip rule`
tables (see `NAT.md`). A packet costs one UDP callback + one TUN write.

## 3. Allocation-free forward loop with a reusable buffer

**Adopted.** moblink-rust reuses `let mut buf = [0; 2048]` across the whole
loop (`src/relay.rs:440`) — no per-packet allocation. We mirror this with
per-instance `rxBuf`/`txBuf` (65535) in `relay.ts`: the TUN delivers into
`rxBuf`, the frame is assembled into `txBuf` via `writeDataHeader` +
typed-array `.set` (no `Buffer.concat`/`Buffer.from`/`new Uint8Array` on the hot
path). Verified: heap slope < 1 KB / 10k packets (`bench/bench.ts`).

## 4. Event-driven, no per-packet blocking

**Adopted.** Rust polls the socket on the tokio runtime (the `recv` is the only
`await`, and it's the point of the loop). Our listener is a `Bun.udpSocket` whose
data callback fires per datagram; the forwarding path (`onListenEvent` /
`onTunPacket`) is **synchronous** — no `await` per packet. The only async work
is lifecycle (`start`/`stop`) and the once-per-vif `onEncoderVifLearned` callback
(fire-and-forget; never blocks forwarding).

## What we did **not** adopt

-   **The two-socket L4 model.** Rust keeps a separate "destination" socket
    (`local_bind_addr_for_destination`) because it forwards opaque UDP payloads.
    We use **one socket + one TUN** and let the kernel be the NAT/routing layer,
    which removes the second socket (and the per-flow `destination_addr`)
    entirely.
-   **The Rust wire protocol** (`src/protocol.rs` message framing) — out of
    scope per the irlctrl plan; we ship our own 8-byte L3 data-frame header.
-   **WebSocket control-plane reconnection** (`reconnect_on_tunnel_error`) — the
    irlctrl control channel lives in `moblink_relay`/`moblink_streamer` backend
    modules, not in the transport library.
