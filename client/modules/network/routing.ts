/*
 * Interface detection, bonding selection and the live netlink interface
 * monitor.
 *
 * The SRTLA half (per-source routing tables, the srtla_send uplinks file, the
 * default-route failover) lives in the `srtla` module — it runs only on the
 * SRTLA leg owner (the encoder); a relay-side box needs none of it. This
 * module exposes the bond to the srtla module (and to per-interface consumers
 * like ctrlink-relay) through the `network.interfaces` capability: detection,
 * the selection, the debounced reconciles and the self-generated-event hooks.
 *
 * Bound by the network module at discovery (`bindRouting`): the core bag
 * supplies the process entry points; the modems module supplies the
 * ModemManager lookups over the `modems.source` capability.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { intArgEnv } from "../../../shared/args";
import { isCtrlinkTun } from "../../../shared/ctrlink_discovery";
import { ipQuery } from "../../../shared/ip";
import { errorMessage, readLines } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import type {
    Iface,
    Modem,
    ModemConfig,
    ModemSource,
} from "./types";
export { setIpQueryForTest } from "../../../shared/ip";

const DEBOUNCE_MS = intArgEnv("--debounce-ms", "DEBOUNCE_MS", 1500);

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

const isVirtual = (iface: string): boolean =>
    VIRTUAL_PREFIXES.some((p) => iface.startsWith(p));

/** Read-only `ip` query that always runs (interface detection works under --dry-run too). */
async function query(args: string[]): Promise<string> {
    return ipQuery(args);
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
                    // table — carry it so the srtla plan can route off-link traffic.
                    gateway: modem.gateway,
                });
            }
        }),
    );
    return entries;
}

/** The main-table default route: which interface (and source IP) carries it. */
export async function defaultRouteDetails(): Promise<{
    iface: string;
    ip: string | null;
} | null> {
    const route = await ipQuery(["-4", "route", "get", "1.1.1.1"]);
    const iface = route.match(/\bdev\s+(\S+)/)?.[1];
    if (!iface) return null;
    return {
        iface,
        ip: route.match(/\bsrc\s+(\S+)/)?.[1] ?? null,
    };
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
 * for the read so a code path that resolves before the migration runs still
 * matches the legacy behaviour; `migrateSelection` converts it to `excluded`
 * on the first reconcile.
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
 * form once the interfaces are known: everything currently present that the
 * include list omitted becomes `excluded`, so a later-appearing interface is
 * bonded by default. Persisted as `{excluded}`, so this fires exactly once
 * per legacy config. No-op for a selection that is already in the new form
 * (including `{}`, "bond all").
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
// Live interface monitor (netlink via `ip monitor`)
// ----------------------------------------------------------------------
/**
 * Reconcile handlers: modules that re-apply state from the live bond (the
 * srtla module's routing tables + uplinks file). Run on every debounced
 * netlink reconcile (and a manual reconfigure), before the interface-change
 * handlers fire. Each returns its result (or nothing); `{ok:false}` counts
 * the reconcile as failed.
 */
const reconcileHandlers = new Set<() => Promise<unknown>>();

/** Register a debounced-reconcile handler (`network.interfaces.onReconcile`); returns the unsubscribe. */
export function onReconcile(
    handler: () => Promise<unknown>,
): () => void {
    reconcileHandlers.add(handler);
    return () => reconcileHandlers.delete(handler);
}

/**
 * Self-generated-event classifiers (the srtla module's): a route-event line
 * any of them recognises as coming from the module's own routing tables is
 * filtered out, so the monitor does not reconcile on its own writes.
 */
const selfGenChecks = new Set<(line: string) => Promise<boolean>>();

/** Register a self-generated-event classifier (`network.interfaces.onSelfGeneratedEvent`); returns the unsubscribe. */
export function onSelfGeneratedEvent(
    check: (line: string) => Promise<boolean>,
): () => void {
    selfGenChecks.add(check);
    return () => selfGenChecks.delete(check);
}

async function isSelfGeneratedEvent(line: string): Promise<boolean> {
    for (const check of selfGenChecks) if (await check(line)) return true;
    return false;
}

let monitorProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let monitorDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let monitorBusy = false;
let monitorPending = false;
let monitorWanted = false;

/** Run every reconcile handler now; aggregates their results. */
async function runReconcileHandlers(): Promise<{
    ok: boolean;
    changed: boolean;
    error?: string;
}> {
    const results = await Promise.all(
        [...reconcileHandlers].map((handler) =>
            handler().catch((err: unknown) => {
                console.warn(`Reconcile handler failed: ${errorMessage(err)}`);
                return { ok: false, changed: false, error: errorMessage(err) };
            }),
        ),
    );
    const errors: string[] = [];
    let changed = false;
    for (const r of results) {
        const result = r as
            | { ok?: boolean; changed?: boolean; error?: string }
            | undefined;
        if (result?.ok === false)
            errors.push(result.error ?? "unknown error");
        else if (result?.changed === true) changed = true;
    }
    return {
        ok: errors.length === 0,
        changed,
        ...(errors.length ? { error: errors.join("; ") } : {}),
    };
}

/** A manual reconfigure (dashboard action / API): reconcile now, then
 * re-evaluate the interface-change signature. */
export async function manualReconcile(): Promise<{
    ok: boolean;
    changed: boolean;
    error?: string;
}> {
    const result = await runReconcileHandlers();
    fireInterfaceChangeIfChanged();
    return result;
}

/**
 * Schedule a reconcile after a short debounce.
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
        const result = await runReconcileHandlers();
        if (!result.ok) {
            console.warn(`[monitor] reconcile failed: ${result.error}`);
            return;
        }
        if (result.changed) {
            // `Uplinks file updated: ...` (from the srtla reconcile) carries
            // the IPs; the srtla reconcile already ran the uplinks-changed
            // handlers.
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

export const isMonitorRunning = (): boolean => monitorProc !== null;

/**
 * Start watching netlink events for address / link / route changes.
 * Any relevant event triggers a debounced reconcile of the registered
 * handlers (the srtla tables + uplinks file).
 */
export function startInterfaceMonitor(): void {
    monitorWanted = true;
    if (monitorProc) return;

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
 * after a reconcile (and on a manual reconfigure) so per-interface consumers
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
