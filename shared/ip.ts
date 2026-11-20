/*
 * Read-only `ip` queries, shared by the modules that talk to the kernel
 * routing tables (network's interface detection, srtla's source routing).
 *
 * Always runs (read-only queries work under --dry-run too); writes go
 * through each module's dry-run aware `core.run`.
 */
import { $ } from "bun";
import { errorMessage } from "./util";

let ipQueryForTest: ((args: string[]) => Promise<string>) | null = null;

/** Test seam: answer the read-only `ip` queries from a fixture (null restores the real `ip`). */
export function setIpQueryForTest(
	fn: ((args: string[]) => Promise<string>) | null,
): void {
	ipQueryForTest = fn;
}

/** Read-only `ip` query; throws with the stderr message on failure. */
export async function ipQuery(args: string[]): Promise<string> {
	if (ipQueryForTest) return ipQueryForTest(args);
	try {
		return (await $`ip ${args}`.quiet().text()).trim();
	} catch (err: unknown) {
		const stderr =
			err && typeof err === "object" && "stderr" in err
				? new TextDecoder().decode(err.stderr as Uint8Array)
				: "";
		throw new Error(
			`ip ${args.join(" ")} failed: ${stderr || errorMessage(err)}`,
		);
	}
}
