/*
 * Fake provider bundles for tests (no root, no real host). Each factory
 * returns one `InstallProvider` mirroring a real provider (systemd, sysctl,
 * overlay, udev, firewall, packages, hooks). They simulate the host by writing
 * into `ctx.opts.root` (a temp dir via CTRLIRL_ROOT_OVERRIDE) and record every
 * step into a shared `FakeLog`, so tests can assert the sequence, idempotency
 * and reversal. The overlay is driven by real files staged under
 * `installDir/overlay/…` (mirrored onto the destination root).
 */
import {
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    ProviderResult,
    StepKey,
} from "../provider";
import { hookArgsDetail, hookParts } from "./hooks";

export interface FakeLog {
    calls: string[];
    reloads: string[];
    hooks: string[];
    triggers: string[];
}
export const freshLog = (): FakeLog => ({
    calls: [],
    reloads: [],
    hooks: [],
    triggers: [],
});

const NOOP: ProviderResult = { changed: false, lines: [] };

const abs = (ctx: ModuleCtx, rel: string): string =>
    join(ctx.opts.root, rel.replace(/^\//, ""));

async function writeIfChanged(
    ctx: ModuleCtx,
    hostRel: string,
    content: string,
): Promise<boolean> {
    const full = abs(ctx, hostRel);
    await mkdir(dirname(full), { recursive: true });
    const existing = await readFile(full, "utf8").catch((): string | null => null);
    if (existing === content) return false;
    await writeFile(full, content);
    return true;
}

async function listRel(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string, rel: string): Promise<void> => {
        const entries = await readdir(d, { withFileTypes: true }).catch((): [] => []);
        for (const e of entries) {
            const subRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(join(d, e.name), subRel);
            else out.push(subRel);
        }
    };
    await walk(dir, "");
    return out;
}

const countLines = (s: string): number => (s ? s.split("\n").length : 0);

function base(
    name: string,
    steps: StepKey[],
    log: FakeLog,
    run: (step: StepKey, ctx: ModuleCtx) => Promise<ProviderResult>,
    dryRun?: (mode: "install" | "uninstall", ctx: ModuleCtx) => Promise<DryArtifact[]>,
): InstallProvider {
    return {
        name,
        steps,
        run: async (step, ctx) => {
            log.calls.push(`${name}:${step}`);
            return run(step, ctx);
        },
        dryRun: dryRun ?? (async () => []),
    };
}

export function fakePackages(log: FakeLog): InstallProvider {
    return base(
        "packages",
        ["packagesCheck", "packagesPurge"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "packagesCheck") {
                for (const dep of ctx.spec.dependencies ?? [])
                    if (!s.packagesAdded.includes(dep) && ctx.opts.installDeps)
                        s.packagesAdded.push(dep);
                return NOOP;
            }
            const any = s.packagesAdded.length > 0;
            if (ctx.opts.purge || ctx.opts.rollback) s.packagesAdded = [];
            return { changed: any, lines: any ? ["    - package(s) purged"] : [] };
        },
        async (mode, ctx) =>
            mode === "install"
                ? (ctx.spec.dependencies ?? []).map((d) => ({
                      mark: "~" as const,
                      target: d,
                      detail: "installed",
                  }))
                : [],
    );
}

