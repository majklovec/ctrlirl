# Relay leg kernel provisioning (NAT / routing / forwarding)

This is the kernel side the **`moblink_relay` backend** installs *around*
`createUdpRelay()`. The library itself is rootless — `nat_rules.ts` builds pure
command plans (`planLegBaseCommands`, `planVifCommands`, …) and the backend
applies them through an elevated command runner (`core.run`). Nothing here runs
in the packet hot path.

## Why the kernel does this

A relay leg is a transparent L3 bridge: the encoder's vif /32 (`10.{90+x}.{y}.1`)
is SNAT'ed to the uplink's source and egresses on one uplink NIC; the reply is
steered back through the leg TUN. Doing this in the kernel (routing + conntrack)
means the user-space forward path is just **one UDP callback → one TUN write**.
There is no raw socket, no `SO_BINDTODEVICE`, no user-space SNAT/dNAT map.

**TUN naming split:** the relay box's leg TUNs are `rtltun_<iface>`
(`rtltun_eth0`, `rtltun_wwan2`, ...) - named after the physical uplink the
leg exits through; the `rltun<R>_<iface>` names (`CTRLINK_TUN_NAME_RE`) exist
ONLY on encoders - those are the virtual interfaces `srtla_send` sends
through. The names must not mix: `isCtrlinkTun()` excludes both from the
"own interfaces" listings (the relay must never pick its own leg TUNs up as
new uplinks).

```
encoder → UDP → [relay 0.0.0.0:port] → TUN (vif /32)
    → ip rule iif <tun> table <T>
    → (table T) default via <gw> dev <uplink>
    → MASQUERADE -s <vif>/32 -o <uplink>   → uplink NIC
reply  → conntrack de-NAT (dst = vif)
    → (main) to <vif>/32 dev <tun>         → TUN → relay → encoder
```

## Two-phase install

The vif is the **encoder's** dedicated, **non-local** address. The relay cannot
derive it (`10.{90+x}.{y}.1` needs the ordinals x, y, known only to the
encoder), so provisioning is split:

1. **Base plan** (`planLegBaseCommands` → `applyLegPlan`) — vif-independent,
   applied **up-front** at `startRelay` *before* `relay.start()`:
   the egress table (with the uplink gateway), the `iif` pin, and the FORWARD
   accepts.
2. **Vif plan** (`planVifCommands` → `applyVifPlan`) — applied **on learn**,
   when `onEncoderVifLearned(vifIp)` fires the first time a frame for that vif
   arrives. It installs the reply route + MASQUERADE **keyed on the learned
   vif**.

Table numbering: legs use tables `40 + slot` (always `< 100`; the `network`
module claims `>= 100`).

## Rule sets

Notation: `slot=1` (table `41`), `tun=rtltun_eno1`, `uplink=eno1`,
`gw=172.21.254.48`, `vif=10.90.1.1` (learned).

### 1. Base plan (vif-independent)

**iptables / iproute2:**

```bash
# Egress pin: packets arriving on the TUN exit the uplink (via its gateway).
ip route    del default table 41                 # best-effort (idempotent)
ip route add default via 172.21.254.48 dev eno1 table 41
# Pin egress to that table for packets arriving on this TUN.
ip rule     del lookup 41                          # best-effort
ip rule     add iif rtltun_eno1 table 41
# FORWARD accepts (host default policy is DROP under Docker).
iptables -D  FORWARD -i rtltun_eno1 -j ACCEPT  # best-effort
iptables -I  FORWARD 1 -i rtltun_eno1 -j ACCEPT
iptables -D  FORWARD -o rtltun_eno1 -j ACCEPT  # best-effort
iptables -I  FORWARD 2 -o rtltun_eno1 -j ACCEPT
```

> **The gateway is required.** `default via <gw> dev <uplink>` — not
> `default dev <uplink>`. A no-gateway (`scope link`) default makes the kernel
> ARP for the *destination* directly on the uplink segment, which fails for a
> public/CGNAT peer (observed: ARP `FAILED`, ~1-in-many egress). With the
> gateway: reliable 3/3 egress. Omit the gateway only for a directly-attached
> / link-local uplink (e.g. a `wg0` WireGuard leg whose peer is on-link).

