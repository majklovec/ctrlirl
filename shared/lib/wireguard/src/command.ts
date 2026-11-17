/*
 * General command-runner seam.
 *
 * The transport core runs `iproute2` (`ip`); the Layer-3 WireGuard transport
 * additionally needs `wg` (peer programming), `modprobe` (kernel module) and,
 * for relay NAT, `iptables`. This module is the single place a command is
 * actually executed, so unit tests can record the exact `{bin, args}`
 * sequence without a live kernel — and so a host that must run these as root
 * gets one obvious seam to prepend `sudo` (a `setCmdRunner` wrapper) instead
 * of sprinkling it through every call site.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Run `bin args…`; resolves to stdout, throws with stderr on non-zero exit. */
export async function runCommand(
	bin: string,
	args: string[],
): Promise<string> {
	try {
		const { stdout } = await pexecFile(bin, args, {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		return stdout;
	} catch (e) {
		const err = e as { code?: number; stderr?: string; message?: string };
		const detail = (err.stderr ?? "").trim() || (err.message ?? String(e));
		throw new Error(`${bin} ${args.join(" ")} failed: ${detail}`);
	}
}

type CmdRunner = (bin: string, args: string[]) => Promise<string>;

let cmdRunnerImpl: CmdRunner = runCommand;

/**
 * Inject the command runner (unit tests record `{bin, args}` without a live
 * kernel; a host that needs elevated privileges wraps `runCommand` in
 * `sudo`). Passing `undefined` restores the real `execFile` runner.
 */
export function setCmdRunner(
	runner: CmdRunner | undefined,
): void {
	cmdRunnerImpl = runner ?? runCommand;
}

/** The active command runner (production: `runCommand`; tests: injected). */
export function execCmd(
	bin: string,
	args: string[],
): Promise<string> {
	return cmdRunnerImpl(bin, args);
}