export function fakeOverlay(log: FakeLog): InstallProvider {
    return base(
        "overlay",
        ["overlayInstall", "overlayReload", "overlayUninstall"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "overlayInstall") {
                const lines: string[] = [];
                let any = false;
                const stage = join(ctx.opts.installDir, "overlay");
                for (const rel of (await listRel(stage)).sort()) {
                    const hostRel = `/${rel}`;
                    const content = await readFile(join(stage, rel), "utf8");
                    const recordPath = abs(ctx, hostRel);
                    const changed = await writeIfChanged(ctx, hostRel, content);
                    if (!s.overlayFiles.includes(recordPath)) s.overlayFiles.push(recordPath);
                    lines.push(`    ${changed ? "+" : "~"} ${recordPath}  (${changed ? "write" : "unchanged, skip"})`);
                    any = true;
                }
                ctx.transient.overlayChanged = any;
                return { changed: any, lines };
            }
            if (step === "overlayReload")
                return ctx.transient.overlayChanged
                    ? {
                          changed: true,
                          lines: (ctx.spec.overlay?.reload ?? []).map(
                              (c) => (log.reloads.push(c), `    * ${c}`),
                          ),
                      }
                    : NOOP;
            const any = s.overlayFiles.length > 0;
            for (const f of s.overlayFiles) await rm(f, { force: true });
            s.overlayFiles = [];
            s.overlayDirs = [];
            return { changed: any, lines: any ? ["    - overlay file(s) removed"] : [] };
        },
        async (mode, ctx) => {
            if (mode === "uninstall")
                return ctx.state.overlayFiles.map((f) => ({ mark: "-" as const, target: f }));
            // install dry-run: walk the staged overlay tree, comparing to the dest.
            const stage = join(ctx.opts.installDir, "overlay");
            const out: DryArtifact[] = [];
            for (const rel of (await listRel(stage)).sort()) {
                const hostRel = `/${rel}`;
                const content = await readFile(join(stage, rel), "utf8");
                const destFull = abs(ctx, hostRel);
                const existing = await readFile(destFull, "utf8").catch((): string | null => null);
                out.push({
                    mark: existing === content ? "~" : "+",
                    target: hostRel,
                    detail: existing === content ? "unchanged, skip" : "write",
                });
            }
            return out;
        },
    );
}

export function fakeUdev(log: FakeLog): InstallProvider {
    return base(
        "udev",
        ["udevInstall", "udevUninstall"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "udevInstall") {
                const lines: string[] = [];
                let any = false;
                for (const rule of ctx.spec.udev ?? []) {
                    const hostRel = `/etc/udev/rules.d/${rule.file}`;
                    const content = `# managed by ctrlirl (${ctx.role}/${ctx.module})\n${rule.content ?? ""}`;
                    const changed = await writeIfChanged(ctx, hostRel, content);
                    const recordPath = abs(ctx, hostRel);
                    if (!s.udevFiles.includes(recordPath)) s.udevFiles.push(recordPath);
                    lines.push(`    + ${recordPath}  (${changed ? "write" : "unchanged, skip"})`);
                    if (rule.trigger) log.triggers.push(recordPath);
                    any = true;
                }
                return { changed: any, lines };
            }
            const any = s.udevFiles.length > 0;
            for (const f of s.udevFiles) await rm(f, { force: true });
            s.udevFiles = [];
            return { changed: any, lines: any ? ["    - udev file(s) removed"] : [] };
        },
        async (mode, ctx) =>
            mode === "install"
                ? (ctx.spec.udev ?? []).map((r) => ({
                      mark: "+" as const,
                      target: `/etc/udev/rules.d/${r.file}`,
                      detail: `write, ${countLines(r.content ?? "")} rules`,
                  }))
                : ctx.state.udevFiles.map((f) => ({ mark: "-" as const, target: f })),
    );
}

export function fakeSysctl(log: FakeLog): InstallProvider {
    return base(
        "sysctl",
        ["sysctlInstall", "sysctlUninstall"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "sysctlInstall") {
                const spec = (ctx.spec.sysctl ?? {}) as Record<string, number | string>;
                const keys = Object.keys(spec).sort();
                if (!keys.length) return NOOP;
                for (const k of keys)
                    if (s.sysctl[k] === undefined) s.sysctl[k] = { prev: null };
                const hostRel = `/etc/sysctl.d/90-ctrlirl-${ctx.module}.conf`;
                await writeIfChanged(
                    ctx,
                    hostRel,
                    keys.map((k) => `${k} = ${spec[k]}`).join("\n") + "\n",
                );
                return {
                    changed: true,
                    lines: keys.map((k) => `    + ${k} = ${spec[k]}  (write)`),
                };
            }
            const any = Object.keys(s.sysctl).length > 0;
            // Remove the sysctl file we wrote (mirrors the real provider).
            await rm(abs(ctx, `/etc/sysctl.d/90-ctrlirl-${ctx.module}.conf`), { force: true });
            s.sysctl = {};
            return { changed: any, lines: any ? ["    - sysctl file removed"] : [] };
        },
    );
}

