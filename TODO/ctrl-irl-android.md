# Implementation Handoff: TUN-less CtrLink UDP Relay for Android

**Project:** CtrlIRL  
**Target:** Android relay implementation  
**Audience:** AI coding agent / senior Android networking developer  
**Language:** Kotlin, with native code only if demonstrably necessary  
**Architecture:** Userspace IPv4/UDP translation  
**Root:** Not required  
**TUN:** Not required  
**VPNService:** Not required  
**Protocol:** Existing CtrLink protocol — unchanged  
**Traffic scope:** UDP only, specifically SRTLA

---

# 1. Objective

Implement the existing CtrLink relay functionality on Android without requiring a TUN interface, Android `VpnService`, root privileges, or kernel-level IP forwarding.

The existing CtrLink encoder and its UDP tunnel protocol must remain unchanged.

The Android relay must receive existing CtrLink UDP frames containing IPv4 packets, extract their UDP datagrams, forward those datagrams through ordinary Android UDP sockets, receive responses, reconstruct the corresponding IPv4/UDP packets, and encapsulate them using the original CtrLink wire protocol.

This is a specialized userspace UDP/IP translator, not a general-purpose IP router.

**Do not replace CtrLink with Moblink, SOCKS5, WireGuard, or another tunneling protocol.**

# 2. Existing Project

Repository:

https://github.com/majklovec/ctrlirl

Relevant source:

-   `shared/lib/udp_relay`
-   `shared/lib/udp_streamer`
-   Existing protocol definitions and headers
-   Android relay application

Before implementation, inspect the current repository and establish the actual architecture and protocol.

The existing C implementation is authoritative.

Do not assume the protocol format described in previous design documents is correct without verification.

# 3. Architectural Requirements

## 3.1 Preserve the existing CtrLink protocol

The following must remain compatible:

-   UDP framing.
-   Frame types.
-   Header layout.
-   Byte order.
-   VIF IP representation.
-   Keepalive behavior.
-   Peer identification.
-   Peer discovery and learning.
-   Return traffic encapsulation.

The encoder must not require modifications.

Do not introduce a new handshake, framing format, or Moblink-compatible transport.

## 3.2 Remove the TUN dependency

The Android implementation must not depend on:

-   `/dev/net/tun`
-   `VpnService`
-   `ParcelFileDescriptor` for TUN
-   `iptables`
-   `ip rule`
-   Kernel NAT
-   Root permissions
-   A userspace TCP/IP stack

Instead, implement a minimal IPv4/UDP packet translator.

## 3.3 Target architecture

```text
                    ENCODER
                       |
                       |
                Existing CtrLink
                 UDP tunnel protocol
                       |
                       |
                       v
+------------------------------------------------+
|                ANDROID RELAY                   |
|                                                |
|  Existing CtrLink UDP receiver                 |
|                 |                              |
|                 v                              |
|          FramingCodec                          |
|                 |                              |
|                 v                              |
|          IPv4 Packet Parser                    |
|                 |                              |
|                 v                              |
|          UDP Packet Parser                     |
|                 |                              |
|                 v                              |
|          UDP Flow Manager                      |
|                 |                              |
|                 v                              |
|          Android UDP Socket Manager            |
|                 |                              |
|          +------+------+                       |
|          |             |                       |
|       Uplink 1      Uplink 2                   |
|          |             |                       |
|        eth0          wwan0                     |
|          |             |                       |
|          +------+------+                       |
|                 |                              |
|                 v                              |
|          Internet / SRTLA Server               |
|                 |                              |
|                 v                              |
|          UDP Response Handler                  |
|                 |                              |
|                 v                              |
|          IPv4/UDP Packet Builder               |
|                 |                              |
|                 v                              |
|          Original CtrLink Encoder              |
|                 |                              |
+-----------------+------------------------------+
                  |
                  v
               ENCODER
```

The architecture must support multiple independent uplinks.

Each UDP flow must retain its assigned uplink.

# 4. Packet Processing

## 4.1 Incoming direction: Encoder → Internet

1. Receive a UDP datagram using the existing CtrLink listener.
2. Decode it using the existing protocol implementation.
3. Extract the complete IPv4 packet.
4. Validate the IPv4 header.
5. Check that the packet contains UDP (`protocol = 17`).
6. Extract:
    - Original source IPv4 address.
    - Original destination IPv4 address.
    - Original UDP source port.
    - Original UDP destination port.
    - UDP payload.
7. Identify or create a UDP flow.
8. Select the appropriate uplink.
9. Create or reuse an Android UDP socket.
10. Bind the socket to the selected Android `Network`.
11. Send the UDP payload to the original destination address and port.

