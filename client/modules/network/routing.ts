/*
 * Interface detection, bonding selection, source-based routing tables,
 * uplinks file management and the live netlink interface monitor.
 *
 * Bound by the network module at discovery (`bindRouting`): the core bag
 * supplies the dry-run aware `ip` runner and atomic writes; the modems
 * module supplies the ModemManager lookups over the `modems.source`
 * capability.
 */

import { resolve4 } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { argEnv, intArgEnv } from "../../../shared/args";
import { isCtrlinkTun } from "../../../shared/ctrlink_discovery";
import { errorMessage, readLines } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import type {
    Iface,
    Modem,
    ModemConfig,
    ModemSource,
    ReconfigureResult,
} from "./types";

export const UPLINKS_FILE = argEnv(
    "--uplinks",
    "UPLINKS_FILE",
    join(tmpdir(), "srtla_ips.txt"),
);
const DEBOUNCE_MS = intArgEnv("--debounce-ms", "DEBOUNCE_MS", 1500);
const FAILOVER_INTERVAL_MS = 2000;
const CONNECTIVITY_HOST = "www.gstatic.com";
const CONNECTIVITY_PATH = "/generate_204";
const CONNECTIVITY_TIMEOUT_MS = 2000;

let core: ModuleCore;
let modems: ModemSource;

export function bindRouting(c: ModuleCore, source: ModemSource): void {
    core = c;
    modems = source;
}

const VIRTUAL_PREFIXES = [
    "lo",
    "docker",
    "veth",
    "virbr",
    "br-",
    "tun",
    "tap",
    "wg",
    "zt",
    "tailscale",
    "utun",
    "rtltun",
    "rltun",
    "dummy",
    "bond",
];

const TABLE_BASE = 100;
/** Priority for our per-source rules. Must sit well above NetworkManager's
 * per-interface rules (it installs them near 32760–32765, which take the
 * source first and would bypass our tables entirely). */
const SOURCE_RULE_PRIORITY = 100;

/** A FIFO lock: the returned runner executes its operations one at a time. */
function serialLock(): <T>(operation: () => Promise<T>) => Promise<T> {
    let queue: Promise<void> = Promise.resolve();
    return async (operation) => {
        const previous = queue;
        let release!: () => void;
        queue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    };
}

const withRoutingLock = serialLock();
/** Serializes uplinks-file writes. Taken inside the routing lock by
 * `reconfigure`, never the other way round. */
const withUplinksLock = serialLock();

const isVirtual = (iface: string): boolean =>
    VIRTUAL_PREFIXES.some((p) => iface.startsWith(p));

/** Dry-run aware `ip` (the core prints instead of running under --dry-run). */
const ip = (args: string[], ignoreError = false): Promise<string> =>
    core.run("ip", args, ignoreError);

let ipQueryForTest: ((args: string[]) => Promise<string>) | null = null;

/** Test seam: answer the read-only `ip` queries from a fixture (null restores the real `ip`). */
export function setIpQueryForTest(
    fn: ((args: string[]) => Promise<string>) | null,
): void {
    ipQueryForTest = fn;
}

