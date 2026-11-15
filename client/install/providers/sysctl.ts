/*
 * sysctl provider: write `/etc/sysctl.d/90-ctrlirl-<module>.conf` (one
 * `key = value` per line, sorted), apply with `sysctl --system`, and record the
 * previous value of each key. Reversible: remove the file, restore recorded
 * prev values, re-apply. Never touches `/etc/sysctl.conf` (handoff §9.2).
 */
import type { DryArtifact, InstallProvider, ModuleCtx, StepKey, ProviderResult } from "../provider";
import {
    removeHostFile,
    resolvePath,
    run,
    writeManagedFile,
    type RunOpts,
} from "../host";

const confPath = (module: string): string =>
    `/etc/sysctl.d/90-ctrlirl-${module}.conf`;

export function sysctlProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["sysctlInstall", "sysctlUninstall"];
    return {
        name: "sysctl",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "sysctlInstall") return sysctlInstall(ctx, runOpts);
            return sysctlUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            const keys = Object.keys(ctx.spec.sysctl ?? {}).sort();
            if (mode === "install")
                return keys.map((k) => ({
                    mark: "+" as const,
                    target: `${k} = ${(ctx.spec.sysctl as Record<string, number | string>)[k]}`,
                    detail: "write",
                }));
            return Object.keys(ctx.state.sysctl).length
                ? [{ mark: "-" as const, target: confPath(ctx.module) }]
                : [];
        },
    };
}

const prevValuePath = (key: string): string =>
    `/proc/sys/${key.replace(/\./g, "/")}`;

async function sysctlInstall(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const spec = (ctx.spec.sysctl ?? {}) as Record<string, number | string>;
    const keys = Object.keys(spec).sort();
    if (!keys.length) return { changed: false, lines: [] };
    const lines: string[] = [];
    for (const key of keys) {
        // Record the previous value (null when the key was not set).
        if (ctx.state.sysctl[key] === undefined) {
            const prev = await readProcValue(ctx.opts.root, key);
            ctx.state.sysctl[key] = { prev };
        }
        lines.push(`    + ${key} = ${spec[key]}  (write)`);
    }
    const content = keys.map((k) => `${k} = ${spec[k]}`).join("\n") + "\n";
    await writeManagedFile(ctx.opts.root, confPath(ctx.module), content);
    await run("sysctl", ["--system"], opts);
    return { changed: true, lines };
}

async function readProcValue(root: string, key: string): Promise<string | null> {
    // Read the current kernel value; null if the key is unknown.
    const { readFile } = await import("node:fs/promises");
    const full = resolvePath(root, prevValuePath(key));
    const raw = await readFile(full, "utf8").catch((): string | null => null);
    return raw === null ? null : raw.trim();
}

async function sysctlUninstall(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const keys = Object.keys(ctx.state.sysctl);
    const any = keys.length > 0;
    // Restore recorded previous values that were set (prev !== null).
    const restore: string[] = [];
    for (const key of keys) {
        const prev = ctx.state.sysctl[key].prev;
        if (prev !== null) restore.push(`${key}=${prev}`);
    }
    await removeHostFile(ctx.opts.root, confPath(ctx.module));
    ctx.state.sysctl = {};
    if (any) {
        if (restore.length) {
            // Write a transient restore file, apply, then remove it.
            const restoreRel = `/etc/sysctl.d/89-ctrlirl-restore-${ctx.module}.conf`;
            await writeManagedFile(
                ctx.opts.root,
                restoreRel,
                restore.map((r) => r.replace("=", " = ")).join("\n") + "\n",
            );
            await run("sysctl", ["--system"], opts);
            await removeHostFile(ctx.opts.root, restoreRel);
        } else {
            await run("sysctl", ["--system"], opts);
        }
    }
    return { changed: any, lines: any ? ["    - sysctl file removed"] : [] };
}
