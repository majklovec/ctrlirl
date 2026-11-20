import {
    afterAll,
    afterEach,
    describe,
    expect,
    test,
} from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleCore } from "../client/backend/module_core";
import { setIpQueryForTest } from "../shared/ip";
import { defaultRouteRowIndex } from "../client/modules/network/route_view";
import {
    bindRouting,
    defaultRouteDetails,
    fireInterfaceChangeIfChanged,
    migrateSelection,
    onInterfaceChange,
    resolveSelection,
    setSysfsNetForTest,
} from "../client/modules/network/routing";
import type { Iface } from "../client/modules/network/types";

// The tests below bind stub bags into the module singleton; hand the real
// process bag back so later test files see the device as discovery left it.
afterAll(async () => {
    const { bindModules } = await import("../client/backend/modules");
    bindModules();
    setIpQueryForTest(null);
});

describe("bond selection (exclusion model)", () => {
    // Shared stub core: the selection lives in `state.data.network.selection`.
    const data: Record<string, any> = { network: { selection: {} } };
    const core = {
        config: { DRY_RUN: true },
        state: { data },
        saveState: async () => {},
        writeFileAtomic: async () => {},
    } as unknown as ModuleCore;
    const setSel = (sel: Record<string, unknown>) => {
        data.network = { selection: sel };
    };
    const savedSel = data.network.selection;
    const sel = () => data.network.selection;
    const mk = (iface: string, ip: string): Iface => ({
        iface,
        ip,
        prefix: 24,
        cidr: `${ip}/24`,
    });
    const src = { detect: async () => [], modemIface: async () => null };
    const names = (list: Iface[]) => list.map((i) => i.iface);

    test("bonds every interface by default", () => {
        bindRouting(core, src);
        setSel({});
        const all = [mk("eth0", "192.168.1.10"), mk("usb0", "10.0.0.5")];
        expect(names(resolveSelection(all))).toEqual(["eth0", "usb0"]);
    });

    test("a newly-appearing interface is bonded automatically", () => {
        bindRouting(core, src);
        setSel({ excluded: ["usb0"] });
        const all = [
            mk("eth0", "192.168.1.10"),
            mk("usb0", "10.0.0.5"),
            mk("wwan0", "10.40.0.9"),
        ];
        expect(names(resolveSelection(all))).toEqual(["eth0", "wwan0"]);
    });

    test("an explicit exclusion is honoured", () => {
        bindRouting(core, src);
        setSel({ excluded: ["usb0"] });
        const all = [
            mk("eth0", "192.168.1.10"),
            mk("usb0", "10.0.0.5"),
        ];
        expect(names(resolveSelection(all))).toEqual(["eth0"]);
    });

    test("migrates a legacy include selection (omitted -> excluded); new ifaces bond", async () => {
        bindRouting(core, src);
        setSel({ modems: ["eth0"] });
        const all = [mk("eth0", "192.168.1.10"), mk("usb0", "10.0.0.5")];
        await migrateSelection(all);
        expect(sel()).toEqual({ excluded: ["usb0"] });
        // A new interface appearing after migration is bonded by default.
        expect(
            names(resolveSelection([...all, mk("wwan0", "10.40.0.9")])),
        ).toEqual(["eth0", "wwan0"]);
    });

    test("migration keeps an empty legacy include (bond none) as excluding everything", async () => {
        bindRouting(core, src);
        setSel({ modems: [] });
        const all = [mk("eth0", "192.168.1.10"), mk("usb0", "10.0.0.5")];
        await migrateSelection(all);
        expect(sel()).toEqual({ excluded: ["eth0", "usb0"] });
    });

    test("does not migrate a fresh (no-include) selection", async () => {
        bindRouting(core, src);
        setSel({});
        await migrateSelection([mk("eth0", "192.168.1.10")]);
        expect(sel()).toEqual({});
    });

    test("does not re-migrate an already-converted selection", async () => {
        bindRouting(core, src);
        setSel({ excluded: ["usb0"] });
        await migrateSelection([
            mk("eth0", "192.168.1.10"),
            mk("usb0", "10.0.0.5"),
            mk("wwan0", "10.40.0.9"),
        ]);
        expect(sel()).toEqual({ excluded: ["usb0"] });
    });

    afterAll(() => {
        data.network = { selection: savedSel };
    });
});

describe("default-route details", () => {
    test("reports the source address selected for the default route", async () => {
        bindRouting(
            { run: async () => "" } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );
        setIpQueryForTest(
            async () => "1.1.1.1 via 192.168.32.1 dev eth0 src 192.168.32.4",
        );
        expect(await defaultRouteDetails()).toEqual({
            iface: "eth0",
            ip: "192.168.32.4",
        });
    });

    test("returns null when the default route lookup has no usable interface", async () => {
        bindRouting({ run: async () => "" } as unknown as ModuleCore, {
            detect: async () => [],
            modemIface: async () => null,
        });
        setIpQueryForTest(async () => "");
        expect(await defaultRouteDetails()).toBeNull();
    });

    test("marks only the address selected on a multi-address default interface", () => {
        const interfaces = [
            { iface: "eth0.10", ip: "10.0.10.55" },
            { iface: "eth0", ip: "192.168.32.4" },
            { iface: "eth0", ip: "192.168.111.55" },
        ];

        const marked = defaultRouteRowIndex(interfaces, "eth0", "192.168.32.4");

        expect(marked).toBe(1);
        expect(interfaces.filter((_, index) => index === marked)).toEqual([
            { iface: "eth0", ip: "192.168.32.4" },
        ]);
    });

    afterAll(() => {
        setIpQueryForTest(null);
    });
});

describe("interface-change signature is carrier-aware", () => {
    test("a carrier-only change (address kept) fires the per-interface handlers", () => {
        // Pick one of the machine's real IPv4 interfaces and fixture its
        // operstate under a fake sysfs dir.
        const names = Object.entries(networkInterfaces() ?? {}).flatMap(
            ([name, addrs]) =>
                (addrs ?? []).some((a) => a.family === "IPv4" && !a.internal)
                    ? [name]
                    : [],
        );
        if (names.length === 0) return; // no real iface — cannot exercise sysfs
        const name = names[0];
        const dir = join(tmpdir(), `irtctrl_sysfs_net.${process.pid}`);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(join(dir, name), { recursive: true });
        const operstate = join(dir, name, "operstate");
        setSysfsNetForTest(dir);
        try {
            let fired = 0;
            const off = onInterfaceChange(() => fired++);
            writeFileSync(operstate, "up\n");
            fireInterfaceChangeIfChanged(); // first observation — sets baseline
            const baseline = fired;
            fireInterfaceChangeIfChanged();
            expect(fired).toBe(baseline); // no change → no fire

            // Cable pulled: the addresses stay, only the carrier drops.
            writeFileSync(operstate, "down\n");
            fireInterfaceChangeIfChanged();
            expect(fired).toBe(baseline + 1); // carrier-only change → fire
            off();
        } finally {
            setSysfsNetForTest(null);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