/** Read-only `ip` query that always runs (interface detection works under --dry-run too). */
async function query(args: string[]): Promise<string> {
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

/** Link speed from sysfs; -1 or EINVAL (no carrier, Wi-Fi, most modems) means unknown. */
async function linkSpeed(iface: string): Promise<number | undefined> {
    const mbps = parseInt(
        await readFile(`/sys/class/net/${iface}/speed`, "utf8").catch(() => ""),
        10,
    );
    return mbps > 0 && mbps < 0xffffffff ? mbps : undefined;
}

// ----------------------------------------------------------------------
// Interface detection (IP-level, enriched with modem info)
// ----------------------------------------------------------------------
/** IPv4 interfaces usable for bonding; pass `modems` when the caller already listed them. */
export async function detectInterfaces(modemList?: Modem[]): Promise<Iface[]> {
    const [addrs, list] = await Promise.all([
        query(["-o", "-4", "addr", "show", "up"]),
        modemList ?? modems.detect(),
    ]);
    const modemByIface = new Map<string, Modem>();
    await Promise.all(
        list.map(async (m) => {
            const ifName = await modems.modemIface(m);
            if (ifName) modemByIface.set(ifName, m);
        }),
    );

    const entries: Iface[] = [];
    for (const line of addrs.split("\n")) {
        const [, iface, , cidr] = line.split(/\s+/);
        // CtrLink tunnel TUNs (`rltun<R>_<iface>`) are real uplink paths (a
        // tunnel to a relay's shared uplink) and ARE bondable — every other
        // synthetic interface stays excluded by `isVirtual`.
        if (!iface || !cidr || (isVirtual(iface) && !isCtrlinkTun(iface)))
            continue;
        const [addr, prefix] = cidr.split("/");
        entries.push({ iface, ip: addr, prefix: parseInt(prefix, 10), cidr });
    }
    // Enrich in parallel; the array order (and thus the API order) is stable.
    await Promise.all(
        entries.map(async (entry) => {
            const speed = await linkSpeed(entry.iface);
            if (speed) entry.speed = speed;
            const modem = modemByIface.get(entry.iface);
            if (modem) {
                Object.assign(entry, {
                    modemIndex: modem.index,
                    modemPath: modem.path,
                    signalQuality: modem.signalQuality,
                    operatorName: modem.operatorName,
                    accessTech: modem.accessTech,
                    registered:
                        modem.registrationState?.includes("registered") ??
                        false,
                    connectionState: modem.state,
                    // Cellular gateways live only in the bearer, not the main
                    // table — carry it so the plan can route off-link traffic.
                    gateway: modem.gateway,
                });
            }
        }),
    );
    return entries;
}

async function getGateway(iface: string): Promise<string | null> {
    const out = await ip(["route", "show", "default", "dev", iface], true);
    return out.match(/via\s+(\S+)/)?.[1] ?? null;
}

/** Gateway from the ISC `dhclient` lease, the router the server actually
 * handed the interface. The right source for RNDIS/NDIS modem-ethernet
 * uplinks — e.g. a USB LTE modem on usb0 whose `192.168.8.x/24` LAN gateway
 * is DHCPed, so it is absent from the main table and has no ModemManager
 * bearer. Returns the first `option routers` of the newest lease for
 * `address` (`null` when the file is absent or has no matching lease). */
async function dhcpLeaseGateway(
    iface: string,
    address: string,
): Promise<string | null> {
    const text = await Bun.file(`/var/lib/dhcp/dhclient.${iface}.leases`)
        .text()
        .catch(() => null);
    if (!text) return null;
    const addrRe = new RegExp(
        `fixed-address\\s+${address.replace(/\./g, "\\.")}\\s*;`,
    );
    // dhclient appends the newest lease last; walk blocks and keep the last match.
    let routers: string | null = null;
    for (const block of text.split(/^lease\s*\{/m)) {
        if (!addrRe.test(block)) continue;
        const match = block.match(/option\s+routers\s+([0-9.]+)/);
        if (match) routers = match![1];
    }
    return routers;
}

export async function defaultRouteDetails(): Promise<{
    iface: string;
    ip: string | null;
} | null> {
    const route = await ip(["-4", "route", "get", "1.1.1.1"], true);
    const iface = route.match(/\bdev\s+(\S+)/)?.[1];
    if (!iface) return null;
    return {
        iface,
        ip: route.match(/\bsrc\s+(\S+)/)?.[1] ?? null,
    };
}

function getNetwork(ipAddr: string, prefix: number): string {
    const ipNum =
        ipAddr
            .split(".")
            .reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const net = (ipNum & mask) >>> 0;
    return `${[net >>> 24, (net >>> 16) & 0xff, (net >>> 8) & 0xff, net & 0xff].join(".")}/${prefix}`;
}

/** Last-resort gateway for an interface that publishes no gateway anywhere
 * (no ModemManager bearer, main table, or DHCP lease): the subnet's first
 * host — e.g. 192.168.8.153/24 -> 192.168.8.1. `null` when the interface has
 * a /32 (its only on-link address is its own — e.g. a CtrLink TUN, whose
 * source table gets a plain `default dev <tun>` route) or no other usable
 * host in the subnet (/31): any `via` there would be off-link and the kernel
 * rejects it with "Nexthop has invalid gateway". */
export function leaselessGateway(addr: string, prefix: number): string | null {
    if (prefix > 30) return null;
    const first = subnetFirstHost(addr, prefix);
    return first && first !== addr ? first : null;
}

/** First usable host of the interface's subnet (network + 1). The gateway for
 * RNDIS/NDIS CPE/modem uplinks that publish no gateway anywhere (not in the
 * main table, no ModemManager bearer, no DHCP lease file) — e.g.
 * 192.168.8.153/24 -> 192.168.8.1. `null` for a malformed IPv4. */
function subnetFirstHost(ip: string, prefix: number): string | null {
    const octets = ip.split(".").map((o) => parseInt(o, 10));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return null;
    const ipNum = octets.reduce((acc, o) => (acc << 8) + o, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const first = ((ipNum & mask) >>> 0) + 1;
    return [
        first >>> 24,
        (first >>> 16) & 0xff,
        (first >>> 8) & 0xff,
        first & 0xff,
    ].join(".");
}

// ----------------------------------------------------------------------
// Selection (persisted in the network config section)
// ----------------------------------------------------------------------
export const selection = (): ModemConfig =>
    ((core.state.data.network as Record<string, unknown> | undefined)
        ?.selection ?? {}) as ModemConfig;

/**
 * The interfaces in the bond: every interface except those in `excluded`.
 * Exclusion is the default policy — a newly-appearing interface is bonded
 * automatically (it is not excluded), with no per-event persistence needed.
 *
 * A pre-migration *include* selection (`modems`/`ips`) is honoured verbatim
 * for the read so a code path that resolves before the `reconfigure`
 * migration runs still matches the legacy behaviour; `migrateSelection`
 * converts it to `excluded` on the first reconcile.
 */
export function resolveSelection(all: Iface[]): Iface[] {
    const sel = selection();
    if (sel.excluded !== undefined) {
        const out = new Set(sel.excluded);
        return all.filter((i) => !out.has(i.iface));
    }
    // Legacy include format: by name, else by IP, else all.
    const { modems: names, ips } = sel;
    if (names !== undefined) return all.filter((i) => names.includes(i.iface));
    if (ips !== undefined) return all.filter((i) => ips.includes(i.ip));
    return all;
}

/**
 * Convert a legacy *include* selection (`modems`/`ips`) to the exclusion
 * form once `all` is known: everything currently present that the include
 * list omitted becomes `excluded`. A freshly-persisted selection is always
 * `{excluded}`, so this fires exactly once per legacy config. No-op for a
 * selection that is already in the new form (including `{}`, "bond all").
 */
export async function migrateSelection(all: Iface[]): Promise<void> {
    const sel = selection();
    if (sel.excluded !== undefined) return; // new form (or "all")
    // A fresh config has no include list at all — that already means "bond
    // everything", so there is nothing to convert (and we must not persist an
    // `excluded` of every current interface, which would un-bond them all).
    if (sel.modems === undefined && sel.ips === undefined) return;
    const included = new Set(
        sel.modems !== undefined
            ? sel.modems
            : (sel.ips ?? []).map((ip) => all.find((i) => i.ip === ip)?.iface),
    );
    const excluded = all
        .map((i) => i.iface)
        .filter((name) => !included.has(name));
    await setSelection({ excluded });
}

export async function setSelection(next: ModemConfig): Promise<void> {
    const stored = (core.state.data.network ?? {}) as Record<string, unknown>;
    core.state.data.network = { ...stored, selection: next };
    await core.saveState();
}

// ----------------------------------------------------------------------
// Routing tables
// ----------------------------------------------------------------------
interface RoutePlanEntry {
    iface: string;
    ip: string;
    prefix: number;
    gateway: string | null;
    table: number;
}

async function cleanupTables(count: number): Promise<void> {
    const safe = Math.min(count, TUNNEL_TABLE_BASE - TABLE_BASE);
    for (let i = 0; i < safe; i++) {
        const table = String(TABLE_BASE + i);
        await ip(["rule", "del", "lookup", table], true);
        await ip(["route", "flush", "table", table], true);
    }
}

async function setupSourceRouting({
    iface,
    ip: addr,
    prefix,
    gateway,
    table,
}: RoutePlanEntry): Promise<void> {
    const tableStr = String(table);
    const network = getNetwork(addr, prefix);
    // High priority so this source's table is consulted before NetworkManager's
    // per-interface rules (near 32760) would otherwise bypass it.
    await ip([
        "rule",
        "add",
        "from",
        addr,
        "lookup",
        tableStr,
        "priority",
        String(SOURCE_RULE_PRIORITY),
    ]);
    await ip([
        "route",
        "add",
        network,
        "dev",
        iface,
        "scope",
        "link",
        "table",
        tableStr,
    ]);
    await ip([
        "route",
        "add",
        "default",
        ...(gateway ? ["via", gateway] : []),
        "dev",
        iface,
        "table",
        tableStr,
    ]);
    await ip(["route", "add", network, "dev", iface, "scope", "link"], true);
}

// Highest number of tables we have ever populated, so shrinking selections
// get their stale tables cleaned and monitor events for them are recognised.
let managedTableCount = 0;
let lastAppliedPlan: string | null = null;
let lastAppliedPlanEntries: RoutePlanEntry[] = [];

// Tunnel vif egress tables live at 201+ (`tunnelRouteTable`); they must never
// fall inside our managed range, or a reconfigure would flush them.
const TUNNEL_TABLE_BASE = 201;

const isManagedTable = (table: number): boolean =>
    table >= TABLE_BASE &&
    table < TUNNEL_TABLE_BASE &&
    table < TABLE_BASE + Math.max(managedTableCount, 1);

/**
 * Seed `managedTableCount` from the live `ip rule` tables. After a process
 * restart the in-memory counter is 0, so monitor events for tables this
 * process has not re-applied yet would look foreign until the next full
 * re-apply — recognising them keeps the monitor quiet.
 */
export async function seedManagedTableCount(): Promise<void> {
    try {
        const rules = await ip(["rule", "show"], true);
        for (const match of rules.matchAll(/\blookup (\d+)\b/g)) {
            const table = parseInt(match[1], 10);
            // Never count tunnel egress tables (201+) — they belong to the
            // udpip transport, not to our source-routing tables.
            if (table >= TABLE_BASE && table < TUNNEL_TABLE_BASE)
                managedTableCount = Math.max(
                    managedTableCount,
                    table - TABLE_BASE + 1,
                );
        }
    } catch {}
}

async function routingIntact(plan: RoutePlanEntry[]): Promise<boolean> {
    const rules = await ip(["rule", "show"], true);
    for (const p of plan) {
        if (
            !new RegExp(
                `from ${p.ip.replace(/\./g, "\\.")} lookup ${p.table}\\b`,
            ).test(rules)
        )
            return false;
        const routes = await ip(
            ["route", "show", "table", String(p.table)],
            true,
        );
        if (!/^default\b/m.test(routes)) return false;
    }
    return true;
}

async function applyRouting(plan: RoutePlanEntry[]): Promise<boolean> {
    const signature = JSON.stringify(plan);
    if (signature === lastAppliedPlan && (await routingIntact(plan))) {
        lastAppliedPlanEntries = plan;
        return false;
    }

    lastAppliedPlan = null;
    lastAppliedPlanEntries = [];
    await cleanupTables(Math.max(managedTableCount, plan.length));
    managedTableCount = Math.max(managedTableCount, plan.length);
    for (const p of plan) await setupSourceRouting(p);
    lastAppliedPlan = signature;
    lastAppliedPlanEntries = plan;
    return true;
}

// ----------------------------------------------------------------------
// Main-table default-route failover
// ----------------------------------------------------------------------
let failoverTimer: ReturnType<typeof setInterval> | null = null;
let failoverBusy = false;

function probeAddress(
    address: string,
    localAddress?: string,
): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({
            host: address,
            port: 80,
            ...(localAddress ? { localAddress } : {}),
        });
        let settled = false;
        let response = "";
        const finish = (reachable: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(CONNECTIVITY_TIMEOUT_MS, () => finish(false));
        socket.once("connect", () => {
            socket.write(
                `GET ${CONNECTIVITY_PATH} HTTP/1.1\r\nHost: ${CONNECTIVITY_HOST}\r\nConnection: close\r\n\r\n`,
            );
        });
        socket.on("data", (chunk: Buffer) => {
            response += chunk.toString("ascii");
            const lineEnd = response.indexOf("\r\n");
            if (lineEnd !== -1) {
                finish(
                    /^HTTP\/\d(?:\.\d)? 204(?:\s|$)/.test(
                        response.slice(0, lineEnd),
                    ),
                );
            }
        });
        socket.once("error", () => finish(false));
        socket.once("close", () => finish(false));
    });
}

async function checkConnectivity(
    addresses: string[],
    localAddress?: string,
): Promise<boolean> {
    if (core.config.DRY_RUN) return true;
    const results = await Promise.all(
        addresses.map((address) => probeAddress(address, localAddress)),
    );
    return results.some(Boolean);
}

async function tableDefaultRoute(table: number): Promise<string | null> {
    const out = await ip(
        ["route", "show", "table", String(table), "default"],
        true,
    );
    return out.trim().split("\n")[0]?.trim() || null;
}

async function accessPointInterfaces(): Promise<Set<string>> {
    const output = await core.run("iw", ["dev"], true);
    return new Set(
        output.split(/(?=^\s*Interface\s)/m).flatMap((section) => {
            const iface = section.match(/^\s*Interface\s+(\S+)/m)?.[1];
            return iface && /^\s*type AP\s*$/m.test(section) ? [iface] : [];
        }),
    );
}

async function clearMainDefaultRoutes(): Promise<void> {
    const routes = await ip(["route", "show", "default"], true);
    const count = routes.trim() ? routes.trim().split("\n").length : 0;
    for (let i = 0; i < count; i++) {
        await ip(["route", "del", "default"]);
    }
}

async function enforceDefaultRoute(): Promise<void> {
    if (failoverBusy || core.config.DRY_RUN) return;
    failoverBusy = true;
    try {
        await withRoutingLock(async () => {
            let addresses: string[];
            try {
                addresses = await resolve4(CONNECTIVITY_HOST);
            } catch (err: unknown) {
                console.warn(
                    `[failover] DNS lookup failed for ${CONNECTIVITY_HOST}: ${errorMessage(err)}`,
                );
                return;
            }
            if (addresses.length === 0) return;

            // Keep the main default on a wired eth* uplink even while it is
            // healthy: this loop is otherwise reactive (it only fires when
            // connectivity drops), so without the eth check the default can stay
            // parked on a modem (usb*/wwan*) forever. Re-evaluate whenever the
            // current default is not on an eth* interface.
            const defaultIface = (await defaultRouteDetails())?.iface;
            const defaultOnEthernet = defaultIface?.startsWith("eth") ?? false;
            if ((await checkConnectivity(addresses)) && defaultOnEthernet)
                return;

            const selected = resolveSelection(await detectInterfaces());
            const plan = lastAppliedPlanEntries;
            if (
                plan.length !== selected.length ||
                plan.some(
                    (entry, idx) =>
                        entry.iface !== selected[idx]?.iface ||
                        entry.ip !== selected[idx]?.ip,
                )
            ) {
                return;
            }

            const seenIps = new Set<string>();
            const accessPoints = await accessPointInterfaces();
            // Prefer wired ethernet (eth*) for the main default route: cellular
            // uplinks are cheaper to conserve and should only take the default
            // when no ethernet uplink is reachable. Stable sort keeps detection
            // order within each group, so the first reachable eth* wins.
            const candidates = selected
                .flatMap((entry, idx) => {
                    if (seenIps.has(entry.ip)) return [];
                    seenIps.add(entry.ip);
                    if (accessPoints.has(entry.iface)) return [];
                    const appliedEntry = plan[idx];
                    return appliedEntry ? [{ entry, appliedEntry }] : [];
                })
                .sort(
                    (a, b) =>
                        Number(b.entry.iface.startsWith("eth")) -
                        Number(a.entry.iface.startsWith("eth")),
                );
            const reachability = await Promise.all(
                candidates.map(({ entry }) =>
                    checkConnectivity(addresses, entry.ip),
                ),
            );
            const winnerIndex = reachability.findIndex(Boolean);
            if (winnerIndex === -1) return;
            const winner = candidates[winnerIndex];
            if (!winner) return;

            const currentInterfaces = await detectInterfaces();
            if (
                !currentInterfaces.some(
                    (iface) =>
                        iface.iface === winner.entry.iface &&
                        iface.ip === winner.entry.ip,
                )
            ) {
                return;
            }

            const route = await tableDefaultRoute(winner.appliedEntry.table);
            if (!route) {
                console.warn(
                    `[failover] table ${winner.appliedEntry.table} has no default route`,
                );
                return;
            }

            const routeArgs = route.split(/\s+/);
            const deviceIndex = routeArgs.indexOf("dev");
            if (
                routeArgs[0] !== "default" ||
                deviceIndex === -1 ||
                routeArgs[deviceIndex + 1] !== winner.entry.iface
            ) {
                console.warn(
                    `[failover] unexpected default route in table ${winner.appliedEntry.table}: ${route}`,
                );
                return;
            }

            // Already in place: re-adding would churn netlink (and re-trigger
            // the monitor on every tick) for no effect.
            const main = (await ip(["-4", "route", "show", "default"], true))
                .split("\n")
                .find((line) => !line.includes("table"));
            if (main === route) return;

            await clearMainDefaultRoutes();
            await ip(["route", "add", ...routeArgs]);
            console.log(
                `[failover] main default route -> ${winner.entry.iface} (table ${winner.appliedEntry.table})`,
            );
            core.notifyStateChange();
        });
    } finally {
        failoverBusy = false;
    }
}

export function startDefaultRouteFailover(): void {
    if (failoverTimer) return;
    failoverTimer = setInterval(() => {
        void enforceDefaultRoute().catch((err: unknown) =>
            console.warn("[failover] error:", errorMessage(err)),
        );
    }, FAILOVER_INTERVAL_MS);
}

export function stopDefaultRouteFailover(): void {
    if (!failoverTimer) return;
    clearInterval(failoverTimer);
    failoverTimer = null;
}

// ----------------------------------------------------------------------
// Reconfigure (routing + uplinks file)
// ----------------------------------------------------------------------
/** What a --dry-run would have written (it writes nothing, so the file cannot tell). */
let dryRunUplinks: string | null = null;

/**
 * Bring the uplinks file in line with the bond: the selected interfaces' IPs
 * plus the programmatic extras. The content is always derived from the live
 * selection and compared against the file on disk — never against a cached
 * copy or the file's previous lines — so a stale file (previous run, wiped
 * /tmp, external edit) is repaired by whichever path runs first.
 *
 * `known` reuses a detection the caller already did (`reconfigure`, so the
 * file matches the routing tables it just applied); otherwise the interfaces
 * are detected here.
 */
async function syncUplinksFile(known?: {
    all: Iface[];
    selected: Iface[];
}): Promise<{ ips: string[]; lines: string[]; changed: boolean }> {
    return withUplinksLock(async () => {
        // The IP list needs no modem details: skip the ModemManager lookups.
        const all = known?.all ?? (await detectInterfaces([]));
        const selected = known?.selected ?? resolveSelection(all);
        const ips = selected.map((i) => i.ip);
        const lines = uplinksLines(
            ips,
            all.filter((i) => !selected.includes(i)).map((i) => i.ip),
        );
        const content = lines.map((line) => `${line}\n`).join("");
        const onDisk = await Bun.file(UPLINKS_FILE)
            .text()
            .catch(() => null);
        const previous = core.config.DRY_RUN
            ? (dryRunUplinks ?? onDisk)
            : onDisk;
        const changed = previous !== content;
        if (!changed) return { ips, lines, changed };
        if (core.config.DRY_RUN) {
            dryRunUplinks = content;
            return { ips, lines, changed };
        }
        await core.writeFileAtomic(UPLINKS_FILE, content);
        console.log(
            lines.length
                ? `Uplinks file updated: ${lines.join(", ")}`
                : "Uplinks file cleared (no interfaces selected)",
        );
        return { ips, lines, changed };
    });
}

/** Sync the uplinks file and tell the SRTLA leg owners when it changed. */
async function syncUplinksAndNotify(): Promise<string[]> {
    const { lines, changed } = await syncUplinksFile();
    if (changed) await fireUplinksChanged();
    return lines;
}

const failure = (error: string): ReconfigureResult => ({
    ok: false,
    selected: [],
    uplinksFile: UPLINKS_FILE,
    ips: [],
    changed: false,
    error,
});

/** One source-routing table per selected interface, in selection order. */
function routePlan(selected: Iface[]): Promise<RoutePlanEntry[]> {
    return Promise.all(
        selected.map(
            async (
                { iface, ip: addr, prefix, gateway: bearerGateway },
                idx,
            ) => {
                // CtrLink TUNs (`rltun<R>_<if>`) carry their /32 peer
                // address on the netdev itself: every frame emitted on
                // the TUN reaches the relay leg, so a via-address is
                // neither needed nor legal. The kernel rejects an
                // off-link `via` with "Nexthop has invalid gateway" —
                // e.g. a main-table default parked on the TUN by
                // NetworkManager — so skip the whole resolution chain
                // and give the source table a plain `default dev
                // <tun>` route.
                const gateway = isCtrlinkTun(iface)
                    ? null
                    : // Resolve in priority order:
                      //  1. the ModemManager bearer gateway (cellular / wwan0),
                      //  2. an existing main-table default for the interface (ethernet),
                      //  3. the dhclient lease router (RNDIS/NDIS modem-ethernet — a
                      //     USB LTE modem on usb0 whose gateway is DHCPed, not in main
                      //     and has no MM bearer),
                      //  4. the subnet's first host (.1) as a last resort for a
                      //     lease-less RNDIS uplink.
                      bearerGateway ??
                      (await getGateway(iface)) ??
                      (await dhcpLeaseGateway(iface, addr)) ??
                      leaselessGateway(addr, prefix);
                return {
                    iface,
                    ip: addr,
                    prefix,
                    gateway,
                    table: TABLE_BASE + idx,
                };
            },
        ),
    );
}

async function reconfigureLocked(): Promise<ReconfigureResult> {
    let selected: Iface[] = [];
    let ips: string[] = [];
    let changed = false;
    try {
        const all = await detectInterfaces();
        // Convert a legacy include selection to the exclusion form once,
        // so a newly-appearing interface is bonded by default.
        await migrateSelection(all);
        selected = resolveSelection(all);

        // Only touch routing when needed: rewriting tables emits netlink
        // events that would otherwise re-trigger the monitor forever. An
        // empty selection flushes the managed tables.
        let routingError: unknown;
        try {
            await applyRouting(await routePlan(selected));
        } catch (err: unknown) {
            routingError = err;
        }
        // The file follows the selection even when the routing failed (an
        // interface flapping mid-apply at boot, ...): otherwise it would
        // keep whatever a previous run left behind.
        ({ ips, changed } = await syncUplinksFile({ all, selected }));

        // Interfaces / modem details may have changed even if the uplinks did not
        core.notifyStateChange();
        if (routingError !== undefined) throw routingError;
        return {
            ok: true,
            selected,
            uplinksFile: UPLINKS_FILE,
            ips,
            changed,
        };
    } catch (err: unknown) {
        return { ...failure(errorMessage(err)), selected, ips, changed };
    }
}

/**
 * Re-apply the source routing and the uplinks file from the live interfaces
 * and the bond selection. The uplinks-changed handlers run (after the routing
 * is in place) whenever the file content changed, whoever the caller is.
 */
export async function reconfigure(): Promise<ReconfigureResult> {
    const result = await withRoutingLock(reconfigureLocked);
    if (result.changed) await fireUplinksChanged();
    return result;
}

/**
 * Make sure the uplinks file exists and matches the bond selection before a
 * consumer reads it (a wiped /tmp, a file left by a previous run, ...).
 */
export async function ensureUplinksFile(): Promise<void> {
    try {
        const lines = await syncUplinksAndNotify();
        if (lines.length === 0)
            console.warn("No interfaces selected for bonding.");
    } catch (err: unknown) {
        console.warn(`Could not sync ${UPLINKS_FILE}: ${errorMessage(err)}`);
    }
}

// ----------------------------------------------------------------------
// Live interface monitor (netlink via `ip monitor`)
// ----------------------------------------------------------------------
type UplinksChangedHandler = () => Promise<void>;

let monitorProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let monitorDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let monitorBusy = false;
let monitorPending = false;
// One handler per SRTLA leg owner (the encoder) — it reloads its own
// srtla_send. Registered over the `network.uplinks` capability.
const uplinksChangedHandlers = new Set<UplinksChangedHandler>();
let monitorWanted = false;

/** Register an uplinks-changed handler (`network.uplinks.onChanged`); returns the unsubscribe. */
export function onUplinksChanged(handler: UplinksChangedHandler): () => void {
    uplinksChangedHandlers.add(handler);
    return () => uplinksChangedHandlers.delete(handler);
}

/** Run every registered handler; called whenever the uplinks file content changed. */
async function fireUplinksChanged(): Promise<void> {
    await Promise.all(
        [...uplinksChangedHandlers].map((handler) =>
            handler().catch((err: unknown) =>
                console.warn(
                    `Uplinks-changed handler failed: ${errorMessage(err)}`,
                ),
            ),
        ),
    );
}

// ----------------------------------------------------------------------
// Programmatic uplinks (the `add`/`remove`/`list` capability methods)
// ----------------------------------------------------------------------
type UplinkExtra = { source: string; label?: string };
/** Programmatic uplinks keyed by stable id (e.g. `ctrlink:tun:rltun0_eth0`). */
const extraUplinks = new Map<string, UplinkExtra>();

/** The uplinks file line set = selected bond IPs + programmatic extras.
 * The file carries the extras' *source* IPs (srtla_send dials them), never
 * their ids; a source that is also a bonded IP is written once. An extra
 * whose source sits on an interface the user took out of the bond
 * (`unselectedIps`) is left out: the selection wins over a registration
 * (e.g. an excluded CtrLink TUN the streamer re-registers on every start).
 * Exported as a test seam. */
export function uplinksLines(
    ips: string[],
    unselectedIps: string[] = [],
): string[] {
    const merged = [
        ...ips,
        ...[...extraUplinks.values()]
            .map((e) => e.source)
            .filter((source) => !unselectedIps.includes(source)),
    ];
    return merged.filter((ip, i, all) => all.indexOf(ip) === i);
}

/** Add (or replace, by id) a programmatic uplink; `onChanged` fires when the file changed. */
export async function addProgrammaticUplink(
    id: string,
    source: string,
    label?: string,
): Promise<void> {
    if (!id) throw new Error("uplink id is required");
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(source))
        throw new Error(`uplink source ${JSON.stringify(source)} is not IPv4`);
    extraUplinks.set(id, { source, label });
    await syncUplinksAndNotify();
}

