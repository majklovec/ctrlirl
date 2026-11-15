/*
 * hooks provider (handoff §9.7): the escape hatch for logic that no rule
 * expresses. `install.sh` runs after everything else in the module's install,
 * `uninstall.sh` runs first in the uninstall. Both get the environment
 * CTRLIRL_ROLE / CTRLIRL_MODULE / CTRLIRL_INSTALL_DIR.
 *
 * Hooks are NOT idempotent by design — the installer always runs them. State
 * records every hook that ran (`hooksRun`, entries `<module>:install`) so the
 * uninstall counterpart is invoked even when the install partially failed.
 */
import { join } from "node:path";
import { run, type RunOpts } from "../host";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    StepKey,
    ProviderResult,
} from "../provider";

export function hooksProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["hooksInstall", "hooksUninstall"];
    return {
        name: "hooks",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "hooksInstall") return hooksInstall(ctx, runOpts);
            return hooksUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            const h = ctx.spec.hooks;
            const script = mode === "install" ? h?.install : h?.uninstall;
            return script
                ? [{ mark: "*" as const, target: join(ctx.opts.installDir, script) }]
                : [];
        },
    };
}

const hookEnv = (ctx: ModuleCtx): Record<string, string> => ({
    CTRLIRL_ROLE: ctx.role,
    CTRLIRL_MODULE: ctx.module,
    CTRLIRL_INSTALL_DIR: ctx.opts.installDir,
});

async function hookRun(
    ctx: ModuleCtx,
    script: string,
    record: string,
    opts: RunOpts,
): Promise<string[]> {
    const full = join(ctx.opts.installDir, script);
    const res = await run("sh", [full], {
        ...opts,
        env: hookEnv(ctx),
    });
    if (res.exitCode !== 0)
        throw new Error(
            `hooks: ${script} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
        );
    if (!ctx.state.hooksRun.includes(record)) ctx.state.hooksRun.push(record);
    return [`    * ${script}  (exit ${res.exitCode})`];
}

async function hooksInstall(
    ctx: ModuleCtx,
    opts: RunOpts,
): Promise<ProviderResult> {
    const script = ctx.spec.hooks?.install;
    if (!script) return { changed: false, lines: [] };
    const lines = await hookRun(ctx, script, `${ctx.module}:install`, opts);
    return { changed: true, lines };
}

async function hooksUninstall(
    ctx: ModuleCtx,
    opts: RunOpts,
): Promise<ProviderResult> {
    // Run the uninstall counterpart only if the install hook actually ran.
    if (!ctx.state.hooksRun.includes(`${ctx.module}:install`))
        return { changed: false, lines: [] };
    const script = ctx.spec.hooks?.uninstall;
    if (!script) {
        // No counterpart declared: just clear the record.
        ctx.state.hooksRun = ctx.state.hooksRun.filter(
            (h) => h !== `${ctx.module}:install`,
        );
        return { changed: false, lines: [] };
    }
    const lines = await hookRun(ctx, script, `${ctx.module}:uninstall`, opts);
    ctx.state.hooksRun = ctx.state.hooksRun.filter(
        (h) => h !== `${ctx.module}:install`,
    );
    return { changed: true, lines };
}