The Android networking stack performs actual IP routing, NAT and transmission.

The original virtual IP packet is not injected into the Android kernel.

## 4.2 Return direction: Internet → Encoder

1. Receive data from the Android UDP socket.
2. Identify the associated UDP flow.
3. Reconstruct the IPv4 packet.
4. Set:
    - Source IP = original destination IP.
    - Destination IP = original source IP.
    - Source port = original destination port.
    - Destination port = original source port.
5. Generate valid IPv4 and UDP checksums.
6. Encapsulate the reconstructed IPv4 packet using the original CtrLink protocol.
7. Send the resulting UDP frame to the original encoder peer.

The reconstructed packet must be compatible with the encoder's existing expectations.

# 5. UDP Flow Management

Implement a flow table.

Recommended key:

```kotlin
data class UdpFlowKey(
    val sourceIp: Int,
    val destinationIp: Int,
    val sourcePort: Int,
    val destinationPort: Int,
    val protocol: Int = 17
)
```

Recommended flow state:

```kotlin
data class UdpFlow(
    val key: UdpFlowKey,
    val vifIp: Int,
    val peerEndpoint: InetSocketAddress,
    val uplinkId: String,
    val network: Network,
    val socket: DatagramSocket,
    @Volatile var lastActivityNanos: Long
)
```

Requirements:

-   One stable socket mapping per flow and uplink.
-   Preserve the original UDP tuple.
-   Reuse sockets instead of allocating one per packet.
-   Update activity timestamps.
-   Expire inactive flows.
-   Close sockets when flows expire.
-   Handle network disconnection.
-   Prevent stale responses from being sent to expired peers.
-   Support concurrent flows.
-   Avoid holding global locks during network I/O.

The flow manager must be thread-safe.

Do not use packet-level random uplink selection.

A flow must stay on its assigned uplink unless an explicit migration policy is implemented.

# 6. Android Network Binding

The relay must use ordinary Android networking APIs.

Use:

```kotlin
network.bindSocket(socket)
```

Bind each socket to the selected Android `Network` before sending or connecting it.

The implementation must not bind the entire Android process to one network because multiple uplinks may be active simultaneously.

Implement an abstraction:

```kotlin
interface Uplink {
    val id: String
    val network: Network

    fun createUdpSocket(): DatagramSocket

    fun isAvailable(): Boolean
}
```

Implement:

```kotlin
class AndroidUplinkManager
```

Responsibilities:

-   Discover available networks.
-   Identify cellular and Wi-Fi networks.
-   Track network availability.
-   Maintain independent uplink state.
-   Create sockets bound to the correct network.
-   Detect network changes.
-   Notify the flow manager when an uplink disappears.

Use `ConnectivityManager.NetworkCallback`.

Important: Android's network binding must be performed before socket use. Do not use `VpnService.protect()` because this architecture does not use `VpnService`.

If the relay runs on a dedicated Android device, verify that Android exposes the required networks and permits the intended simultaneous socket usage.

# 7. Implementation Modules

Keep packet processing independent of Android APIs.

Recommended package structure:

```text
relay/
  protocol/
    FramingCodec.kt
    RelayFrame.kt

  packet/
    IPv4Parser.kt
    IPv4Builder.kt
    UdpParser.kt
    UdpBuilder.kt
    Checksum.kt

  flow/
    UdpFlowKey.kt
    UdpFlow.kt
    UdpFlowTable.kt
    UdpFlowManager.kt

  network/
    Uplink.kt
    AndroidUplink.kt
    AndroidUplinkManager.kt
    UdpSocketManager.kt

  engine/
    UdpRelayEngine.kt
    ReturnPacketHandler.kt

  service/
    RelayService.kt

  metrics/
    RelayStatistics.kt
```

## 7.1 FramingCodec

Reuse the existing protocol implementation wherever possible.

Do not implement a second interpretation of the CtrLink wire format.

The codec must support:

-   DATA frames.
-   KEEPALIVE frames.
-   Existing header semantics.
-   Existing byte ordering.
-   Existing packet size limits.

## 7.2 IPv4Parser

Implement a minimal IPv4 parser.

Requirements:

-   Validate IPv4 version.
-   Validate IHL.
-   Validate total length.
-   Validate header checksum.
-   Extract source and destination addresses.
-   Extract protocol.
-   Handle IPv4 fragmentation explicitly.

For the initial implementation, either:

-   Implement bounded IPv4 fragment reassembly, or
-   Reject fragmented packets with clear diagnostics.

Never silently interpret a non-initial fragment as a UDP packet.

## 7.3 UDP parser and builder

Implement:

