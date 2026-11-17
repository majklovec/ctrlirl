/* Interface helpers for the UDP relay: name validation + IPv4 resolution. */
import { networkInterfaces } from "node:os";

/** A valid (POSIX/network) interface name: 1–15 chars, no slashes. */
export const IFACE_NAME_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

/**
 * Resolve the IPv4 address of `interfaceName`. `override` (a dotted-quad) skips
 * the OS lookup — useful for tests and for binding an encoder-reachable LAN
 * address that isn't on the NIC itself.
 */
export function resolveInterfaceAddress(
	interfaceName: string,
	override?: string,
): string {
	if (override) {
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(override))
			throw new Error(`interfaceAddress ${override} is not IPv4`);
		return override;
	}
	const all = networkInterfaces();
	const addresses = all[interfaceName] ?? [];
	const ipv4s = addresses.filter((a) => a.family === "IPv4");
	// Prefer a non-internal address (real NIC); fall back to loopback (`lo`).
	const ipv4 =
		ipv4s.find((a) => !a.internal) ?? ipv4s.find((a) => a.internal) ?? null;
	if (!ipv4)
		throw new Error(`no IPv4 address on interface ${interfaceName} to use`);
	return ipv4.address;
}
