/*
 * overlay provider: copy the module's `install/overlay/` tree onto the
 * destination root (default `/`, overridden by CTRLIRL_ROOT_OVERRIDE in tests),
 * mirroring `/`. Reversible: delete exactly the files we recorded, then prune
 * the empty directories we created.
 *
 * Safety rails (handoff §14.3-§14.6):
 *  - source files must resolve (realpath) inside the overlay root — symlinks
 *    in the source are rejected, not followed;
 *  - destination paths must not contain `..` after normalization;
 *  - protected paths are refused unless listed in `overlay.allowProtected`;
 *  - skip-if-identical: a byte-identical destination is not rewritten or
 *    recorded; a modified destination in `preserve` is skipped with a warning.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve as pathResolve, sep } from "node:path";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    ProviderResult,
    StepKey,
} from "../provider";
import { run, type RunOpts } from "../host";

/** Paths the overlay must never write by default (handoff §14.4). */
export const PROTECTED_PREFIXES = [
    "/etc/shadow",
    "/etc/passwd",
    "/etc/group",
    "/etc/sudoers",
    "/etc/sudoers.d/",
    "/boot/",
    "/usr/lib/systemd/system/",
    "/usr/lib/systemd/user/",
];

const isProtected = (hostRel: string): boolean =>
    PROTECTED_PREFIXES.some(
        (p) =>
            (p.endsWith("/") ? hostRel.startsWith(p) : hostRel === p) ||
            (!p.endsWith("/") && hostRel.startsWith(p + "/")),
    );

const allowProtected = (ctx: ModuleCtx): Set<string> =>
    new Set(ctx.spec.overlay?.allowProtected ?? []);

export function overlayProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["overlayInstall", "overlayReload", "overlayUninstall"];
    return {
        name: "overlay",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "overlayInstall") return overlayInstall(ctx, runOpts);
            if (step === "overlayReload") return overlayReload(ctx, runOpts);
            return overlayUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            if (mode === "uninstall")
                return ctx.state.overlayFiles.map((f) => ({
                    mark: "-" as const,
                    target: toHostRel(f, ctx.opts.root),
                }));
            return overlayDryInstall(ctx);
        },
    };
}

/** Map an absolute recorded path back to its `/`-relative host form. */
const toHostRel = (absPath: string, root: string): string => {
    const rel = absPath.startsWith(root + sep)
        ? absPath.slice(root.length + 1)
        : absPath;
    return `/${rel}`;
};

async function overlayDryInstall(ctx: ModuleCtx): Promise<DryArtifact[]> {
    const out: DryArtifact[] = [];
    const stage = join(ctx.opts.installDir, "overlay");
    for (const rel of (await listStage(stage)).sort()) {
        const hostRel = `/${rel}`;
        const content = await readFile(join(stage, rel), "utf8");
        const { readFile: rf } = await import("node:fs/promises");
        const destFull = join(ctx.opts.root, rel);
        const existing = await rf(destFull, "utf8").catch((): string | null => null);
        let detail = existing === content ? "unchanged, skip" : "write";
        if (isProtected(hostRel) && !allowProtected(ctx).has(hostRel))
            detail = "PROTECTED (refused)";
        out.push({
            mark: existing === content ? "~" : "+",
            target: hostRel,
            detail,
        });
    }
    return out;
}

