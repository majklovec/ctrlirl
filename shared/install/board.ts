/*
 * Board (hardware) identity for install specs.
 *
 * Ctrl-IRL ships on several SBCs (Orange Pi 5 Plus / RK3588, Raspberry Pi,
 * …). Some install rules differ per board — e.g. a Raspberry Pi only needs an
 * overlay tweak for firmware/DT overlay activation, while an Orange Pi 5 Plus
 * needs an udev rule pinning the GRETAP kernel names. A module can therefore
 * carry a per-board delta under `install/boards/<board>.json` that is merged
 * over the base + role spec for the board it is running on.
 *
 * `detectBoardId()` is the single source of truth for "which board are we
 * on". It is pure and injectable (`opts.deviceTree` / `opts.cpuinfo` override
 * the probed values) so it runs identically on the device, in the installer,
 * and under `bun test`. The systeminfo factory reuses it, so the two never
 * drift. An unknown board yields `"generic"` (no board delta applied), which
 * is the safe default: the generic base + role spec always applies.
 */
/** Read a file's text, or `null` when it is missing / unreadable. */
const readFileSafe = async (p: string): Promise<string | null> =>
    await Bun.file(p).text().catch((): string | null => null);

/** The closed set of board ids a module may key a delta on. */
export const BOARD_IDS = ["orange_pi_5_plus", "raspberry_pi", "generic"] as const;
export type BoardId = (typeof BOARD_IDS)[number];

/** A board id, or `undefined` to auto-detect. The CLI `--board` may pass any of `BOARD_IDS`. */
export type BoardIdOrUndefined = BoardId | undefined;

export interface DetectBoardOpts {
    /** Override the device-tree `model` string (tests). */
    deviceTree?: string | null;
    /** Override the `/proc/cpuinfo` text (tests). */
    cpuinfo?: string;
}

/**
 * Detect the running board. Prefers the device-tree `model` string and falls
 * back to `/proc/cpuinfo` when the device-tree is absent (e.g. some
 * containers). Never throws — an unrecognised board is `"generic"`.
 */
export async function detectBoardId(opts: DetectBoardOpts = {}): Promise<BoardId> {
    const dt =
        opts.deviceTree !== undefined
            ? (opts.deviceTree ?? "").trim()
            : ((await readFileSafe("/proc/device-tree/model"))?.replace(/\0/g, "").trim() ?? "");

    let id: BoardId;
    if (/Orange Pi 5 Plus|RK3588/i.test(dt)) {
        id = "orange_pi_5_plus";
    } else if (/Raspberry Pi/i.test(dt)) {
        id = "raspberry_pi";
    } else {
        const ci =
            opts.cpuinfo ?? (await readFileSafe("/proc/cpuinfo")) ?? "";
        id =
            /RK3588/i.test(ci)
                ? "orange_pi_5_plus"
                : /\bBCM2\d{3}\b/i.test(ci)
                    ? "raspberry_pi"
                    : "generic";
    }
    return id;
}

/**
 * True when `value` is a known board id. Used by the CLI to validate an
 * explicit `--board`. (Free-form values are rejected so a typo can't silently
 * disable board deltas.)
 */
export function isBoardId(value: unknown): value is BoardId {
    return (
        typeof value === "string" &&
        (BOARD_IDS as readonly string[]).includes(value)
    );
}