/** Remove a programmatic uplink by id; no-op when the id is unknown. */
export async function removeProgrammaticUplink(id: string): Promise<void> {
    if (!extraUplinks.delete(id)) return;
    await syncUplinksAndNotify();
}

/** The currently registered programmatic uplinks (stable order by insertion). */
export function listProgrammaticUplinks(): Array<{
    id: string;
    source: string;
    label?: string;
}> {
    return [...extraUplinks.entries()].map(([id, e]) => ({
        id,
        source: e.source,
        label: e.label,
    }));
}

// ----------------------------------------------------------------------
// Interface enumeration (the `network.interfaces` capability)
// ----------------------------------------------------------------------
/** A machine interface with its IPv4 addresses (loopback excluded). */
export interface NetworkInterfaceInfo {
    name: string;
    addresses: string[];
}

let lastInterfaceSignature = "";
const interfaceChangedHandlers = new Set<() => void>();

/** Root of the per-interface sysfs dir (test seam: point at a fixture). */
let sysfsNetDir = "/sys/class/net";

/** Test seam: point the operstate read at a fixture directory (null restores the default). */
export function setSysfsNetForTest(dir: string | null): void {
    sysfsNetDir = dir ?? "/sys/class/net";
}

/**
 * The interface's carrier state, collapsed to `up`/`down` with the same
 * lenient semantics the encoder uses: only an explicit `down` operstate counts
 * as down; read failures (missing entry, non-Linux dev machine) report `up`
 * so the signature stays stable there.
 */