export function fakeFirewall(log: FakeLog): InstallProvider {
    return base(
        "firewall",
        ["firewallInstall", "firewallUninstall"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "firewallInstall") {
                const rules = ctx.spec.firewall ?? [];
                if (!rules.length) return NOOP;
                const table = `ctrlirl_${ctx.role}_${ctx.module}`;
                if (s.firewall.type !== "nft") s.firewall = { type: "nft", table };
                (s.firewall as { table: string }).table = table;
                return {
                    changed: true,
                    lines: rules.map((r) => `    + ${r.chain}: ${r.rule}  (nft ${table})`),
                };
            }
            if (s.firewall.type === "nft") (s.firewall as { table: string }).table = "";
            return { changed: true, lines: [] };
        },
    );
}

export function fakeSystemd(log: FakeLog): InstallProvider {
    return base(
        "systemd",
        ["systemdInstall", "systemdUninstall"],
        log,
        async (step, ctx) => {
            const s = ctx.state;
            if (step === "systemdInstall") {
                const lines: string[] = [];
                for (const svc of ctx.spec.services ?? []) {
                    const name = svc.name.endsWith(".service")
                        ? svc.name
                        : `${svc.name}.service`;
                    const hostRel = `/etc/systemd/system/${name}`;
                    const changed = await writeIfChanged(
                        ctx,
                        hostRel,
                        svc.content ?? `# ${name}\n`,
                    );
                    const recordPath = abs(ctx, hostRel);
                    const existing = s.services.find((x) => x.path === recordPath);
                    if (existing) existing.enabled = svc.enabled ?? true;
                    else
                        s.services.push({
                            name,
                            path: recordPath,
                            enabled: svc.enabled ?? true,
                            started: svc.started ?? true,
                        });
                    lines.push(`    + ${name}  (${changed ? "write" : "unchanged, skip"}, enable, start)`);
                }
                return { changed: lines.length > 0, lines };
            }
            const any = s.services.length > 0;
            // svc.path is already an absolute host path recorded at install.
            for (const svc of s.services) await rm(svc.path, { force: true });
            s.services = [];
            return { changed: any, lines: any ? ["    - systemd unit(s) removed"] : [] };
        },
        async (mode, ctx) =>
            mode === "install"
                ? (ctx.spec.services ?? []).map((svc) => ({
                      mark: "+" as const,
                      target: svc.name.endsWith(".service") ? svc.name : `${svc.name}.service`,
                      detail: "write, enable, start",
                  }))
                : ctx.state.services.map((svc) => ({ mark: "-" as const, target: basename(svc.path) })),
    );
}

export function fakeHooks(log: FakeLog): InstallProvider {
    return base(
        "hooks",
        ["hooksInstall", "hooksUninstall"],
        log,
        async (step, ctx) => {
            const h = ctx.spec.hooks?.[step === "hooksInstall" ? "install" : "uninstall"];
            if (!h) return NOOP;
            const command = hookParts(h).join(" ");
            log.hooks.push(step === "hooksInstall" ? "install" : "uninstall");
            if (step === "hooksInstall" && !ctx.state.hooksRun.includes(command))
                ctx.state.hooksRun.push(command);
            return { changed: true, lines: [`    * ${command}`] };
        },
        async (mode, ctx) => {
            if (mode !== "install" || !ctx.spec.hooks?.install) return [];
            const [script, ...args] = hookParts(ctx.spec.hooks.install);
            const detail = hookArgsDetail(args);
            return [{ mark: "*", target: script, ...(detail ? { detail } : {}) }];
        },
    );
}

/** The full fake bundle in canonical provider order. */
export function fakeProviderBundle(log: FakeLog): InstallProvider[] {
    return [
        fakePackages(log),
        fakeOverlay(log),
        fakeUdev(log),
        fakeSysctl(log),
        fakeFirewall(log),
        fakeSystemd(log),
        fakeHooks(log),
    ];
}