-   UDP source port extraction.
-   UDP destination port extraction.
-   UDP length validation.
-   IPv4 UDP checksum validation.
-   UDP packet reconstruction.
-   Correct IPv4 header checksum generation.
-   Correct UDP checksum generation.

IPv4 UDP checksum zero must be handled according to IPv4 UDP semantics.

The implementation must not assume that all incoming packets have a valid or nonzero UDP checksum.

## 7.4 UdpSocketManager

Manage socket lifecycle.

Requirements:

-   Reuse sockets.
-   Bind to selected `Network`.
-   Maintain receive loops.
-   Associate responses with the correct flow.
-   Handle socket errors.
-   Support independent uplinks.
-   Close resources deterministically.

Use bounded buffers and avoid unnecessary per-packet allocations.

# 8. SRTLA-Specific Requirements

The initial implementation is specifically intended for UDP-based SRTLA traffic.

Do not implement TCP.

Do not implement SOCKS5.

Do not implement a generic proxy.

Do not implement arbitrary IP forwarding.

However, do not hardcode SRTLA payload formats unless the existing project explicitly requires it.

The relay should treat the UDP payload as opaque data.

Preserve:

-   UDP payload bytes.
-   Datagram boundaries.
-   Per-flow ordering where possible.
-   Original virtual endpoint information.
-   Correct return routing.

SRTLA may use multiple independent UDP flows. Ensure that the implementation does not accidentally merge them into a single flow or socket.

# 9. Important Networking Limitations

This architecture is an L4 UDP translator.

It is not transparent L3 forwarding.

The following limitations must be documented:

| Feature                                   | Support                     |
| ----------------------------------------- | --------------------------- |
| UDP                                       | Yes                         |
| SRTLA                                     | Target use case             |
| TCP                                       | No                          |
| ICMP                                      | No                          |
| Arbitrary IPv4 protocols                  | No                          |
| Original source IP preserved on Internet  | No                          |
| Original source port preserved externally | Not guaranteed              |
| Kernel NAT                                | Not required in application |
| TUN                                       | No                          |
| Root                                      | No                          |
| Multiple uplinks                          | Yes                         |

Android's network stack will create new external IP/UDP headers and may perform NAT.

The relay reconstructs the original virtual packet representation for return traffic.

Do not claim transparent IP routing.

# 10. Performance Requirements

The target is high-throughput IRL streaming.

Priorities:

1. Low latency.
2. Minimal packet loss.
3. Stable throughput.
4. Efficient CPU usage.
5. Low memory allocation.

Implementation requirements:

-   Reuse byte buffers.
-   Reuse UDP sockets.
-   Avoid unnecessary packet copies.
-   Use dedicated receive loops.
-   Avoid blocking the Android main thread.
-   Use bounded queues.
-   Implement backpressure and drop counters.
-   Configure socket buffers where Android permits.
-   Track packet processing latency.
-   Avoid excessive synchronization.

Do not sacrifice packet correctness for premature optimization.

# 11. Statistics and Diagnostics

Expose per-uplink statistics:

-   Uplink name.
-   Network availability.
-   Active UDP flows.
-   Packets received.
-   Packets forwarded.
-   Return packets.
-   Bytes transmitted.
-   Bytes received.
-   Packets dropped.
-   Invalid IPv4 packets.
-   Invalid UDP packets.
-   Fragmented packets.
-   Socket errors.
-   Average processing latency.
-   Last activity timestamp.

Expose per-flow diagnostics:

-   Original source IP and port.
-   Destination IP and port.
-   Selected uplink.
-   Flow creation time.
-   Last activity.
-   Sent/received datagrams.
-   Socket status.

Never expose sensitive authentication material in logs.

# 12. Testing Requirements

## 12.1 Unit tests

Test:

-   IPv4 parsing.
-   IPv4 header checksum.
-   UDP parsing.
-   UDP checksum.
-   UDP packet construction.
-   Framing compatibility.
-   Flow lookup.
-   Flow expiration.
-   Multiple independent flows.
-   Fragment rejection or reassembly.

Include malformed packets and boundary conditions.

## 12.2 Protocol compatibility tests

Capture actual packets from the existing CtrLink implementation.

Verify:

-   Incoming frames decode correctly.
-   Return frames match the original protocol.
-   Keepalives behave exactly as expected.
-   Peer learning works.
-   Return traffic reaches the correct encoder.

The existing C implementation is the reference.

## 12.3 Android integration tests

Test:

1. Android receives an existing CtrLink DATA frame.
2. The relay extracts the UDP payload.
3. The relay sends it through a bound Android network socket.
4. A test UDP server responds.
5. The relay reconstructs the IPv4 packet.
6. The relay encapsulates the response.
7. The encoder receives the expected response.

