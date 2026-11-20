import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleCore } from "../client/backend/module_core";
import { defaultRouteRowIndex } from "../client/modules/network/route_view";
import {
    addProgrammaticUplink,
    bindRouting,
    defaultRouteDetails,
    ensureUplinksFile,
    fireInterfaceChangeIfChanged,
    isSelfGeneratedEvent,
    leaselessGateway,
    migrateSelection,
    onInterfaceChange,
    onUplinksChanged,
    reconfigure,
    removeProgrammaticUplink,
    resolveSelection,
    seedManagedTableCount,
    setIpQueryForTest,
    setRtTablesFileForTest,
    setSysfsNetForTest,
    uplinksLines,
} from "../client/modules/network/routing";
import type { Iface } from "../client/modules/network/types";

// The tests below bind stub bags into the module singleton; hand the real
// process bag back so later test files see the device as discovery left it.
const rtTablesFixture = join(tmpdir(), `irtctrl_rt_tables.${process.pid}`);
afterAll(() => {
    rmSync(rtTablesFixture, { force: true });
    setRtTablesFileForTest(null);
});
afterAll(async () => {
    const { bindModules } = await import("../client/backend/modules");
    bindModules();
});

describe("uplinks file follows the bond selection", () => {
    const file = join(tmpdir(), "srtla_ips.txt");
    const saved = (() => {
        try {
            return readFileSync(file, "utf8");
        } catch {
            return null;
        }
    })();
    const data: Record<string, unknown> = { network: { selection: {} } };
    let live: [iface: string, ip: string][] = [];
    let handlerRuns = 0;
    let failRouting = false;
    let unsubscribe = () => {};

    /** Bind a stub core whose detected interfaces are `live` and whose writes hit the real file. */
    const bind = (excluded: string[] = [], dryRun = false) => {
        data.network = { selection: { excluded } };
        bindRouting(
            {
                config: { DRY_RUN: dryRun },
                state: { data },
                saveState: async () => {},
                notifyStateChange: () => {},
                run: async (_cmd: string, args: string[]) => {
                    if (failRouting && args[0] === "rule" && args[1] === "add")
                        throw new Error("RTNETLINK answers: File exists");
                    return "";
                },
                writeFileAtomic: async (path: string, content: string) =>
                    writeFileSync(path, content),
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );
    };
    const onDisk = () => readFileSync(file, "utf8");

    beforeEach(() => {
        live = [
            ["eth0", "192.168.1.10"],
            ["usb0", "10.0.0.5"],
        ];
        failRouting = false;
        handlerRuns = 0;
        setIpQueryForTest(async () =>
            live
                .map(
                    ([iface, ip], i) =>
                        `${i + 2}: ${iface}    inet ${ip}/24 scope global ${iface}`,
                )
                .join("\n"),
        );
        unsubscribe = onUplinksChanged(async () => {
            handlerRuns++;
        });
    });
    afterEach(async () => {
        unsubscribe();
        for (const id of ["ctrlink:tun:rltun0_eth0", "extra"])
            await removeProgrammaticUplink(id);
        setIpQueryForTest(null);
    });
    afterAll(() => {
        if (saved === null) rmSync(file, { force: true });
        else writeFileSync(file, saved);
    });

    test("a programmatic uplink is merged into the live selection, not the file's old lines", async () => {
        // A previous run's bond IP, a stale uplink id and an excluded
        // interface's IP: none of them may be carried forward.
        writeFileSync(file, "192.168.9.9\nctrlink:tun:rltun0_eno2\n10.0.0.5\n");
        bind(["usb0"]);
        await addProgrammaticUplink("extra", "10.90.0.1");
        expect(onDisk()).toBe("192.168.1.10\n10.90.0.1\n");
        expect(handlerRuns).toBe(1);
    });

    test("removing a programmatic uplink drops its IP from the file", async () => {
        bind();
        await addProgrammaticUplink("extra", "10.90.0.1");
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n10.90.0.1\n");
        await removeProgrammaticUplink("extra");
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n");
    });

    test("re-registering an unchanged uplink does not reload the consumers", async () => {
        bind();
        await addProgrammaticUplink("extra", "10.90.0.1");
        handlerRuns = 0;
        await addProgrammaticUplink("extra", "10.90.0.1");
        expect(handlerRuns).toBe(0);
    });

    test("a programmatic uplink on an excluded interface stays out of the file", async () => {
        // The streamer re-registers every CtrLink TUN on start — also one
        // the user took out of the bond.
        live.push(["rltun0_eth0", "10.200.1.2"]);
        bind(["rltun0_eth0"]);
        await addProgrammaticUplink("ctrlink:tun:rltun0_eth0", "10.200.1.2");
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n");

        // Back in the bond: the same registration is written again.
        bind();
        await ensureUplinksFile();
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n10.200.1.2\n");
    });

    test("ensure repairs a file a previous run left behind", async () => {
        writeFileSync(file, "192.168.9.9\n10.0.0.5\n");
        bind(["usb0"]);
        await ensureUplinksFile();
        expect(onDisk()).toBe("192.168.1.10\n");
        expect(handlerRuns).toBe(1);

        // In sync: nothing is rewritten and nobody is reloaded.
        await ensureUplinksFile();
        expect(handlerRuns).toBe(1);
    });

    test("ensure recreates a missing file", async () => {
        rmSync(file, { force: true });
        bind();
        await ensureUplinksFile();
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n");
    });

    test("reconfigure repairs a file changed behind its back and reloads the consumers", async () => {
        bind();
        expect((await reconfigure()).ok).toBe(true);
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n");

        writeFileSync(file, "192.168.9.9\n");
        handlerRuns = 0;
        const result = await reconfigure();
        expect(result.changed).toBe(true);
        expect(onDisk()).toBe("192.168.1.10\n10.0.0.5\n");
        expect(handlerRuns).toBe(1);

        expect((await reconfigure()).changed).toBe(false);
        expect(handlerRuns).toBe(1);
    });

    test("reconfigure follows the selection even when the routing fails", async () => {
        writeFileSync(file, "192.168.9.9\n");
        bind(["usb0"]);
        failRouting = true;
        const result = await reconfigure();
        expect(result.ok).toBe(false);
        expect(result.error).toContain("File exists");
        expect(result.changed).toBe(true);
        expect(onDisk()).toBe("192.168.1.10\n");
        expect(handlerRuns).toBe(1);
    });

    test("an empty selection clears the file", async () => {
        writeFileSync(file, "192.168.9.9\n");
        bind(["eth0", "usb0"]);
        const result = await reconfigure();
        expect(result).toMatchObject({ ok: true, ips: [], changed: true });
        expect(onDisk()).toBe("");
    });

    test("a dry run reports the change once and writes nothing", async () => {
        writeFileSync(file, "192.168.9.9\n");
        bind([], true);
        expect((await reconfigure()).changed).toBe(true);
        expect((await reconfigure()).changed).toBe(false);
        expect(onDisk()).toBe("192.168.9.9\n");
    });
});

describe("SRTLA default-route details", () => {
    test("reports the source address selected for the default route", async () => {
        bindRouting(
            {
                run: async () =>
                    "1.1.1.1 via 192.168.32.1 dev eth0 src 192.168.32.4",
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
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
});

describe("uplinks file lines", () => {
    test("carries programmatic uplink sources as IPs, never their ids", async () => {
        // The file is consumed by srtla_send, which dials these as addresses.
        bindRouting(
            {
                config: { DRY_RUN: true },
                state: { data: {} },
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );
        setIpQueryForTest(async () => "");
        await addProgrammaticUplink("ctrlink:tun:rltun0_eno2", "10.90.0.1");
        try {
            expect(uplinksLines(["192.168.8.153"])).toEqual([
                "192.168.8.153",
                "10.90.0.1",
            ]);
            // A source that is also a bonded IP is written once.
            expect(uplinksLines(["10.90.0.1"])).toEqual(["10.90.0.1"]);
            // A source on an interface taken out of the bond is left out.
            expect(uplinksLines(["192.168.8.153"], ["10.90.0.1"])).toEqual([
                "192.168.8.153",
            ]);
        } finally {
            // Drop the test's uplink so later tests see a clean registry.
            await removeProgrammaticUplink("ctrlink:tun:rltun0_eno2");
            setIpQueryForTest(null);
        }
    });
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
        const all = [mk("eth0", "192.168.1.10"), mk("usb0", "10.0.0.5")];
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

describe("lease-less uplink gateway", () => {
    test("uses the subnet's first host for a lease-less RNDIS uplink", () => {
        expect(leaselessGateway("192.168.8.153", 24)).toBe("192.168.8.1");
    });

    test("has no via-address for a CtrLink TUN (its /32 is its only on-link address)", () => {
        // The relay allocates TUN legs as 10.200.<slot+1>.2/32: the only
        // on-link address is the peer itself, so a `via` would be off-link
        // and the kernel rejects it ("Nexthop has invalid gateway").
        expect(leaselessGateway("10.200.1.2", 32)).toBeNull();
        // /31 subnets have no room for a gateway either.
        expect(leaselessGateway("192.168.8.2", 31)).toBeNull();
    });

    test("returns null for a malformed address", () => {
        expect(leaselessGateway("not-an-ip", 24)).toBeNull();
    });
});

describe("self-generated route event filtering", () => {
    test("matches managed tables by numeric ID or by rt_tables name", async () => {
        // belabox images name table 100 in /etc/iproute2/rt_tables ("100 usb0"),
        // and `ip monitor` then prints "table usb0" — both must be recognised.
        writeFileSync(
            rtTablesFixture,
            [
                "# reserved kernel routing tables",
                "255\tlocal",
                "254\tmain",
                "100\tusb0",
            ].join("\n"),
        );
        setRtTablesFileForTest(rtTablesFixture);

        expect(
            await isSelfGeneratedEvent(
                "default via 10.0.1.138 dev eth0 table 100",
            ),
        ).toBe(true);
        expect(
            await isSelfGeneratedEvent(
                "default via 10.0.1.138 dev eth0 table usb0",
            ),
        ).toBe(true);

        // Main-table and foreign-table events stay relevant (failover etc.).
        expect(
            await isSelfGeneratedEvent("default via 10.0.1.138 dev eth0"),
        ).toBe(false);
        expect(
            await isSelfGeneratedEvent(
                "default via 10.0.1.138 dev eth0 table local",
            ),
        ).toBe(false);
        setRtTablesFileForTest(null);
    });

    test("seeds the managed table count from live ip rules after a restart", async () => {
        bindRouting(
            {
                run: async () =>
                    [
                        "0:\tfrom all lookup local",
                        "32766:\tfrom all lookup main",
                        "32767:\tfrom all lookup default",
                        "10000:\tfrom 10.0.1.65 lookup 100",
                        "10001:\tfrom 10.214.189.184 lookup 101",
                        "10002:\tfrom 192.168.8.153 lookup 102",
                    ].join("\n"),
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );

        await seedManagedTableCount();

        // Events for tables the previous run left behind are recognised
        // right after a restart, not only after the next full re-apply.
        expect(await isSelfGeneratedEvent("default dev usb0 table 102")).toBe(
            true,
        );
        expect(await isSelfGeneratedEvent("default dev usb0 table 103")).toBe(
            false,
        );
    });

    test("re-reads rt_tables when the first read finds no entries", async () => {
        const rtTables = join(
            tmpdir(),
            `irtctrl_rt_tables_late.${process.pid}`,
        );
        setRtTablesFileForTest(rtTables);

        // No file yet: the name cannot be resolved — and the empty read
        // must not be cached, or the filter would stay blind forever.
        expect(await isSelfGeneratedEvent("default dev usb0 table usb0")).toBe(
            false,
        );

        writeFileSync(rtTables, "100\tusb0\n");
        expect(await isSelfGeneratedEvent("default dev usb0 table usb0")).toBe(
            true,
        );
        setRtTablesFileForTest(null);
        rmSync(rtTables, { force: true });
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
