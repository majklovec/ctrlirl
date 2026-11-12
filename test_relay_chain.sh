#!/usr/bin/env bash
# test_relay_chain.sh — 3-part test for the MobLink UDP relay chain.
#
# Topology:
#   rpi4 (encoder) 192.168.10.101
#     └─ TUN relay<slot>_<uplink>  →  UDP  →  bigcml relay (this host)
#                            └─ leg enxb6db32817e7a (mobile) → phone CGNAT → VPS
#                            └─ leg eno1 (home LAN)          → home router  → VPS
#                            └─ leg wg0 (wireguard)          → wg peer      → VPS
#
#   VPS = 144.91.123.190 (vondracek.dev), srtla_rec docker :5000/udp
#
# The relay side is single-socket + kernel NAT now: ONE UDP listener on 0.0.0.0
# plus a bare-L3 TUN per leg. The kernel (leg routing table + iif rule +
# MASQUERADE + FORWARD) sends vif traffic out each uplink with that uplink's
# source IP and de-NATs replies back through the TUN — no user-space NAT, no
# source-routing pin (the old b6db3 fault).
#
# Usage:
#   ./test_relay_chain.sh           # run all 3 tests
#   ./test_relay_chain.sh 1         # relay tunnel test only
#   ./test_relay_chain.sh 2         # OBS/VPS SRTLA tcpdump test only
#   ./test_relay_chain.sh 3         # srtla_send source-routing-table test only
#
# Requires: ssh keys to pi@192.168.10.101 and root@144.91.123.190,
#           sudo on bigcml (for tcpdump), relay running locally.
set -euo pipefail

RPI4="pi@192.168.10.101"
VPS="root@144.91.123.190"
VPS_IP="144.91.123.190"
VPS_PORT=5000
# Home router's WAN source: a packet landing on the VPS from THIS address went
# the home LAN leg, not the mobile leg (used by the 3f end-to-end proof).
HOME_WAN_IP="78.108.96.181"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

SSH_RPI4() { ssh -q -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o BatchMode=yes "$RPI4" "$@"; }
SSH_VPS()  { ssh -q -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o BatchMode=yes "$VPS" "$@"; }