function carrierState(name: string): "up" | "down" {
    try {
        return readFileSync(
            join(sysfsNetDir, name, "operstate"),
            "utf8",
        ).trim() === "down"
            ? "down"
            : "up";
    } catch {
        return "up";
    }
}

/** List the machine's own IPv4 interfaces. Filtered:
 * - loopback (never carries stream traffic)
 * - CtrLink tunnel TUNs (`rltun<R>_<iface>`, e.g. `rltun0_eth0`) —
 *   tunnels to a CtrLink box's shared uplinks, not own interfaces: selecting one
 *   would loop traffic back through the CtrLink box (see `isCtrlinkTun`). */
export function listNetworkInterfaces(): NetworkInterfaceInfo[] {
    const out: NetworkInterfaceInfo[] = [];
    for (const [name, addrs] of Object.entries(networkInterfaces() ?? {})) {
        if (isCtrlinkTun(name)) continue;
        const ipv4 = (addrs ?? [])
            .filter((a) => a.family === "IPv4" && !a.internal)
            .map((a) => a.address);
        if (ipv4.length > 0) out.push({ name, addresses: ipv4 });
    }
    return out;
}

/** Register an interface-set change handler (`network.interfaces.onChanged`); returns the unsubscribe. */
export function onInterfaceChange(handler: () => void): () => void {
    interfaceChangedHandlers.add(handler);
    return () => interfaceChangedHandlers.delete(handler);
}

