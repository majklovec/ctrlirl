/*
 * systemd provider: write the unit under `/etc/systemd/system/`, daemon-reload,
 * enable (and start) it. Reversible: stop, disable, remove the unit, reload.
 *
 * Guard (handoff §9.1): refuse to overwrite a unit file that exists on disk but
 * was not recorded as ours in the module state — that would clobber an
 * operator-managed unit.
 */
import type { DryArtifact, InstallProvider, ModuleCtx, StepKey, ProviderResult } from "../provider";
import { rm } from "node:fs/promises";
import {
    fileExists,
    resolvePath,
    run,
    writeManagedFile,
    type RunOpts,
} from "../host";

const STATE_PATH = "/etc/systemd/system";

export function systemdProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["systemdInstall", "systemdUninstall"];
    return {
        name: "systemd",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "systemdInstall") return systemctlInstall(ctx, runOpts);
            return systemctlUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            if (mode === "install")
                return (ctx.spec.services ?? []).map((svc) => ({
                    mark: "+" as const,
                    target: unitName(svc.name),
                    detail: "write, enable, start",
                }));
            return ctx.state.services.map((svc) => ({
                mark: "-" as const,
                target: svc.name,
            }));
        },
    };
}

const unitName = (name: string): string =>
    /\.(service|timer|socket)$/.test(name) ? name : `${name}.service`;

async function systemctlInstall(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const lines: string[] = [];
    for (const svc of ctx.spec.services ?? []) {
        const name = unitName(svc.name);
        const hostRel = `${STATE_PATH}/${name}`;
        const full = resolvePath(ctx.opts.root, hostRel);
        // Guard: an unmanaged, pre-existing unit must not be overwritten.
        if (await fileExists(full)) {
            const recorded = ctx.state.services.some((s) => s.path === full);
            if (!recorded)
                throw new Error(
                    `systemd: ${full} already exists and is not managed by ctrlirl — refusing to overwrite`,
                );
        }
        const content = svc.content ?? `# ${name}\n`;
        const changed = await writeManagedFile(ctx.opts.root, hostRel, content);
        const enabled = svc.enabled ?? true;
        const started = svc.started ?? true;
        if (!ctx.state.services.some((s) => s.path === full))
            ctx.state.services.push({ name, path: full, enabled, started });
        else
            Object.assign(ctx.state.services.find((s) => s.path === full)!, {
                enabled,
                started,
            });
        if (!(ctx.transient.reloaded as boolean)) {
            await run("systemctl", ["daemon-reload"], opts);
            ctx.transient.reloaded = true;
        }
        if (enabled) await run("systemctl", ["enable", name], opts);
        if (started && enabled) await run("systemctl", ["start", name], opts);
        lines.push(
            `    ${changed ? "+" : "~"} ${name}  (${changed ? "write" : "unchanged, skip"}, ${
                started ? "enable, start" : "enable"
            })`,
        );
    }
    return { changed: lines.length > 0, lines };
}

async function systemctlUninstall(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const any = ctx.state.services.length > 0;
    for (const svc of ctx.state.services) {
        // Best-effort: the unit may already be stopped / absent.
        const res = await run("systemctl", ["disable", "--now", svc.name], opts);
        if (res.exitCode !== 0)
            console.warn(`systemd: disable --now ${svc.name}: ${res.stderr}`);
        // svc.path is recorded root-applied and absolute; remove it directly
        // (re-resolving would anchor it against `/etc/...` again).
        await rm(svc.path, { force: true });
    }
    if (any) await run("systemctl", ["daemon-reload"], opts);
    ctx.state.services = [];
    return { changed: any, lines: any ? ["    - systemd unit(s) removed"] : [] };
}