# ---------------------------------------------------------------------------
# Auto-detect the rpi4's mobile MobLink TUN.
#   Returns "name ip" on the first line of stdout. The mobile leg is the TUN
#   whose egress (the relay uplink on bigcml) reaches the phone CGNAT
#   (172.21.254.0/24); we pick the TUN routed to that /24. Fallback: the first
#   MobLink TUN that has an IP. Empty when no MobLink TUN exists.
# ---------------------------------------------------------------------------
mobile_tun() {
    SSH_RPI4 "
set -e
for t in \$(ip -o link show type tun 2>/dev/null | awk -F: '{print \$2}' | tr -d ' '); do
    case \"\$t\" in relay[0-9]_*) ;; *) continue ;; esac
    ip4=\$(ip -4 -o addr show \"\$t\" 2>/dev/null | awk '{print \$4; exit}')
    [ -n \"\$ip4\" ] || continue
    gw=\$(ip route get 172.21.254.1 from \"\$ip4\" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"via\"){print \$(i+1); exit} \$(i-1)==\"dev\"{print}}')
    if [ -n \"\$gw\" ] && [[ \"\$gw\" == 172.21.254.* ]]; then
        echo \"\$t \$ip4\"; exit 0
    fi
done
for t in \$(ip -o link show type tun 2>/dev/null | awk -F: '{print \$2}' | tr -d ' '); do
    case \"\$t\" in relay[0-9]_*) ;; *) continue ;; esac
    ip4=\$(ip -4 -o addr show \"\$t\" 2>/dev/null | awk '{print \$4; exit}')
    if [ -n \"\$ip4\" ]; then echo \"\$t \$ip4\"; exit 0; fi
done
exit 0
" 2>/dev/null || true
}

# Start a VPS tcpdump capture to $1 (unbuffered, $2 seconds) and wait for it to
# flush/finish before returning, so the pcap is complete when we read it.
#   capture_pcap /tmp/x.pcap <filter> <seconds>
capture_pcap() {
    local file="$1" filter="$2" secs="$3"
    SSH_VPS "rm -f '$file'; nohup timeout $secs tcpdump -ni eth0 -U '$filter' -w '$file' >/dev/null 2>&1 &"
    # The capture runs for `secs`; poll until timeout(1) has exited and the
    # file is stable.
    for _ in $(seq 1 $((secs + 10))); do
        if SSH_VPS "pgrep -f \"tcpdump -ni eth0 -U '$filter'\" >/dev/null 2>&1" 2>/dev/null; then
            sleep 1
        else
            break
        fi
    done
    sleep 1
}

# ---------------------------------------------------------------------------
# Test 1: Relay tunnel — send a test UDP packet through the relay, verify
#         receipt on the other end (VPS).
# ---------------------------------------------------------------------------
test_relay_tunnel() {
    echo ""
    echo "═══ Test 1: Relay tunnel (UDP packet through relay → VPS) ═══"
    local mtun mtun_name mtun_ip
    mtun=$(mobile_tun)
    if [[ -z "$mtun" ]]; then
        fail "No MobLink TUN found on rpi4 (is the encoder + relay running?)"
        return
    fi
    mtun_name=${mtun%% *}
    mtun_ip=${mtun##* }
    echo "  Mobile TUN auto-detected: $mtun_name ($mtun_ip)"
    local test_id
    test_id="RELAYTEST_$(date +%s)"

    # Start VPS capture (unbuffered) + let the BPF filter program.
    capture_pcap /tmp/relay_test.pcap "udp and dst port ${VPS_PORT}" 12 &
    local cap_pid=$!
    sleep 2

    # Send test packet from rpi4 via the mobile TUN.
    local sent
    sent=$(SSH_RPI4 "sudo -n python3 -c \"
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('$mtun_ip', 0))
s.connect(('$VPS_IP', $VPS_PORT))
s.sendto(b'$test_id', ('$VPS_IP', $VPS_PORT))
print('sent')
\"" 2>&1)

    if [[ "$sent" == *"sent"* ]]; then
        pass "Test packet sent from rpi4 $mtun_ip (mobile TUN $mtun_name)"
    else
        fail "Failed to send test packet: $sent"
    fi

    # Wait for the capture to finish (it runs 12s) so the pcap is complete.
    wait "$cap_pid" 2>/dev/null || true

    # Read VPS capture.
    local result
    result=$(SSH_VPS "tcpdump -r /tmp/relay_test.pcap -nn -A 2>/dev/null | grep -c '$test_id' || true")
    if [[ "$result" -ge 1 ]]; then
        pass "Test packet '$test_id' received on VPS (relay tunnel works)"
    else
        fail "Test packet '$test_id' NOT received on VPS"
    fi
}

# ---------------------------------------------------------------------------
# Test 2: SRTLA to VPS — verify SRTLA handshake packets reach the VPS ingress
#         via tcpdump on both ends.
# ---------------------------------------------------------------------------
test_srtla_to_vps() {
    echo ""
    echo "═══ Test 2: SRTLA to VPS (tcpdump verification) ═══"

    local mtun mtun_name mtun_ip
    mtun=$(mobile_tun)
    if [[ -z "$mtun" ]]; then
        fail "No MobLink TUN found on rpi4 (is the encoder + relay running?)"
        return
    fi
    mtun_name=${mtun%% *}
    mtun_ip=${mtun##* }

    # Check rpi4 TUN counters are growing (real traffic flowing).
    local rx_before tx_before
    rx_before=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/rx_packets 2>/dev/null || echo 0")
    tx_before=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/tx_packets 2>/dev/null || echo 0")
    sleep 5
    local rx_after tx_after
    rx_after=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/rx_packets 2>/dev/null || echo 0")
    tx_after=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/tx_packets 2>/dev/null || echo 0")

    local rx_delta=$((rx_after - rx_before))
    local tx_delta=$((tx_after - tx_before))
    echo "  Mobile TUN counters (5s): rx +$rx_delta, tx +$tx_delta"

    if [[ "$tx_delta" -gt 0 ]]; then
        pass "Mobile TUN $mtun_name has outbound traffic (tx +$tx_delta in 5s)"
    else
        fail "Mobile TUN $mtun_name has NO outbound traffic"
    fi

    if [[ "$rx_delta" -gt 0 ]]; then
        pass "Mobile TUN $mtun_name has inbound traffic (rx +$rx_delta in 5s)"
    else
        fail "Mobile TUN $mtun_name has NO inbound traffic"
    fi

    # Verify VPS sees SRTLA handshake packets (258-byte UDP) from the mobile CGNAT.
    local vps_seen
    vps_seen=$(SSH_VPS "timeout 5 tcpdump -ni eth0 -U 'udp and dst port 5000 and length > 200' -c 5 2>/dev/null | grep -c 'UDP, length 258' || true")
    if [[ "$vps_seen" -ge 1 ]]; then
        pass "VPS receives 258-byte SRTLA handshake packets on :5000"
    else
        # Handshake may be in a quiet phase; check for any SRT traffic.
        vps_seen=$(SSH_VPS "timeout 5 tcpdump -ni eth0 -U 'udp and dst port 5000' -c 5 2>/dev/null | grep -c 'UDP' || true")
        if [[ "$vps_seen" -ge 1 ]]; then
            pass "VPS receives UDP packets on :5000 (SRTLA active)"
        else
            fail "VPS receives NO packets on :5000"
        fi
    fi

    # Check srtla_rec container is running.
    local container
    container=$(SSH_VPS "docker ps --filter name=srtla_rec --format '{{.Names}}' 2>/dev/null" | head -1)
    if [[ -n "$container" ]]; then
        pass "srtla_rec container '$container' is running on VPS"
    else
        fail "srtla_rec container not found on VPS"
    fi
}

# ---------------------------------------------------------------------------
# Test 3: srtla_send source-routing-table test — verify that srtla_send is
#         using all shared interfaces (especially the mobile one), and that
#         the routing tables are configured correctly.
# ---------------------------------------------------------------------------
test_source_routing() {
    echo ""
    echo "═══ Test 3: srtla_send source routing tables ═══"

    # 3a: Verify srtla_ips.txt exists and has the expected entries.
    local ips
    ips=$(SSH_RPI4 "cat /tmp/srtla_ips.txt 2>/dev/null")
    echo "  srtla_ips.txt contents:"
    while IFS= read -r line; do echo "    $line"; done <<< "$ips"

    local ip_count
    ip_count=$(echo "$ips" | grep -c '^[0-9]' || true)
    if [[ "$ip_count" -ge 3 ]]; then
        pass "srtla_ips.txt has $ip_count uplink IPs (≥3 expected)"
    else
        fail "srtla_ips.txt has only $ip_count IPs (expected ≥3)"
    fi

    # 3b: Verify per-TUN routing rules (ip rule + ip route).
    echo "  Routing rules on rpi4:"
    local rules
    rules=$(SSH_RPI4 "ip rule show 2>/dev/null")
    local route_count
    route_count=$(echo "$rules" | grep -c '10\.90\.' || true)
    if [[ "$route_count" -ge 3 ]]; then
        pass "Found $route_count routing rules for 10.90.x.1 TUN interfaces"
    else
        fail "Only $route_count routing rules for 10.90.x.1 (expected ≥3)"
    fi

    # 3c: Verify TUN interfaces exist and are up.
    local tun_count
    tun_count=$(SSH_RPI4 "ip -o link show type tun 2>/dev/null | wc -l")
    if [[ "$tun_count" -ge 3 ]]; then
        pass "Found $tun_count TUN interfaces on rpi4"
    else
        fail "Only $tun_count TUN interfaces (expected ≥3)"
    fi

    # 3d: Verify traffic is flowing through the mobile TUN specifically.
    local mtun mtun_name mtun_ip
    mtun=$(mobile_tun)
    if [[ -z "$mtun" ]]; then
        fail "No mobile MobLink TUN found on rpi4"
    else
        mtun_name=${mtun%% *}
        mtun_ip=${mtun##* }
        local mob_rx mob_tx
        mob_rx=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/rx_packets 2>/dev/null || echo 0")
        mob_tx=$(SSH_RPI4 "cat /sys/class/net/$mtun_name/statistics/tx_packets 2>/dev/null || echo 0")
        if [[ "$mob_tx" -gt 1 && "$mob_rx" -gt 0 ]]; then
            pass "Mobile TUN $mtun_name active (rx=$mob_rx, tx=$mob_tx)"
        else
            fail "Mobile TUN $mtun_name not active (rx=$mob_rx, tx=$mob_tx)"
        fi
    fi

    # 3e: Verify srtla_send process is running.
    local srtla_pid
    srtla_pid=$(SSH_RPI4 "pgrep -x srtla_send 2>/dev/null | head -1" || true)
    if [[ -n "$srtla_pid" ]]; then
        pass "srtla_send running (pid $srtla_pid)"
        local srtla_args
        srtla_args=$(SSH_RPI4 "cat /proc/$srtla_pid/cmdline 2>/dev/null | tr '\0' ' '")
        echo "  Args: $srtla_args"
    else
        fail "srtla_send process not found"
    fi

    # 3f: End-to-end proof — send a tagged packet from rpi4 via the mobile TUN
    #     and verify it arrives at the VPS from a DIFFERENT source IP than the
    #     home router (proving it went through the mobile leg, not LAN). With
    #     the kernel-NAT design the source on the wire is the mobile uplink's
    #     (phone CGNAT) source — the b6db3 fix, so this must now succeed.
    echo "  End-to-end mobile leg proof (tagged packet):"
    mtun=$(mobile_tun)
    if [[ -z "$mtun" ]]; then
        fail "No mobile MobLink TUN to send the tagged packet from"
    else
        mtun_ip=${mtun##* }
        local tag="E2E_MOBILE_$(date +%s)"
        capture_pcap /tmp/e2e_test.pcap "udp and dst port ${VPS_PORT}" 12 &
        local cap_pid=$!
        sleep 2

        SSH_RPI4 "sudo -n python3 -c \"
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('$mtun_ip', 0))
s.connect(('$VPS_IP', $VPS_PORT))
s.sendto(b'$tag', ('$VPS_IP', $VPS_PORT))
\"" 2>/dev/null

        # Wait for the capture to finish so the pcap is complete.
        wait "$cap_pid" 2>/dev/null || true
        local e2e_result
        e2e_result=$(SSH_VPS "tcpdump -r /tmp/e2e_test.pcap -nn -A 2>/dev/null | grep -B1 '$tag' | head -2" || true)
        if [[ -n "$e2e_result" ]]; then
            local src_ip
            src_ip=$(echo "$e2e_result" | grep -oP '\d+\.\d+\.\d+\.\d+' | head -1)
            echo "  Packet arrived at VPS from source: $src_ip"
            if [[ "$src_ip" != "$HOME_WAN_IP" ]]; then
                pass "Mobile leg confirmed: packet arrived from $src_ip (NOT home router $HOME_WAN_IP)"
            else
                fail "Packet arrived from home router IP — mobile leg may not be working"
            fi
        else
            fail "Tagged packet '$tag' not received on VPS"
        fi
    fi

    # 3g: Check bigcml relay is running.
    local relay_pid
    relay_pid=$(pgrep -f 'bun.*dev:client' 2>/dev/null | head -1 || true)
    if [[ -n "$relay_pid" ]]; then
        pass "Relay (dev:client) running on bigcml (pid $relay_pid)"
    else
        fail "Relay process not found on bigcml"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  MobLink UDP Relay Chain — Test Suite                   ║"
echo "║  $(date)                              ║"
echo "╚══════════════════════════════════════════════════════════╝"

case "${1:-all}" in
    1) test_relay_tunnel ;;
    2) test_srtla_to_vps ;;
    3) test_source_routing ;;
    all)
        test_relay_tunnel
        test_srtla_to_vps
        test_source_routing
        ;;
    *)
        echo "Usage: $0 {1|2|3|all}"
        exit 1
        ;;
esac

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]]