## 12.4 Multiple uplink tests

Test at least two independent uplinks.

Verify:

-   Different flows can use different networks.
-   Each flow remains associated with its selected network.
-   Responses return through the correct flow.
-   Disconnecting one network does not terminate unrelated flows.
-   Network reconnection allows new flows to use the restored uplink.

## 12.5 Real-world SRTLA test

Use an actual encoder and SRTLA receiver.

Measure:

-   Sustained bitrate.
-   Packet loss.
-   Latency.
-   Jitter.
-   CPU utilization.
-   Memory usage.
-   Per-uplink utilization.

Compare results against the existing TUN-based implementation where available.

# 13. Implementation Order

### PR 1 — Protocol and packet parsing

-   Inspect existing CtrLink source.
-   Verify wire protocol.
-   Implement/reuse FramingCodec.
-   Implement IPv4Parser.
-   Implement UDP parser.
-   Implement checksums.
-   Add unit tests.

### PR 2 — UDP socket forwarding

-   Implement UdpSocketManager.
-   Implement flow tracking.
-   Implement Android network binding.
-   Test a single UDP flow.

### PR 3 — Return packet reconstruction

-   Implement IPv4Builder.
-   Implement UDP builder.
-   Implement return encapsulation.
-   Verify byte-level compatibility.

### PR 4 — Multiple uplinks

-   Implement AndroidUplinkManager.
-   Add independent network-bound sockets.
-   Add flow-to-uplink association.
-   Implement network lifecycle management.

### PR 5 — Production hardening

-   Add timeouts.
-   Add error recovery.
-   Add metrics.
-   Add resource management.
-   Add performance optimization.

### PR 6 — SRTLA end-to-end testing

-   Test with actual encoder.
-   Test multiple uplinks.
-   Test network failures.
-   Benchmark against existing implementation.

# 14. Mandatory Rules for the Coding Agent

1. Do not modify the CtrLink wire protocol.
2. Do not modify the encoder unless a concrete incompatibility is discovered and explicitly approved.
3. Do not introduce Moblink.
4. Do not introduce SOCKS5.
5. Do not introduce WireGuard.
6. Do not use TUN.
7. Do not use Android VpnService.
8. Do not require root.
9. Do not implement TCP.
10. Do not implement a general-purpose TCP/IP stack.
11. Keep packet processing independent of Android APIs.
12. Preserve existing project conventions.
13. Add tests for every new packet-processing component.
14. Do not silently drop unsupported traffic.
15. Document all protocol assumptions and verified source references.

# 15. Critical Design Validation Before Implementation

Before coding, answer these questions using the actual CtrLink source:

1. What exactly is the existing DATA frame layout?
2. How is the encoder's VIF IP represented?
3. How does the existing relay learn peers?
4. How are return packets associated with encoder peers?
5. What are the existing MTU limits?
6. Does the encoder send IPv4 fragments?
7. Does the current implementation support multiple encoders?
8. Which UDP traffic patterns does the SRTLA integration actually produce?
9. Does the existing implementation rely on preserving source ports or source addresses?
10. Are there any additional packet types that must be supported?

Do not guess these answers.

If the existing implementation contains behavior that conflicts with this document, report the discrepancy before changing the protocol.

# 16. Definition of Done

The implementation is complete when:

-   [ ] Existing CtrLink encoder works without modification.
-   [ ] Existing CtrLink UDP framing is preserved.
-   [ ] Android relay operates without TUN.
-   [ ] Android relay operates without VpnService.
-   [ ] No root permissions are required.
-   [ ] IPv4/UDP packets are parsed correctly.
-   [ ] UDP payloads are forwarded through Android network-bound sockets.
-   [ ] Return packets are reconstructed correctly.
-   [ ] Multiple uplinks work independently.
-   [ ] UDP flows remain associated with their selected uplinks.
-   [ ] Network failures are handled.
-   [ ] Unit tests pass.
-   [ ] Android integration tests pass.
-   [ ] Actual SRTLA streaming works.
-   [ ] Performance is benchmarked.
-   [ ] Limitations are documented.

---

# Final Architectural Decision

**Implement a native CtrLink-compatible, userspace IPv4/UDP translator for Android.**

The relay retains the original CtrLink transport protocol and encoder compatibility but replaces kernel-level IP forwarding with ordinary Android UDP sockets.

The initial target is SRTLA traffic only.

No Moblink integration, no TUN, no VPNService, no root, no TCP stack, and no protocol redesign.

The existing CtrLink source code remains the authoritative specification.
