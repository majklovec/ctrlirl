# Manual smoke test (relay leg, kernel NAT)

Run on the **relay host** (the multi-uplink box). The relay process itself runs
unprivileged — root / `NET_ADMIN` is only needed to install the rules from
`NAT.md` (the `moblink_relay` backend does that via `core.run`).

> Proven live on the `bigcml` 3-leg host: mobile CGNAT leg `enx76ae…`
> (172.21.254.230, gw 172.21.254.48, port 4003, TUN `relay1_enx76ae2`, table 41),
> home leg `eno2`, and `wg0`. This document is the reproducible version of that.

## 0. Prerequisites

```sh
sudo sysctl -w net.ipv4.ip_forward=1
# rp_filter may be strict; the non-local vif passes it (no relaxation needed).
```

## 1. Start the relay on a real interface with the NAT.md rules

The `moblink_relay` module provisions each eligible uplink automatically
(base plan up-front, vif plan on first frame). To inspect a leg after it learns a
vif (e.g. mobile leg, slot 1):

```sh
# Egress pin (should show `via 172.21.254.48 dev enx76ae…`, table 41):
ip route show table 41
ip rule show | grep rtltun_eno1
# Learned vif (appears after the first encoder frame), e.g. 10.90.1.1:
ip route show | grep '10.90.1.1'
sudo iptables -t nat -S POSTROUTING | grep MASQUERADE | grep 10.90.1.1
```

## 2. Verify the forward (outbound) path

`ip route get iif <tun> from <vif> to <public-dest>` is the definitive egress-pin
check — it must pick the leg table:

```sh
ip route get iif rtltun_eno1 from 10.90.1.1 to 144.91.123.190
# expected: via 172.21.254.48 dev enx76ae… table 41
```

Capture the uplink while firing a probe frame and confirm it leaves NAT'ed to the
uplink IP (not the raw vif):

```sh
sudo timeout 6 tcpdump -n -i enx76ae207e3de7 'src 172.21.254.230 and udp'  # &
# fire a probe frame (src = vif 10.90.1.1) to the relay listener port 4003;
# expect N packets as 172.21.254.230.???? -> 144.91.123.190.5000, 0 raw-vif.
```

## 3. Verify the reply path (round trip)

Inject a `VPS → vif` IPv4 reply so it routes back into the TUN, and confirm the
relay frames it and hands it to the encoder's UDP endpoint:

```sh
# reply route must be present:  10.90.1.1 dev rtltun_eno1
ip route show 10.90.1.1
```

A local end-to-end probe (encoder socket + a VPS-equivalent reply) should print
`ENCODER-RECV …b from 127.0.0.1:4003 (reply path OK)`:

```sh
bun /tmp/probe_reply_path.ts   # see the live-verification probes
```

## 4. Confirm no root requirement for the relay process

Start the relay client *unprivileged* (rules already present) — it should serve
the leg without `sudo`. (Only the backend's rule provisioning and `ip`/TUN
setup need `NET_ADMIN`.)

```sh
CONFIG_FILE=/tmp/config.json bun run dev:client   # unprivileged
```

## 5. Tear down / verify idempotency

`stopRelay`/`stopAll` remove the vif plan (if learned) then the base. Re-running
the provision is a no-op (every `add`/`insert` is preceded by a best-effort
`del`). A crash leaves stale `rtltun_*` (or legacy `rltun<N>` / `relay*_<iface>`) TUNs, removed on next startup by
`sweepStaleLegTuns`.

## Acceptance checklist

-   [ ] `ip route get iif <tun> … to <dest>` picks the leg table (egress pin).
-   [ ] Upstream capture shows packets NAT'ed to the uplink IP, 0 raw-vif leaks.
-   [ ] Reply to the vif routes into the TUN and comes back framed to the encoder.
-   [ ] Relay process runs unprivileged once the rules exist.
-   [ ] Full `test_relay_chain.sh all` end-to-end (needs the rpi4 encoder side up).