/**
 * Compare the current interface signature against the last observed one and
 * fire `onInterfaceChange` handlers when it differs. Called from the monitor
 * after a reconfigure (and once at start) so per-interface consumers
 * (ctrlink-relay) can recreate the relays attached to changed interfaces.
 *
 * The signature includes the CARRIER state, not just the addresses: a pulled
 * cable (or dropped Wi-Fi) keeps its IP for a while, so without the carrier
 * bit the carrier-only change would never fire the handlers and the relay
 * would keep offering a dead path to the encoders.
 */
export function fireInterfaceChangeIfChanged(): void {
    const signature = [
        ...listNetworkInterfaces()
            .map((i) => `${i.name}:${i.addresses.join(",")}:${carrierState(i.name)}`)
            .sort(),
    ].join("|");
    if (signature === lastInterfaceSignature) return;
    lastInterfaceSignature = signature;
    for (const handler of [...interfaceChangedHandlers]) handler();
}

export const isMonitorRunning = (): boolean => monitorProc !== null;

/**
 * Schedule a reconfigure after a short debounce.
 * Multiple events within DEBOUNCE_MS collapse into one run.
 */
function scheduleReconcile(reason: string): void {
    if (monitorDebounceTimer) clearTimeout(monitorDebounceTimer);
    monitorDebounceTimer = setTimeout(() => {
        monitorDebounceTimer = null;
        void runReconcile(reason);
    }, DEBOUNCE_MS);
}