**nftables equivalent** (routing is iproute2; only the FORWARD rule differs):

```bash
nft add table ip forward
nft add chain ip forward { type filter hook forward priority 0; policy accept; }
nft add rule  ip forward iifname "rtltun_eno1" accept
nft add rule  ip forward oifname "rtltun_eno1" accept
```

### 2. Vif plan (applied on learn, keyed on the learned vif)

**iptables / iproute2:**

```bash
# Reply routing: the vif /32 is local to the leg TUN (main table).
ip route del 10.90.1.1/32 dev rtltun_eno1      # best-effort
ip route add 10.90.1.1/32 dev rtltun_eno1
# Conntrack NAT: masquerade the encoder vif to the uplink's source.
iptables -t nat -D POSTROUTING -s 10.90.1.1/32 -o eno1 -j MASQUERADE  # best-effort
iptables -t nat -I POSTROUTING 1 -s 10.90.1.1/32 -o eno1 -j MASQUERADE
```

**nftables equivalent** (masquerade in the nat table):

```bash
nft add table ip nat
nft add chain ip nat postrouting { type nat hook postrouting priority 100; policy accept; }
nft add rule ip nat postrouting ip saddr 10.90.1.1 oifname "eno1" masquerade
```

(Replies need no DNAT: conntrack de-NATs the postrouting masquerade on the way
in, so a reply to `10.90.1.1` arrives back at the TUN — the `to` route just tells
the main table which device to use.)

### Teardown

-   **Vif** (`planVifRemoval` → `removeVifPlan`): `ip route del <vif>/32 dev <tun>`
    + the `-t nat -D ... MASQUARADE`.
-   **Base** (`planLegRemoval` → `removeLegPlan`): `ip rule del lookup <T>` +
    `ip route del default table <T>` + the two `-D FORWARD` deletes.
-   **Stale TUNs** (`sweepStaleLegTuns`): on startup, `ip link del` any TUN
    matching the leg patterns (`rtltun_<iface>`, plus the legacy `rltun<N>` and
    `relay\d+_<iface>` names from older versions) left by a crashed run. A
    relay host never runs encoder-side tunnels (`rltun<R>_<iface>`), so a TUN
    matching any of these patterns here is stale.

All `add`/`insert` steps are preceded by a best-effort `del` so the plans are
idempotent; real `add` failures throw (the `del` failures are ignored).

## Why NOT the uplink's own IP as the vif (the b6db3 dead end)

The first single-socket build set `vif = <uplink's own local IP>` (e.g.
`172.21.254.230`). That broke in **both** directions:

-   `MASQUERADE -s <uplink-IP> -o uplink` is a **source-identity no-op** (src
    already equals the egress IP).
-   The uplink IP is a **local** address (`ip route get <it>` → `local … dev lo`),
    so a packet entering the TUN with that source fails **strict `rp_filter`**
    (reverse route → `lo`, not the TUN): dropped **before** `FORWARD`.
-   A reply *to* the uplink IP is a **local** delivery — never forwarded to the
    TUN.

Keying on the encoder's dedicated, non-local vif (`10.{90+x}.{y}.1`) fixes all
three: it passes strict reverse-path filter (the reply route `to <vif>/32 dev
tun` is the authoritative reverse), is genuinely NAT'ed to the uplink source,
and the reply is a forward (not a local delivery) back into the TUN. Verified
live on a mobile CGNAT leg in both directions under strict `rp_filter=2`.

## `nat` config knob

`config().nat` (default `true`) gates only the MASQUERADE + the vif reply route
(§6.2 of the plan: "NAT is the deployment layer's job"). `nat=false` leaves the
FORWARD + routing path in place so a leg whose vif is directly reachable by the
uplink still works. Routing + FORWARD are always installed.

## Prerequisites

-   `net.ipv4.ip_forward=1` on the relay host.
-   `rp_filter` may be loose (1) or strict (2) — the non-local encoder vif
    passes strict filter because the reply `to` route is installed. No
    relaxation required.
-   Root / `NET_ADMIN` to apply the plans (a deployment concern, not the
    library's). The relay process itself runs unprivileged once the plans exist.
