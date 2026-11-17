# CtrlIRL – Relay-to-Encoder Multi-Uplink Virtual Networking

## Engineering Handoff & Implementation Specification

**Project:** CtrlIRL (formerly Belabox Duo)
**Component:** `client-arm`
**Target roles:** `encoder`, `ctrlink_relay`
**Priority:** High
**Status:** ~~Architecture defined – implementation required~~ — **superseded.**

> **Superseded by the plain-UDP↔TUN IP tunnel.** Both host kernels
> (`5.10.160-belabox`, `5.15.61-v8+`) lack the `chacha20poly1305`/`x25519`
> kernel crypto-API transforms, so kernel WireGuard can never handshake on this
> hardware. The transport is now a small static Go pump
> ([`shared/lib/udpip/src/udpip.go`](../shared/lib/udpip/src/udpip.go)) that
> bridges a `utn-<if>` TUN and a UDP endpoint — no crypto, no kernel module,
> no key exchange (acceptable on the trusted relay↔encoder link; the relay pins
> a single peer). The per-uplink `/30` addressing, policy-route tables
> (`101+i`), and ports (base `51820`) from this spec are unchanged; netdevs are
> now `utn-<if>` (not `wg-<if>`) and the config key is `tunnel`
> (`wireGuard` kept as a compat alias). See
> [`shared/lib/udpip/`](../shared/lib/udpip/) and the two `ctrlink_*` modules.
>
> **Supervision:** the client pump binds a **deterministic** local port (same
> number as the relay's listen port), and the app respawns a dead pump on its
> `exit` (capped per vif). This is what makes a pump restart transparent: the
> relay pins a single `<clientIP>:<srcPort>`, so a stable source port means a
> respawned client resumes with no relay-side change. An ephemeral source
> port would break the pin on every client restart.

---

# 1. Mission

Implement a universal multi-uplink networking architecture that exposes physical Internet uplinks available on the **relay** as independent virtual network interfaces on the **encoder**.

The physical network interfaces belong to the relay, NOT the encoder.

The relay is connected to the encoder through a dedicated physical network interface (`eth1`).

The encoder must receive each available relay uplink as a separate virtual network interface with full bidirectional Internet connectivity.

Applications such as SRTLA must be able to use these virtual interfaces independently and simultaneously.

The architecture must support:

-   Ethernet uplinks
-   Cellular LTE / 4G uplinks
-   Cellular 5G uplinks
-   Wi-Fi uplinks
-   USB network adapters
-   Any other IP-capable physical interface on the relay
    The implementation must use one universal Layer 3 networking architecture.

It must not depend on Ethernet bridging or ARP support from cellular carriers.

# 2. Correct Physical Topology

## 2.1 Relay

The relay owns all physical uplink interfaces.

Example deployment:

InterfacePurpose`eth0`Ethernet Internet uplink`wwan0`Cellular Internet uplink`wlan0`Wi-Fi uplink`eth1`Dedicated connection to encoderExample relay address:

```
eth1 = 192.168.10.100
```

The relay's `eth1` connects directly to the encoder.

## 2.2 Encoder

The encoder does NOT own the physical uplinks being exposed.

Example:

```
eth0 = 192.168.10.104
```

The encoder receives virtual interfaces representing the relay's physical uplinks.

Example:

```
wg-eth0    -> relay eth0
wg-wwan0   -> relay wwan0
wg-wlan0   -> relay wlan0
```

These virtual interfaces must provide full Internet connectivity through their corresponding relay physical interfaces.

## 2.3 Architecture diagram

```
                         RELAY
                    CtrlIRL client-arm
                           |
          +----------------+----------------+
          |                |                |
        eth0             wwan0            wlan0
      Ethernet           LTE/5G           Wi-Fi
          |                |                |
          +----------------+----------------+
                           |
                    Routing + NAT
                           |
                   Dedicated eth1
                    192.168.10.100
                           |
                    Physical LAN
                           |
                    192.168.10.104
                           |
                        ENCODER
                    CtrlIRL client-arm
                           |
                  WireGuard interfaces
                           |
          +----------------+----------------+
          |                |                |
       wg-eth0          wg-wwan0          wg-wlan0
          |                |                |
          +----------------+----------------+
                           |
                         SRTLA
```

The WireGuard tunnels use the relay-to-encoder connection over `eth1` as their transport.

Each tunnel represents a different relay-side Internet egress.

# 3. Critical Architectural Principle

**The relay owns the physical uplinks. The encoder owns the virtual uplinks.**

Do not implement physical uplink discovery on the encoder as the source of these uplinks.

The relay must:

1. Discover its physical uplinks.
2. Create and manage their corresponding virtual network services.
3. Terminate the incoming virtual network tunnels.
4. Route traffic through the corresponding physical uplink.
5. Perform NAT.
6. Return traffic through the correct tunnel.
   The encoder must:

7. Discover available relay uplinks through the CtrlIRL control mechanism.
8. Establish one virtual interface per available relay uplink.
9. Maintain independent routing configurations.
10. Expose the interfaces to SRTLA.
11. Monitor connectivity independently.

# 4. Tunnel Technology

Use WireGuard for the Layer 3 tunnels.

Create one independent WireGuard tunnel for each relay uplink.

Example:

Relay physical interfaceEncoder virtual interface`eth0``wg-eth0``wwan0``wg-wwan0``wlan0``wg-wlan0`Each tunnel must have:

-   Unique keys and peer identity.
-   Unique tunnel addressing.
-   Independent routing configuration.
-   Independent health monitoring.
-   Independent relay egress mapping.
    All tunnels may use the same physical relay-to-encoder connection.

The tunnel endpoints must be reachable over the dedicated `eth1` connection.

# 5. Tunnel Addressing

Use a configurable private addressing scheme.

Example:

TunnelEncoderRelay`wg-eth0``10.200.1.2/30``10.200.1.1/30``wg-wwan0``10.200.2.2/30``10.200.2.1/30``wg-wlan0``10.200.3.2/30``10.200.3.1/30`The actual addressing must be allocated dynamically or from a persistent configuration.

Avoid collisions with existing local networks.

Each virtual interface must have its own IP address.

# 6. Relay Egress Mapping

This is a critical requirement.

Each incoming WireGuard tunnel must be associated with its corresponding physical relay uplink.

Example:

```
wg-eth0:
    ingress: WireGuard tunnel
    egress: relay eth0
    NAT: enabled

wg-wwan0:
    ingress: WireGuard tunnel
    egress: relay wwan0
    NAT: enabled

wg-wlan0:
    ingress: WireGuard tunnel
    egress: relay wlan0
    NAT: enabled
```

The relay must use independent routing and NAT policies.

Do not allow traffic arriving through `wg-wwan0` to silently leave through `eth0` unless an explicit fallback policy is configured.

The selected egress interface must be configurable.

If an uplink is unavailable, report it as unavailable instead of silently changing its identity.

# 7. Important Cellular Considerations

The relay's `wwan0` is a routed Layer 3 cellular interface.

Do not attempt to bridge it into an Ethernet network.

Do not depend on carrier ARP behavior.

The relay must route traffic directly through its cellular interface.

Dynamic cellular IP changes must not require rebuilding unrelated WireGuard tunnels.

WireGuard tunnel addressing must remain independent of the carrier-assigned IP address.

If the relay's cellular interface is unavailable or has no Internet connectivity, its corresponding encoder virtual interface must report degraded or offline status.

# 8. Encoder Routing

The encoder must have a separate routing table for every virtual uplink.

Example:

```
101: relay_eth0
102: relay_wwan0
103: relay_wlan0
```

Example routes:

```
ip route add default dev wg-eth0 table 101
ip route add default dev wg-wwan0 table 102
ip route add default dev wg-wlan0 table 103
```

Configure appropriate routing rules.

The encoder must be able to send traffic through each virtual interface independently.

Example:

```
ping -I wg-eth0 8.8.8.8
ping -I wg-wwan0 8.8.8.8
ping -I wg-wlan0 8.8.8.8
```

Do not install conflicting global default routes.

The WireGuard outer UDP traffic must always use the physical connection between encoder and relay (`eth1` on relay).

Prevent routing loops.

Use explicit endpoint routes or appropriate socket/packet marks where necessary.

# 9. Relay Policy Routing and NAT

For each tunnel:

1. Accept packets from the corresponding WireGuard interface.
2. Associate packets with the correct egress uplink.
3. Route them through the corresponding physical interface.
4. Apply SNAT or MASQUERADE.
5. Track connections.
6. Return response packets through the corresponding tunnel.
   Example conceptual flow:

```
Encoder application
       |
       v
wg-wwan0
       |
       v
WireGuard transport over eth1
       |
       v
Relay WireGuard termination
       |
       v
Policy routing
       |
       v
Relay wwan0
       |
       v
Internet
```

Return traffic:

```
Internet
   |
   v
Relay wwan0
   |
   v
Conntrack / NAT
   |
   v
wg-wwan0
   |
   v
WireGuard over eth1
   |
   v
Encoder application
```

Use nftables if compatible with the existing deployment.

Firewall rules must be idempotent.

Do not create duplicate rules after restarts.

# 10. WireGuard Transport and Routing Isolation

All WireGuard tunnel endpoints must use the dedicated relay-to-encoder network.

For example:

```
Relay eth1:   192.168.10.100
Encoder eth0: 192.168.10.104
```

The outer WireGuard UDP packets must be routed over this connection.

They must never be routed through the virtual uplink they transport.

Use:

-   Explicit endpoint routes.
-   Appropriate routing tables.
-   Socket or packet marks if needed.
-   WireGuard configuration with automatic route management disabled where appropriate.
    Do not confuse the WireGuard transport path with the Internet egress path.

These are two separate networking functions.

# 11. SRTLA Integration

SRTLA must see the encoder virtual interfaces as separate uplinks.

Example:

```
SRTLA
  |
  +-- wg-eth0  -> relay eth0 Internet
  |
  +-- wg-wwan0 -> relay wwan0 Internet
  |
  +-- wg-wlan0 -> relay wlan0 Internet
```

Inspect the existing SRTLA implementation before modifying it.

Determine how it handles:

-   Interface discovery.
-   Socket binding.
-   Source IP selection.
-   `SO_BINDTODEVICE`.
-   Multiple sockets.
-   UDP transmission.
    Do not assume that SRTLA automatically discovers WireGuard interfaces.

Verify that SRTLA can use each interface simultaneously.

The virtual interfaces must provide independent Internet paths, not merely tunnel connectivity.

# 12. Dynamic Relay Uplink Discovery

Uplink discovery must happen on the relay.

Monitor:

-   Interface creation and deletion.
-   Physical link state.
-   IP address changes.
-   Default gateway changes.
-   DHCP renewals.
-   ModemManager events.
-   Cellular reconnects.
-   Internet reachability.
    When a new physical uplink appears on the relay:

1. Detect it.
2. Determine its interface type.
3. Verify local connectivity.
4. Allocate a tunnel identity.
5. Configure the corresponding WireGuard service.
6. Configure routing and NAT.
7. Announce the uplink to the encoder.
8. Create the corresponding virtual interface on the encoder.
9. Verify Internet connectivity.
   When a relay uplink disappears:

10. Mark the virtual uplink unavailable.
11. Notify the encoder.
12. Remove or disable the affected virtual interface safely.
13. Remove only the corresponding routes and firewall rules.
14. Preserve all unrelated tunnels.

# 13. Uplink Manager

Implement a dedicated networking manager inside `client-arm`.

Suggested architecture:

```
Relay:
  RelayUplinkManager
    |
    +-- PhysicalInterfaceDiscovery
    +-- UplinkHealthMonitor
    +-- WireGuardServerManager
    +-- EgressRoutingManager
    +-- NatManager
    +-- UplinkAnnouncementManager

Encoder:
  VirtualUplinkManager
    |
    +-- RelayUplinkDiscovery
    +-- WireGuardClientManager
    +-- VirtualInterfaceManager
    +-- PolicyRoutingManager
    +-- UplinkHealthMonitor
    +-- RecoveryManager
```

These are logical responsibilities. Follow existing project conventions.

All operations must be idempotent.

Recommended operations:

```
discoverRelayUplinks()
announceUplink()
createVirtualUplink()
removeVirtualUplink()
getUplinkStatus()
reconcile()
getDiagnostics()
```

# 14. Control Plane Integration

Use the existing CtrlIRL control infrastructure to exchange uplink configuration and status.

The relay should announce:

-   Physical interface name.
-   Interface type.
-   Availability.
-   Tunnel identity.
-   Tunnel addressing.
-   Configuration version.
-   Health status.
    The encoder should acknowledge:

-   Tunnel creation.
-   Interface creation.
-   Routing configuration.
-   Connectivity status.
    Do not expose private WireGuard keys through public APIs.

Use secure key provisioning and authenticated configuration exchange.

The control plane must not be required for forwarding already-established tunnel traffic.

# 15. Configuration

Persist configuration using the existing CtrlIRL configuration mechanism.

Example conceptual relay configuration:

```
{
  "networking": {
    "enabled": true,
    "backend": "wireguard",
    "transportInterface": "eth1",
    "uplinks": {
      "eth0": {
        "enabled": true,
        "virtualInterface": "wg-eth0",
        "egress": "eth0"
      },
      "wwan0": {
        "enabled": true,
        "virtualInterface": "wg-wwan0",
        "egress": "wwan0"
      }
    }
  }
}
```

Example conceptual encoder configuration:

```
{
  "networking": {
    "enabled": true,
    "relayEndpoint": "192.168.10.100",
    "uplinks": {
      "eth0": {
        "enabled": true,
        "virtualInterface": "wg-eth0",
        "routingTable": 101
      },
      "wwan0": {
        "enabled": true,
        "virtualInterface": "wg-wwan0",
        "routingTable": 102
      }
    }
  }
}
```

These are illustrative schemas.

Adapt them to the existing project configuration format.

# 16. MTU and Performance

Configure MTU per virtual interface.

Account for:

-   WireGuard overhead.
-   Physical transport MTU.
-   Cellular MTU.
-   UDP encapsulation.
-   Path MTU discovery.
    Avoid unnecessary packet processing.

This is a real-time streaming application, so performance and latency are important.

# 17. API and UI

Expose relay physical uplinks and encoder virtual uplinks through existing APIs.

The UI should clearly distinguish:

**Relay:**

-   Physical interface.
-   Physical connection state.
-   Assigned IP.
-   Internet reachability.
-   Selected egress.
    **Encoder:**

-   Virtual interface.
-   Associated relay uplink.
-   Tunnel state.
-   Internet reachability.
-   Routing status.
-   SRTLA availability.
    An existing WireGuard interface or successful handshake must not automatically be reported as full Internet connectivity.

# 18. Deployment Requirements

Inspect the existing Armbian/Linux deployment and Docker configuration.

Verify:

-   WireGuard kernel support.
-   `wg` availability.
-   `iproute2`.
-   nftables or existing firewall tooling.
-   Required capabilities.
-   Root privileges where necessary.
    The relay requires permissions to configure physical interface routing, WireGuard, forwarding and NAT.

The encoder requires permissions to manage its virtual interfaces and routing.

Preserve the existing deployment and security model wherever possible.

# 19. Migration

> **Status: complete.** The GRETAP L2 transport has been fully removed; per-uplink
> WireGuard vifs (`wg-<if>`) are now the sole ctrlink transport. The legacy
> GRETAP implementation never represented the final architecture and is no longer
> present in the tree.

Migration requirements (all done):

1. Inspect existing GRETAP code.
2. Preserve the currently working relay-to-encoder connection.
3. Implement WireGuard as the new networking backend.
4. Keep the existing management/control connection operational.
5. Implement independent relay egress routing.
6. Verify each virtual uplink.
7. Verify SRTLA compatibility.
8. ~~Remove obsolete GRETAP uplink functionality only after successful migration.~~ — done.
9. Provide rollback.
   Do not let the new virtual uplink routes replace or disrupt the physical relay-to-encoder management connection.

# 20. Acceptance Tests

## A. Physical discovery

Verify that relay physical interfaces are discovered correctly.

The encoder must not require physical access to these interfaces.

## B. Independent Internet connectivity

Run on the encoder:

```
ping -I wg-eth0 8.8.8.8
ping -I wg-wwan0 8.8.8.8
```

Test public IP:

```
curl --interface wg-eth0 https://api.ipify.org
curl --interface wg-wwan0 https://api.ipify.org
```

When the relay uplinks use different public IP addresses, verify that the virtual interfaces expose the corresponding egress IP addresses.

If multiple relay uplinks share the same upstream public IP, verify routing independently using relay-side packet captures and counters instead.

## C. Egress isolation

Verify:

-   Traffic through `wg-eth0` exits relay `eth0`.
-   Traffic through `wg-wwan0` exits relay `wwan0`.
-   Traffic cannot silently switch to another uplink.
-   Return traffic uses the correct tunnel.

## D. Failure isolation

Disable relay `wwan0`.

Expected:

-   `wg-wwan0` becomes unavailable.
-   `wg-eth0` remains operational.
-   Existing encoder-to-relay management connectivity remains operational.
    Restore `wwan0`.

Expected:

-   Its tunnel and Internet connectivity recover automatically.
-   Other tunnels are unaffected.

## E. Dynamic cellular IP

Change the relay cellular IP.

Expected:

-   No unrelated tunnel is recreated.
-   Routing is updated.
-   The virtual cellular uplink recovers.
-   No duplicate firewall or routing rules appear.

## F. SRTLA

Verify:

-   SRTLA can independently use each virtual interface.
-   Multiple virtual uplinks operate simultaneously.
-   Traffic exits through the intended relay physical interfaces.
-   Loss of one uplink does not disrupt the remaining uplinks.

## G. Stability

Run multi-hour tests and record:

-   Tunnel uptime.
-   Packet loss.
-   Latency.
-   Throughput.
-   CPU usage.
-   Memory usage.
-   Cellular reconnect behavior.
-   Interface recreation.
-   SRTLA stability.

# 21. Implementation Order

**Phase 1 – Repository inspection**

Inspect the existing networking implementation and identify the actual relay/encoder responsibilities.

**Phase 2 – Relay physical uplink discovery**

Implement physical interface detection and health monitoring on the relay.

**Phase 3 – WireGuard tunnel infrastructure**

Implement one tunnel per relay physical uplink.

**Phase 4 – Relay egress routing**

Implement independent routing, forwarding and NAT for each tunnel.

**Phase 5 – Encoder virtual interfaces**

Implement automatic tunnel creation and virtual interface management.

**Phase 6 – SRTLA integration**

Verify actual interface binding and simultaneous uplink usage.

**Phase 7 – Control plane and UI**

Implement uplink announcement, configuration synchronization, status and diagnostics.

**Phase 8 – Recovery and testing**

Implement failure recovery and execute all acceptance tests.

**Phase 9 – Migration (complete)**

The old GRETAP-based uplink architecture was replaced with the unified L3 WireGuard solution and GRETAP was removed.

# 22. Engineering Constraints

1. Physical uplinks are on the relay, not the encoder.
2. `eth1` on the relay is the transport connection to the encoder.
3. All virtual uplinks must be created on the encoder.
4. Every virtual uplink must map to exactly one relay physical egress.
5. Use Layer 3 networking, not Ethernet bridging.
6. Do not depend on cellular ARP.
7. Do not allow unintended egress switching.
8. Do not create routing loops.
9. Do not disrupt the management connection.
10. Do not recreate unrelated tunnels during recovery.
11. Preserve existing CtrlIRL roles, APIs, configuration and streaming functionality.
12. Inspect the actual repository before implementing.
13. Implement working functionality, not just architectural placeholders.

# 23. Final Deliverables

The implementation agent must deliver:

-   Relay physical uplink discovery.
-   WireGuard tunnel management.
-   Encoder virtual uplink management.
-   Independent relay egress routing.
-   NAT and forwarding.
-   Control plane synchronization.
-   Automatic recovery.
-   SRTLA integration.
-   API and UI integration.
-   Deployment updates.
-   Automated or reproducible network tests.
-   Migration and rollback instructions.
    Include a final implementation report listing modified files, architecture decisions, deployment commands, test results and remaining limitations.

---

# Definition of Done

Every physical Internet uplink available on the CtrlIRL relay must be exposed as an independent virtual network interface on the encoder.

Each virtual interface must provide full bidirectional Internet connectivity through its corresponding physical relay uplink.

SRTLA must be able to use all available virtual interfaces simultaneously as separate uplinks.

The relay-to-encoder connection must remain operational independently of the virtual uplinks.

The system must automatically recover from physical link failures, dynamic IP changes and modem reconnections without disrupting unrelated uplinks.

The implementation must work with Ethernet, Wi-Fi, LTE and 5G without requiring technology-specific tunneling architectures.

**Start by inspecting the actual CtrlIRL repository. Validate the existing architecture and implement the complete solution rather than stopping at a design proposal.**

• Adjust the WireGuard MTU: Cellular networks (4G/5G) use smaller packet sizes than home broadband. Add MTU = 1360 (or 1280 if you still see frame drops) under the [Interface] section in wg0.conf to prevent packet fragmentation.
• Set PersistentKeepalive: Cellular NAT tables drop idle connections quickly. Add PersistentKeepalive = 15 or 25 under the [Peer] section to keep the tunnel open during brief signal dips.