async function runReconcile(reason: string): Promise<void> {
    if (monitorBusy) {
        monitorPending = true;
        return;
    }
    monitorBusy = true;
    try {
        const result = await reconfigure();
        if (!result.ok) {
            console.warn(`[monitor] reconfigure failed: ${result.error}`);
            return;
        }
        if (result.changed) {
            // `Uplinks file updated: ...` (from reconfigure) carries the IPs;
            // reconfigure already ran the uplinks-changed handlers.
            console.log(
                `[monitor] ${reason}: uplinks changed — srtla_send reloaded`,
            );
        } else if (process.env.NETWORK_VERBOSE) {
            // No-ops are routine (any route event fires a reconcile); log them
            // only when explicitly debugging the monitor.
            console.log(`[monitor] ${reason}: uplinks unchanged — no reload`);
        }
        // The interface set (any interface, not only bonded ones) may have
        // changed without the uplinks file changing — notify the
        // per-interface consumers (ctrlink-relay).
        fireInterfaceChangeIfChanged();
    } catch (err: unknown) {
        console.error("[monitor] error:", errorMessage(err));
    } finally {
        monitorBusy = false;
        if (monitorPending) {
            monitorPending = false;
            scheduleReconcile("queued follow-up");
        }
    }
}

// IPv4 address changes, link up/down, route changes
const RELEVANT_EVENT = /inet\s|^\d+:\s+\S+:\s+<.*>|^(Deleted|Added|default)/;

