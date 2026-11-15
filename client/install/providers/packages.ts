/*
 * packages provider (handoff §9.6): check dependencies with `dpkg -s`; install
 * missing ones only with `--install-deps` (`apt-get install -y`). State records
 * which packages *we* added (`packagesAdded`); `--purge` (or a rollback) removes
 * exactly those and never touches pre-existing packages.
 */
import { run, type RunOpts } from "../host";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    StepKey,
    ProviderResult,
} from "../provider";

export function packagesProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["packagesCheck", "packagesPurge"];
    return {
        name: "packages",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "packagesCheck") return pkgsCheck(ctx, runOpts);
            return pkgsPurge(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            if (mode === "install")
                return (ctx.spec.dependencies ?? []).map((d) => ({
                    mark: "*" as const,
                    target: `dpkg -s ${d}`,
                    detail: "check",
                }));
            return ctx.state.packagesAdded.map((p) => ({
                mark: "-" as const,
                target: p,
                detail: "only with --purge",
            }));
        },
    };
}

async function pkgsCheck(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const deps = ctx.spec.dependencies ?? [];
    if (deps.length === 0) return { changed: false, lines: [] };
    const lines: string[] = [];
    const addedThisRun: string[] = [];
    for (const pkg of deps) {
        const res = await run("dpkg", ["-s", pkg], opts);
        if (res.exitCode === 0) {
            lines.push(`    ~ ${pkg}  (present)`);
            continue;
        }
        if (!ctx.opts.installDeps)
            throw new Error(
                `packages: required package "${pkg}" is not installed — rerun with --install-deps to let the installer apt-install it`,
            );
        const inst = await run("apt-get", ["install", "-y", pkg], opts);
        if (inst.exitCode !== 0)
            throw new Error(
                `packages: apt-get install ${pkg} failed: ${inst.stderr.trim()}`,
            );
        if (!ctx.state.packagesAdded.includes(pkg))
            ctx.state.packagesAdded.push(pkg);
        addedThisRun.push(pkg);
        lines.push(`    + ${pkg}  (apt-get install)`);
    }
    // Rollback of this run removes exactly what this run added.
    ctx.transient.purgeAdded = addedThisRun;
    return { changed: addedThisRun.length > 0, lines };
}

async function pkgsPurge(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    // Rollback: only what THIS run added. Explicit --purge: everything we ever added.
    const rollback = ctx.opts.rollback === true;
    const scope = (ctx.transient.purgeAdded as string[] | undefined) ?? [];
    const targets = rollback
        ? scope
        : ctx.opts.purge
            ? ctx.state.packagesAdded
            : [];
    if (targets.length === 0) return { changed: false, lines: [] };
    const lines: string[] = [];
    for (const pkg of targets) {
        const res = await run("apt-get", ["remove", "-y", pkg], opts);
        if (res.exitCode !== 0)
            throw new Error(
                `packages: apt-get remove ${pkg} failed: ${res.stderr.trim()}`,
            );
        lines.push(`    - ${pkg}  (apt-get remove)`);
    }
    ctx.state.packagesAdded = ctx.state.packagesAdded.filter(
        (p) => !targets.includes(p),
    );
    return { changed: true, lines };
}
