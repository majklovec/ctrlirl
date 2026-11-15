/*
 * Board (hardware) dimension for install specs: detection + per-board delta
 * merging. All pure / temp-root — no host mutation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBoardId } from "../shared/install/board";
import { loadInstallSpec } from "../shared/install/load";
import { buildPlan } from "../client/install/plan";
import type { RoleDefinition } from "../shared/contracts/roles";
import type { ModuleInstallSpec } from "../shared/install/types";

// Hard guarantee: no test may ever spawn a real host command.
process.env.CTRLIRL_TEST = "1";

let root: string;
let modRoot: string;

beforeEach(async () => {
    root = await (await import("node:fs/promises")).mkdtemp(
        join(tmpdir(), "ctrlirl-board-"),
    );
    modRoot = join(root, "modules");
    process.env.CTRLIRL_ROOT_OVERRIDE = root;
});

afterEach(async () => {
    delete process.env.CTRLIRL_ROOT_OVERRIDE;
    await rm(root, { recursive: true, force: true });
});

describe("detectBoardId", () => {
    test("the device-tree model string wins", async () => {
        expect(await detectBoardId({ deviceTree: "Orange Pi 5 Plus" })).toBe(
            "orange_pi_5_plus",
        );
        expect(
            await detectBoardId({ deviceTree: "Raspberry Pi 5 Model B Rev 1.0" }),
        ).toBe("raspberry_pi");
    });

    test("falls back to /proc/cpuinfo when the device-tree is absent", async () => {
        expect(
            await detectBoardId({
                deviceTree: null,
                cpuinfo: "processor\t: 8\nHardware\t: BCM2712",
            }),
        ).toBe("raspberry_pi");
        expect(
            await detectBoardId({
                deviceTree: null,
                cpuinfo: "SoC\t\t\t: Rockchip RK3588",
            }),
        ).toBe("orange_pi_5_plus");
    });

    test("an unrecognised board is generic", async () => {
        expect(
            await detectBoardId({
                deviceTree: "",
                cpuinfo: "model name: Intel(R) Xeon(R) CPU",
            }),
        ).toBe("generic");
    });
});

describe("board delta merge", () => {
    const base: ModuleInstallSpec = {
        version: 1,
        udev: [
            {
                file: "50-ctrlirl-gre.rules",
                content: "SUBSYSTEM==\"net\", KERNEL==\"gretap*\", NAME=\"%k\"\n",
            },
        ],
    };
    const piRule = {
        file: "51-ctrlirl-pi-bridge.rules",
        content: "SUBSYSTEM==\"net\", KERNEL==\"br-gre*\", NAME=\"%k\"\n",
    };

    async function stageWithBoard(): Promise<string> {
        const dir = join(modRoot, "streamer", "install");
        await mkdir(join(dir, "boards"), { recursive: true });
        await writeFile(join(dir, "install.json"), JSON.stringify(base, null, 2));
        await writeFile(
            join(dir, "boards", "raspberry_pi.json"),
            JSON.stringify({ version: 1, udev: [piRule] }, null, 2),
        );
        return join(modRoot, "streamer");
    }

    test("a board delta is applied only for the matching board", async () => {
        const dir = await stageWithBoard();
        const pi = await loadInstallSpec(dir, "ctrlink_streamer", {}, "raspberry_pi");
        expect(pi?.udev?.map((u) => u.file)).toEqual([
            "50-ctrlirl-gre.rules",
            "51-ctrlirl-pi-bridge.rules",
        ]);
        const opi = await loadInstallSpec(
            dir,
            "ctrlink_streamer",
            {},
            "orange_pi_5_plus",
        );
        expect(opi?.udev?.map((u) => u.file)).toEqual(["50-ctrlirl-gre.rules"]);
        const gen = await loadInstallSpec(dir, "ctrlink_streamer", {}, "generic");
        expect(gen?.udev?.map((u) => u.file)).toEqual(["50-ctrlirl-gre.rules"]);
    });

    test("the plan carries the board and applies the delta", async () => {
        await stageWithBoard();
        const role: RoleDefinition = {
            id: "ctrlink_streamer",
            titleKey: "t",
            order: 1,
            requires: { modules: ["streamer"], capabilities: [] },
            provides: { capabilities: [] },
        };
        const plan = await buildPlan(role, {}, {
            moduleRoot: modRoot,
            boardId: "raspberry_pi",
        });
        expect(plan.board).toBe("raspberry_pi");
        const spec = plan.ordered.find((m) => m.name === "streamer")?.spec;
        expect(spec?.udev?.map((u) => u.file)).toEqual([
            "50-ctrlirl-gre.rules",
            "51-ctrlirl-pi-bridge.rules",
        ]);
    });
});