// Route changes inside our own source-routing tables are self-inflicted.
// `ip monitor` prints the table by *name* when /etc/iproute2/rt_tables names
// one (e.g. belabox's "100 usb0"), so resolve names to IDs before filtering.
const RT_TABLES_FILE = "/etc/iproute2/rt_tables";
let rtTablesFile = RT_TABLES_FILE;
let rtTableIds: Map<string, number> | null = null;

/** Test seam: point the name → ID lookup at a fixture file (null restores the default). */
export function setRtTablesFileForTest(path: string | null): void {
    rtTablesFile = path ?? RT_TABLES_FILE;
    rtTableIds = null;
}

async function tableIdByName(name: string): Promise<number | undefined> {
    if (rtTableIds === null) {
        rtTableIds = new Map();
        const text = await readFile(rtTablesFile, "utf8").catch(() => "");
        for (const line of text.split("\n")) {
            if (line.trimStart().startsWith("#")) continue;
            const [id, name] = line.trim().split(/\s+/);
            if (id === undefined || name === undefined) continue;
            if (/^\d+$/.test(id)) rtTableIds.set(name, parseInt(id, 10));
        }
        // An empty read is not cached: the file may appear later, so a
        // missing mapping is re-read on the next miss.
        if (rtTableIds.size === 0) rtTableIds = null;
    }
    return rtTableIds?.get(name);
}

