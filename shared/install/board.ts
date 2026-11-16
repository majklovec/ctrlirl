/*
 * Board (hardware) identity for install specs.
 *
 * Ctrl-IRL ships on several SBCs (Orange Pi 5 Plus / RK3588, Raspberry Pi,
 * Radxa ROCK 5A/5B/5B+, NVIDIA Jetson Nano, …). Some install rules differ
 * per board — e.g. a Raspberry Pi only needs an overlay tweak for
 * firmware/DT overlay activation, while an Orange Pi 5 Plus needs an udev
 * rule pinning the GRETAP kernel names. A module can therefore carry a
 * per-board delta under `install/board.<board>.json` that is merged over the
 * base + role spec for the board it is running on.
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
    await Bun.file(p)
        .text()
        .catch((): string | null => null);

/**
 * Board matcher table.  The **order matters** — the first entry whose regexp
 * matches the device-tree `model` string wins, so more-specific patterns must
 * come before broader ones (e.g. `ROCK 5B+` before `ROCK 5B`).  The same
 * table is consulted a second time against `/proc/cpuinfo` when the
 * device-tree probe comes up empty.
 *
 * All regexps use only the `i` flag, so `.test()` is stateless and safe to
 * reuse across calls (no `g` / `y` state to reset).
 *
 * To add a board: drop a new entry in here. `BOARD_IDS` and `BoardId` are
 * derived from this table, so the CLI `--board` value set stays in sync
 * automatically.
 */
const BOARD_MATCHERS = [
    {
        id: "radxa_rock_5b_plus",
        // The trailing "+" must be matched first or the generic 5B branch
        // below would swallow it.
        deviceTree: [/Radxa\s+ROCK\s+5B\+/i],
        cpuinfo: [],
    },
    {
        id: "radxa_rock_5b",
        deviceTree: [
            /Radxa\s+ROCK\s+5B(?!\+)/i,
            /Radxa\s+Rock\s+5B\s+Board/i,
            /Radxa\s+ROCK\s+5\s+Model\s+B/i,
        ],
        cpuinfo: [],
    },
    {
        id: "radxa_rock_5a",
        deviceTree: [
            /Radxa\s+ROCK\s+5A/i,
            /Radxa\s+Rock\s+5A\s+Board/i,
            /Radxa\s+ROCK\s+5\s+Model\s+A/i,
        ],
        cpuinfo: [],
    },
    {
        id: "jetson_nano",
        deviceTree: [/NVIDIA\s+Jetson\s+Nano/i],
        cpuinfo: [],
    },
    {
        id: "orange_pi_5_plus",
        deviceTree: [/Orange Pi 5 Plus|RK3588/i],
        cpuinfo: [],
    },
    {
        id: "raspberry_pi",
        deviceTree: [/Raspberry Pi/i],
        cpuinfo: [/\bBCM2\d{3}\b/i],
    },
] as const satisfies readonly {
    id: string;
    deviceTree: readonly RegExp[];
    cpuinfo: readonly RegExp[];
}[];

/** The closed set of board ids a module may key a delta on. */
export type BoardId = (typeof BOARD_MATCHERS)[number]["id"] | "generic";

/** A board id, or `undefined` to auto-detect. The CLI `--board` may pass any of `BOARD_IDS`. */
export type BoardIdOrUndefined = BoardId | undefined;

/** Every known board id, including the `"generic"` fallback. Derived from `BOARD_MATCHERS`. */
export const BOARD_IDS: readonly BoardId[] = [
    ...BOARD_MATCHERS.map((m) => m.id),
    "generic",
];

export interface DetectBoardOpts {
    /** Override the device-tree `model` string (tests). */
    deviceTree?: string | null;
    /** Override the `/proc/cpuinfo` text (tests). */
    cpuinfo?: string;
}

/** True when `text` matches any of `patterns` (short-circuits on first hit). */
const matchesAny = (text: string, patterns: readonly RegExp[]): boolean => {
    for (const re of patterns) if (re.test(text)) return true;
    return false;
};

/**
 * Detect the running board. Prefers the device-tree `model` string and falls
 * back to `/proc/cpuinfo` when the device-tree is absent (e.g. some
 * containers). Never throws — an unrecognised board is `"generic"`.
 */
export async function detectBoardId(
    opts: DetectBoardOpts = {},
): Promise<BoardId> {
    const dt =
        opts.deviceTree !== undefined
            ? (opts.deviceTree ?? "").trim()
            : (await readFileSafe("/proc/device-tree/model"))
                  ?.replace(/\0/g, "")
                  .trim() ?? "";

    for (const m of BOARD_MATCHERS) {
        if (matchesAny(dt, m.deviceTree)) return m.id;
    }

    // Device-tree came up empty / unknown — try /proc/cpuinfo as a fallback.
    // NOTE: a bare "RK3588" in cpuinfo is ambiguous (Orange Pi 5 Plus, Radxa
    // ROCK 5B/5B+, …), so we intentionally don't match it here. Defaulting to
    // "generic" is safer than applying the wrong board delta.
    const ci = opts.cpuinfo ?? (await readFileSafe("/proc/cpuinfo")) ?? "";
    for (const m of BOARD_MATCHERS) {
        if (matchesAny(ci, m.cpuinfo)) return m.id;
    }

    return "generic";
}

/**
 * True when `value` is a known board id. Used by the CLI to validate an
 * explicit `--board`. (Free-form values are rejected so a typo can't silently
 * disable board deltas.)
 */
export function isBoardId(value: unknown): value is BoardId {
    return typeof value === "string" && BOARD_IDS.some((id) => id === value);
}
