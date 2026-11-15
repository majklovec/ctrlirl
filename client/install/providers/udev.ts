/*
 * udev provider (handoff §9.4):
 *  - filename must match `^\d{2}-ctrlirl-[a-z0-9_-]+\.rules$` (the schema
 *    enforces it at load; re-checked here for direct callers);
 *  - refuse to overwrite a rule file that exists but is not recorded in state;
 *  - write with a `# managed by ctrlirl (<role>/<module>)` header;
 *  - `udevadm control --reload-rules` only when at least one file was written;
 *  - `udevadm trigger` only when a rule declares `trigger`, with the declared
 *    filters and default `--action=change`;
 *  - skip-if-identical: no write, no reload, no trigger for that rule;
 *  - uninstall removes the recorded files and reloads only if ≥1 was removed.
 */
import {
    fileExists,
    readHostFile,
    resolvePath,
    run,
    writeManagedFile,
    type RunOpts,
} from "../host";
import { rm } from "node:fs/promises";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    StepKey,
    ProviderResult,
} from "../provider";

const RULES_DIR = "/etc/udev/rules.d";
const FILENAME_RE = /^\d{2}-ctrlirl-[a-z0-9_-]+\.rules$/;
const header = (role: string, module: string) =>
    `# managed by ctrlirl (${role}/${module})\n`;

export function udevProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["udevInstall", "udevUninstall"];
    return {
        name: "udev",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "udevInstall") return udevInstall(ctx, runOpts);
            return udevUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            if (mode === "install")
                return (ctx.spec.udev ?? []).map((r) => ({
                    mark: "+" as const,
                    target: `${RULES_DIR}/${r.file}`,
                    detail: r.trigger ? "write, reload, trigger" : "write, reload",
                }));
            return ctx.state.udevFiles.map((f) => ({
                mark: "-" as const,
                target: f,
            }));
        },
    };
}

async function udevInstall(
    ctx: ModuleCtx,
    opts: RunOpts,
): Promise<ProviderResult> {
    const lines: string[] = [];
    let wrote = false;
    for (const r of ctx.spec.udev ?? []) {
        if (!FILENAME_RE.test(r.file))
            throw new Error(
                `udev: filename ${r.file} does not match ${FILENAME_RE}`,
            );
        const hostRel = `${RULES_DIR}/${r.file}`;
        const full = resolvePath(ctx.opts.root, hostRel);
        const content = header(ctx.role, ctx.module) + (r.content ?? "");
        const existing = await fileExists(full)
            ? await readHostFile(ctx.opts.root, hostRel)
            : null;
        if (existing === content) {
            // skip-if-identical: no write, and this rule must not force a reload.
            if (!ctx.state.udevFiles.includes(full)) ctx.state.udevFiles.push(full);
            lines.push(`    ~ ${r.file}  (unchanged, skip)`);
            continue;
        }
        if (existing !== null && !ctx.state.udevFiles.includes(full))
            throw new Error(
                `udev: ${full} already exists and is not managed by ctrlirl — refusing to overwrite`,
            );
        await writeManagedFile(ctx.opts.root, hostRel, content, 0o644);
        if (!ctx.state.udevFiles.includes(full)) ctx.state.udevFiles.push(full);
        wrote = true;
        lines.push(`    + ${r.file}  (write)`);
    }
    if (wrote) {
        await run("udevadm", ["control", "--reload-rules"], opts);
        lines.push("    udevadm control --reload-rules");
        for (const r of ctx.spec.udev ?? []) {
            const t = r.trigger;
            if (!t) continue;
            const args = ["udevadm", "trigger"];
            if (t.subsystem) args.push(`--subsystem-match=${t.subsystem}`);
            if (t.attrMatch) args.push(`--attr-match=${t.attrMatch}`);
            args.push(`--action=${t.action ?? "change"}`);
            await run(args[0], args.slice(1), opts);
            lines.push(`    ${args.join(" ")}  (${ctx.role}/${ctx.module}: ${r.file})`);
        }
    }
    return { changed: wrote, lines };
}

async function udevUninstall(
    ctx: ModuleCtx,
    opts: RunOpts,
): Promise<ProviderResult> {
    let removed = 0;
    for (const f of ctx.state.udevFiles) {
        if (await fileExists(f)) {
            await rm(f, { force: true });
            removed++;
        }
    }
    ctx.state.udevFiles = [];
    if (removed === 0) return { changed: false, lines: [] };
    await run("udevadm", ["control", "--reload-rules"], opts);
    return { changed: true, lines: [`    - udev rule(s) removed (${removed})`] };
}