async function overlayInstall(ctx: ModuleCtx, _opts: RunOpts): Promise<ProviderResult> {
    const lines: string[] = [];
    let any = false;
    const stage = join(ctx.opts.installDir, "overlay");
    const stageReal = await realpath(stage).catch((): string | null => null);
    for (const rel of (await listStage(stage)).sort()) {
        const hostRel = `/${rel}`;
        // Traversal defense on the destination path.
        if (normalize(hostRel).includes(".."))
            throw new Error(`overlay: destination path escapes root: ${hostRel}`);
        // Symlink/traversal defense on the source file.
        const src = join(stage, rel);
        const srcReal = await realpath(src);
        if (stageReal && !srcReal.startsWith(stageReal + sep) && srcReal !== stageReal)
            throw new Error(`overlay: source escapes the overlay root (symlink?): ${rel}`);
        const st = await lstat(src);
        if (st.isSymbolicLink())
            throw new Error(`overlay: symlink in source is rejected: ${rel}`);
        const content = await readFile(src, "utf8");
        // Protected-path defense.
        if (isProtected(hostRel) && !allowProtected(ctx).has(hostRel))
            throw new Error(
                `overlay: refusing to write protected path ${hostRel} (add it to overlay.allowProtected)`,
            );
        const destFull = join(ctx.opts.root, rel);
        const existing = await readFile(destFull, "utf8").catch((): string | null => null);
        const mode = st.mode & 0o777 || 0o644;
        if (existing === content) {
            // skip-if-identical: not rewritten, not recorded for the first time.
            if (!ctx.state.overlayFiles.includes(destFull))
                ctx.state.overlayFiles.push(destFull);
            lines.push(`    ~ ${hostRel}  (unchanged, skip)`);
            continue;
        }
        // A modified, preserved file is left alone with a warning.
        if (existing !== null && (ctx.spec.overlay?.preserve ?? []).includes(rel)) {
            lines.push(`    ! ${hostRel}  (preserve: modified by operator, skipped)`);
            continue;
        }
        await recordCreatedDirs(ctx, destFull);
        await mkdir(dirname(destFull), { recursive: true });
        await writeFile(destFull, content, { mode });
        if (!ctx.state.overlayFiles.includes(destFull))
            ctx.state.overlayFiles.push(destFull);
        const prot =
            isProtected(hostRel) && allowProtected(ctx).has(hostRel)
                ? "protected, allowed by opt-in, "
                : "";
        lines.push(`    + ${hostRel}  (${prot}write)`);
        any = true;
    }
    ctx.transient.overlayChanged = any;
    return { changed: any, lines };
}

/**
 * Record which directories we are about to create so uninstall prunes exactly
 * those. Only directories that don't exist yet are recorded (a pre-existing
 * directory is never pruned).
 */
async function recordCreatedDirs(ctx: ModuleCtx, file: string): Promise<void> {
    const root = ctx.opts.root.endsWith(sep) ? ctx.opts.root : ctx.opts.root;
    let dir = dirname(file);
    while (dir.length >= root.length && dir !== root && dir !== dirname(dir)) {
        const st = await stat(dir).catch((): null => null);
        if (st === null && !ctx.state.overlayDirs.includes(dir))
            ctx.state.overlayDirs.push(dir);
        dir = dirname(dir);
    }
}

async function overlayReload(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    if (!ctx.transient.overlayChanged) return { changed: false, lines: [] };
    const lines: string[] = [];
    for (const cmd of ctx.spec.overlay?.reload ?? []) {
        // Commands run through the shell (they may chain, e.g. `a && b`).
        await run("sh", ["-c", cmd], opts);
        lines.push(`    * ${cmd}`);
    }
    return { changed: lines.length > 0, lines };
}

async function overlayUninstall(ctx: ModuleCtx, _opts: RunOpts): Promise<ProviderResult> {
    const any = ctx.state.overlayFiles.length > 0;
    for (const f of ctx.state.overlayFiles) await rm(f, { force: true });
    ctx.state.overlayFiles = [];
    // Prune the empty directories we created, deepest first.
    const dirs = [...ctx.state.overlayDirs].sort((a, b) => b.length - a.length);
    for (const d of dirs) {
        const st = await stat(d).catch(() => null);
        if (st?.isDirectory()) {
            const entries = await readdir(d).catch((): string[] => []);
            if (entries.length === 0) await rm(d, { recursive: true, force: true });
        }
    }
    ctx.state.overlayDirs = [];
    return { changed: any, lines: any ? ["    - overlay file(s) removed"] : [] };
}

/** Recursively list file paths (relative to `dir`) under the stage dir. */
async function listStage(dir: string): Promise<string[]> {
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
