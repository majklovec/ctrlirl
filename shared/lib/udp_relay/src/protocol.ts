/* Wire framing for the @irlctrl/udp-relay UDP datagrams.
 *
 * v2 - transparent L3 bridge. Big-endian. Two message types.
 *
 * Data frame (type 0x01):
 *   +------+-------+-----------+----------+-----------------------------+
 *   | 0x01 | flags | reserved  | vifIp    | ip_packet (variable)        |
 *   | 1B   | 1B    | 2B        | 4B       | N                          |
 *   +------+-------+-----------+----------+-----------------------------+
 * The frame carries the **full IPv4 packet** (header + payload) plus the
 * virtual-interface IPv4 address it belongs to. The relay forwards the packet
 * transparently out its bound physical interface and hands back packets
 * addressed to `vifIp`. There is no destination in the frame - the address
 * space is end-to-end between the encoder's SRTLA bond and the destination.
 * `flags`/`reserved` MUST be 0 on send, MUST be ignored on receive.
 *
 * Keepalive frame (type 0x02):
 *   +------+----------------------------+
 *   | 0x02 | timestamp_ms (8B, big-end) |
 *   +------+----------------------------+
 *
 * Malformed input (truncated header, unknown type, oversized payload) is
 * rejected as a `{ type: "malformed" }` result, never thrown.
 */

import type { DecodedFrame } from "./frame_types";
import { bytesToIp, ipToBytes, ipToU32 } from "./ip";

export const DATA_FRAME_TYPE = 0x01;
export const KEEPALIVE_FRAME_TYPE = 0x02;
/** Length of a data frame's fixed header (type + flags + reserved[2] + vifIp[4]). */
export const DATA_HEADER_LEN = 8;
/** Length of a keepalive frame (type + 8-byte timestamp). */
export const KEEPALIVE_FRAME_LEN = 9;

/**
 * Write a data-frame header into `buf[0..7]` (type + flags + reserved[2] +
 * vifIp). The caller pre-allocated the buffer with the payload already placed
 * at offset {@link DATA_HEADER_LEN}. No allocation, no per-byte address math.
 */
export function writeDataHeader(buf: Uint8Array, vifU32: number): void {
    buf[0] = DATA_FRAME_TYPE;
    buf[1] = 0;
    buf[2] = 0;
    buf[3] = 0;
    buf[4] = (vifU32 >>> 24) & 0xff;
    buf[5] = (vifU32 >>> 16) & 0xff;
    buf[6] = (vifU32 >>> 8) & 0xff;
    buf[7] = vifU32 & 0xff;
}

/**
 * Classify a wire datagram without reading a single byte. `null` for anything
 * that is neither a data nor a keepalive frame (the caller counts it
 * dropped). Direct byte indexing - this is the hot path.
 */
export function sniffFrameKind(buf: Uint8Array): "data" | "keepalive" | null {
    if (buf.length < 1) return null;
    const t = buf[0];
    if (t === DATA_FRAME_TYPE) return "data";
    if (t === KEEPALIVE_FRAME_TYPE) return "keepalive";
    return null;
}

/**
 * Encode a full IPv4 packet as a data frame, tagged with the virtual-interface
 * IPv4 address it belongs to.
 *
 * @param ipPacket the raw IPv4 datagram (header + payload) to forward
 * @param vifIp    the virtual-interface IPv4 address as a dotted string
 * (e.g. `10.0.0.2`)
 */
export function encodeDataFrame(
    ipPacket: Uint8Array,
    vifIp: string,
): Uint8Array {
    const out = new Uint8Array(DATA_HEADER_LEN + ipPacket.length);
    writeDataHeader(out, ipToU32(vifIp));
    out.set(ipPacket, DATA_HEADER_LEN);
    return out;
}

/** Encode the wall-clock timestamp (ms since epoch) as a keepalive frame. */
export function encodeKeepaliveFrame(timestampMs: number): Uint8Array {
    const out = new Uint8Array(KEEPALIVE_FRAME_LEN);
    out[0] = KEEPALIVE_FRAME_TYPE;
    // 8-byte big-endian unsigned timestamp.
    let value = BigInt(Math.max(0, Math.floor(timestampMs)));
    for (let i = 8; i >= 1; i--) {
        out[i] = Number(value & 0xffn);
        value >>= 8n;
    }
    return out;
}

/**
 * Decode a wire frame. Never throws: any structural problem (truncated header,
 * unknown type) or an oversized packet (when `maxPayload` is set) yields a
 * `{ type: "malformed" }` result.
 */
export function decodeFrame(
    buf: Uint8Array,
    maxPayload?: number,
): DecodedFrame {
    if (buf.length < 1) return { type: "malformed", reason: "empty" };
    const type = buf[0];
    if (type === DATA_FRAME_TYPE) {
        if (buf.length < DATA_HEADER_LEN)
            return { type: "malformed", reason: "truncated data header" };
        const vifIp = bytesToIp([buf[4], buf[5], buf[6], buf[7]]);
        const payload = buf.subarray(DATA_HEADER_LEN);
        if (maxPayload !== undefined && payload.length > maxPayload)
            return { type: "malformed", reason: "payload too large" };
        // Copy so the caller owns the buffer (the frame is often a scratch view).
        return { type: "data", vifIp, payload: payload.slice() };
    }
    if (type === KEEPALIVE_FRAME_TYPE) {
        if (buf.length < KEEPALIVE_FRAME_LEN)
            return { type: "malformed", reason: "truncated keepalive" };
        let value = 0n;
        for (let i = 1; i <= 8; i++) value = (value << 8n) | BigInt(buf[i]);
        return { type: "keepalive", timestampMs: Number(value) };
    }
    return { type: "malformed", reason: `unknown type 0x${type.toString(16)}` };
}