export async function isSelfGeneratedEvent(line: string): Promise<boolean> {
    const token = line.match(/\btable (\S+)/)?.[1];
    if (token === undefined) return false;
    if (/^\d+$/.test(token)) return isManagedTable(parseInt(token, 10));
    const id = await tableIdByName(token);
    return id !== undefined && isManagedTable(id);
}

/**
 * Start watching netlink events for address / link / route changes.
 * Any relevant event triggers a debounced reconfigure; the registered
 * uplinks-changed handlers run whenever the uplinks file content changed.
 */
export function startInterfaceMonitor(): void {
    monitorWanted = true;
    if (monitorProc) return;

    void seedManagedTableCount();
    console.log(
        "Starting interface monitor (ip monitor address link route)...",
    );
    const proc = Bun.spawn(["ip", "monitor", "address", "link", "route"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    monitorProc = proc;

    (async () => {
        try {
            for await (const line of readLines(proc.stdout)) {
                if (
                    RELEVANT_EVENT.test(line) &&
                    !(await isSelfGeneratedEvent(line))
                ) {
                    scheduleReconcile(line.slice(0, 120));
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name !== "AbortError") {
                console.error("[monitor] reader error:", err.message);
            }
        }
    })();

    // Log stderr as warnings (netlink permission issues etc.)
    (async () => {
        try {
            for await (const line of readLines(proc.stderr)) {
                console.warn(`[monitor:stderr] ${line}`);
            }
        } catch {}
    })();

    proc.exited.then((code) => {
        if (monitorProc !== proc) return;
        monitorProc = null;
        if (!monitorWanted) return;
        console.warn(
            `[monitor] ip monitor exited (code ${code}); restarting in 2s`,
        );
        setTimeout(() => {
            if (!monitorWanted) return;
            startInterfaceMonitor();
            // Events during the gap were lost: catch up.
            scheduleReconcile("monitor restarted");
        }, 2000);
    });
}

export async function stopInterfaceMonitor(): Promise<void> {
    monitorWanted = false;
    const proc = monitorProc;
    monitorProc = null;
    if (proc && proc.exitCode === null) {
        proc.kill("SIGTERM");
        await proc.exited.catch(() => {});
    }
    if (monitorDebounceTimer) {
        clearTimeout(monitorDebounceTimer);
        monitorDebounceTimer = null;
    }
}
