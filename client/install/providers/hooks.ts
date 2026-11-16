/*
 * hooks provider (handoff §9.7): the escape hatch for logic that no rule
 * expresses. `install.sh` runs after everything else in the module's install,
 * `uninstall.sh` runs first in the uninstall. Both get the environment
 * CTRLIRL_ROLE / CTRLIRL_MODULE / CTRLIRL_INSTALL_DIR / CTRLIRL_INSTALL_ROOT.
 *
 * Hooks are NOT idempotent by design — the installer always runs them. State
 * records every hook that ran (`hooksRun`, entries `<module>:install`) so the
 * uninstall counterpart is invoked even when the install partially failed.
 */
import { join } from "node:path";
import type { HookCommand } from "../../../shared/install/types";
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
            const hook = mode === "install" ? h?.install : h?.uninstall;
            if (!hook) return [];
            const [script, ...args] = hookParts(hook);
            const detail = hookArgsDetail(args);
            return [{
                mark: "*",
                target: join(ctx.opts.installDir, script),
                ...(detail ? { detail } : {}),
            }];
        },
    };
}

export const hookParts = (hook: HookCommand): [string, ...string[]] =>
    typeof hook === "string" ? [hook] : hook;

export const hookArgsDetail = (args: string[]): string | undefined =>
    args.length ? `arguments: ${args.map((arg) => JSON.stringify(arg)).join(" ")}` : undefined;

const hookEnv = (ctx: ModuleCtx): Record<string, string> => ({
    CTRLIRL_ROLE: ctx.role,
    CTRLIRL_MODULE: ctx.module,
    CTRLIRL_INSTALL_DIR: ctx.opts.installDir,
    CTRLIRL_INSTALL_ROOT: ctx.opts.root,
});

async function hookRun(
    ctx: ModuleCtx,
    hook: HookCommand,
    record: string,
    opts: RunOpts,
): Promise<string[]> {
    const [script, ...args] = hookParts(hook);
    const full = join(ctx.opts.installDir, script);
    const res = await run("sh", [full, ...args], {
        ...opts,
        env: hookEnv(ctx),
    });
    if (res.exitCode !== 0)
        throw new Error(
            `hooks: ${script} failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
        );
    if (!ctx.state.hooksRun.includes(record)) ctx.state.hooksRun.push(record);
    return [`    * ${[script, ...args].join(" ")}  (exit ${res.exitCode})`];
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
