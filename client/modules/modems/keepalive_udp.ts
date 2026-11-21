import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// A DNS query for the root's A record; 1.1.1.1:53 is a DNS service.
const PACKET = Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]);

let libc: ReturnType<typeof loadLibc> | undefined;

function loadLibc() {
	if (process.platform !== "linux")
		throw new Error("Modem UDP keepalives require Linux");
	return dlopen("libc.so.6", {
		socket: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
		setsockopt: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
		sendto: {
			args: [
				FFIType.i32,
				FFIType.ptr,
				FFIType.u64_fast,
				FFIType.i32,
				FFIType.ptr,
				FFIType.u32,
			],
			returns: FFIType.i64_fast,
		},
		close: { args: [FFIType.i32], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
		strerror: { args: [FFIType.i32], returns: FFIType.cstring },
	});
}

/** Send one UDP datagram via a particular Linux interface, without waiting for a reply. */
export async function sendKeepalive(
	iface: string,
	target: string,
	port: number,
): Promise<void> {
	if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(iface))
		throw new Error(`Invalid network interface ${JSON.stringify(iface)}`);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`Invalid UDP keepalive port ${port}`);
	const address =
		isIP(target) === 4 ? target : (await lookup(target, { family: 4 })).address;
	const host = address.split(".").map(Number);
	const name = Buffer.from(`${iface}\0`);
	const dest = Buffer.alloc(16);
	new Uint16Array(dest.buffer, dest.byteOffset, 1)[0] = 2; // AF_INET
	dest.writeUInt16BE(port, 2);
	for (let i = 0; i < 4; i++) dest[4 + i] = host[i];

	libc ??= loadLibc();
	const api = libc.symbols;
	const failure = (operation: string): Error => {
		const errnoPtr = api.__errno_location();
		const errno = errnoPtr === null ? 0 : read.i32(errnoPtr);
		return new Error(
			`${operation}: ${api.strerror(errno) ?? `errno ${errno}`}`,
		);
	};
	// Linux SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC.
	const fd = api.socket(2, 2 | 0x800 | 0x80000, 0);
	if (fd < 0) throw failure("socket");
	try {
		// SO_BINDTODEVICE prevents policy/default routes from choosing a different uplink.
		if (api.setsockopt(fd, 1, 25, ptr(name), name.length) !== 0)
			throw failure(`SO_BINDTODEVICE ${iface}`);
		const sent = api.sendto(
			fd,
			ptr(PACKET),
			PACKET.length,
			0,
			ptr(dest),
			dest.length,
		);
		if (sent < 0) throw failure(`UDP send via ${iface}`);
		if (Number(sent) !== PACKET.length)
			throw new Error(`Incomplete UDP send via ${iface}: ${sent} bytes`);
	} finally {
		api.close(fd);
	}
}
