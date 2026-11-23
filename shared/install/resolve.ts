/*
 * Placeholder resolution for merged install specs. Exactly three forms are
 * supported — no template logic (loops belong in hooks):
 *
 *  - `{{file:relative/path}}`  read a file under the module's `install/`
 *    directory and inline its content (long udev/firewall/service text).
 *    Paths must not escape `install/` (`..` is rejected).
 *  - `{{env:NAME}}`            the environment variable at install time; an
 *    unset variable is a hard error (never silently empty rules).
 *  - `{{cfg:path.to.key}}`     a value from the role's runtime config (e.g.
 *    the relay config slice); a missing path is a hard error.
 *
 * Placeholders are only honoured in declared string fields (service content,
 * firewall rules, udev content); everything else is copied through verbatim.
 */
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import type { ModuleInstallSpec, ServiceSpec, UdevRule } from "./types";
import { InstSpecError } from "./merge";

/** `install/` directory the placeholders are relative to. */
export type InstallBaseDir = string;

/**
 * True when `full` (absolute) is `base` itself or lies inside it. Uses a
 * relative-path check — a `startsWith(base + "/")` comparison silently
 * misfires on Windows, where `path.resolve` emits backslashes.
 */
function isWithin(base: string, full: string): boolean {
    const rel = pathRelative(base, full);
    return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

export const readFile = async (path: string): Promise<string> =>
    await Bun.file(path).text();

const PLACEHOLDER = /\{\{\s*(file|env|cfg):([^}]+?)\s*\}\}/g;

/** Resolve all placeholders in `value`. */
export async function resolvePlaceholdersIn(
    value: string,
    baseDir: InstallBaseDir,
    cfg: Record<string, unknown>,
    read: (path: string) => Promise<string> = readFile,
): Promise<string> {
    let out = "";
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
        const idx = match.index ?? 0;
        out += value.slice(last, idx);
        const [, kind, rawName] = match;
        const name = rawName.trim();
        if (!name) throw new InstSpecError("empty placeholder name");
        switch (kind) {
            case "file": {
                const full = pathResolve(baseDir, name);
                if (!isWithin(pathResolve(baseDir), full))
                    throw new InstSpecError(
                        `{{file:}} path escapes the install directory: ${name}`,
                    );
                try {
                    out += await read(full);
                } catch (err) {
                    throw new InstSpecError(
                        `cannot read {{file:${name}}}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
                break;
            }
            case "env": {
                const v = process.env[name];
                if (v === undefined)
                    throw new InstSpecError(
                        `environment variable ${name} is not set ({{env:${name}}})`,
                    );
                out += v;
                break;
            }
            case "cfg": {
                const v = cfgPath(cfg, name);
                if (v === undefined)
                    throw new InstSpecError(`config path "${name}" is not set ({{cfg:${name}}})`);
                out += String(v);
                break;
            }
        }
        last = idx + match[0].length;
    }
    return out + value.slice(last);
}

/** Follow `path.to.key` into a nested record; undefined on any missing step. */
function cfgPath(cfg: Record<string, unknown>, path: string): unknown {
    let cur: unknown = cfg;
    for (const part of path.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

async function resolveService(
    s: ServiceSpec,
    baseDir: InstallBaseDir,
    cfg: Record<string, unknown>,
    read: (path: string) => Promise<string>,
): Promise<ServiceSpec> {
    if (s.content && s.contentFile)
        throw new InstSpecError(
            `service ${s.name}: both content and contentFile are set (pick one)`,
        );
    if (s.contentFile) {
        const full = pathResolve(baseDir, s.contentFile);
        if (!isWithin(pathResolve(baseDir), full))
            throw new InstSpecError(
                `service ${s.name}: contentFile escapes the install directory`,
            );
        let fileContent: string;
        try {
            fileContent = await read(full);
        } catch (err) {
            throw new InstSpecError(
                `service ${s.name}: cannot read contentFile ${s.contentFile}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return { ...s, content: await resolvePlaceholdersIn(fileContent, baseDir, cfg, read) };
    }
    return { ...s, content: s.content ? await resolvePlaceholdersIn(s.content, baseDir, cfg, read) : s.content };
}

async function resolveUdev(
    u: UdevRule,
    baseDir: InstallBaseDir,
    cfg: Record<string, unknown>,
    read: (path: string) => Promise<string>,
): Promise<UdevRule> {
    if (u.content && u.contentFile)
        throw new InstSpecError(`udev ${u.file}: both content and contentFile are set (pick one)`);
    if (u.contentFile) {
        const full = pathResolve(baseDir, u.contentFile);
        if (!isWithin(pathResolve(baseDir), full))
            throw new InstSpecError(`udev ${u.file}: contentFile escapes the install directory`);
        let fileContent: string;
        try {
            fileContent = await read(full);
        } catch (err) {
            throw new InstSpecError(
                `udev ${u.file}: cannot read contentFile ${u.contentFile}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return { ...u, content: await resolvePlaceholdersIn(fileContent, baseDir, cfg, read) };
    }
    return { ...u, content: u.content ? await resolvePlaceholdersIn(u.content, baseDir, cfg, read) : u.content };
}

/**
 * Resolve every placeholder in a merged spec. Returns a new spec; strings
 * without placeholders pass through untouched. `cfg` is the role's runtime
 * config (the whole config file's top level).
 */
export async function resolveSpec(
    spec: ModuleInstallSpec,
    baseDir: InstallBaseDir,
    cfg: Record<string, unknown>,
    read: (path: string) => Promise<string> = readFile,
): Promise<ModuleInstallSpec> {
    const out: ModuleInstallSpec = { ...spec };
    if (spec.services?.length)
        out.services = await Promise.all(
            spec.services.map((s) => resolveService(s, baseDir, cfg, read)),
        );
    if (spec.firewall?.length)
        out.firewall = await Promise.all(
            spec.firewall.map(async (r) => ({
                ...r,
                rule: await resolvePlaceholdersIn(r.rule, baseDir, cfg, read),
            })),
        );
    if (spec.udev?.length)
        out.udev = await Promise.all(
            spec.udev.map((u) => resolveUdev(u, baseDir, cfg, read)),
        );
    return out;
}
