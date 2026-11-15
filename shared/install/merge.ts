/*
 * Merge semantics for install specs: `install.json` (base) first, then
 * `install.<role>.json` (role) on top.
 *
 *  - arrays concatenate and dedupe: `services` by `name`, `firewall` by
 *    `(tool, table, chain, rule)`, `udev` by `file`, `dependencies` by value.
 *  - objects (`sysctl`, `capabilities`) shallow-merge; the role wins.
 *  - `overlay` arrays concatenate + dedupe; `hooks` — a role key overrides the
 *    base key wholesale (no blind merge).
 *  - `version` must match on both sides, else the merge throws.
 */
import type {
    FirewallRule,
    ModuleInstallSpec,
    ServiceSpec,
    UdevRule,
} from "./types";

/**
 * Concatenate+dedupe with **last-wins** semantics (the role side, appended
 * after the base side, overrides the base for the same identity key) while
 * preserving first-seen order. Identity is the dedupe `key`.
 */
const dedupe = <T>(items: T[], key: (item: T) => string): T[] => {
    const lastByKey = new Map<string, T>();
    const order: string[] = [];
    for (const item of items) {
        const k = key(item);
        if (!lastByKey.has(k)) order.push(k);
        lastByKey.set(k, item);
    }
    return order.map((k) => lastByKey.get(k) as T);
};

const firewallKey = (rule: FirewallRule): string =>
    `${rule.tool}\u0000${rule.table ?? ""}\u0000${rule.chain}\u0000${rule.rule}`;

/**
 * Merge a base spec with a role spec. Both are partial except `version`,
 * which is required on both (base is filled with `{ version: 1 }` by the
 * loader when only the role file exists). Returns a new object; inputs are
 * not mutated.
 */
export function mergeSpec(
    base: ModuleInstallSpec,
    role: Partial<ModuleInstallSpec> | null | undefined,
): ModuleInstallSpec {
    if (base.version !== 1)
        throw new InstSpecError(`unsupported spec version ${String(base.version)}`);
    if (role && role.version !== undefined && role.version !== base.version)
        throw new InstSpecError(
            `version mismatch: base ${base.version} vs role ${role.version}`,
        );
    const r = role ?? {};

    const services: ServiceSpec[] = dedupe(
        [...(base.services ?? []), ...(r.services ?? [])],
        (s) => s.name,
    );
    const firewall: FirewallRule[] = dedupe(
        [...(base.firewall ?? []), ...(r.firewall ?? [])],
        firewallKey,
    );
    const udev: UdevRule[] = dedupe([...(base.udev ?? []), ...(r.udev ?? [])], (u) => u.file);
    const dependencies: string[] = dedupe(
        [...(base.dependencies ?? []), ...(r.dependencies ?? [])],
        (d) => d,
    );
    // Role wins on plain-object fields.
    const sysctl = { ...(base.sysctl ?? {}), ...(r.sysctl ?? {}) };
    const capabilities = {
        ...(base.capabilities ?? {}),
        ...(r.capabilities ?? {}),
    };
    // hooks: the role's key, if present, replaces the base's; otherwise the
    // base's survives.
    const hooks =
        r.hooks || base.hooks
            ? {
                  install: r.hooks?.install ?? base.hooks?.install,
                  uninstall: r.hooks?.uninstall ?? base.hooks?.uninstall,
              }
            : undefined;

    return {
        version: 1,
        ...(dependencies.length ? { dependencies } : {}),
        ...(capabilities.ambient ? { capabilities } : {}),
        ...(services.length ? { services } : {}),
        ...(Object.keys(sysctl).length ? { sysctl } : {}),
        ...(firewall.length ? { firewall } : {}),
        ...(udev.length ? { udev } : {}),
        overlay: mergeOverlay(base.overlay, r.overlay),
        ...(hooks && (hooks.install || hooks.uninstall) ? { hooks } : {}),
    };
}

function mergeOverlay(
    base: ModuleInstallSpec["overlay"],
    role: ModuleInstallSpec["overlay"],
): ModuleInstallSpec["overlay"] {
    if (!base && !role) return undefined;
    const b = base ?? {};
    const r = role ?? {};
    const out: NonNullable<ModuleInstallSpec["overlay"]> = {};
    const preserve = dedupe([...(b.preserve ?? []), ...(r.preserve ?? [])], (p) => p);
    const reload = dedupe([...(b.reload ?? []), ...(r.reload ?? [])], (c) => c);
    const allowProtected = dedupe([...(b.allowProtected ?? []), ...(r.allowProtected ?? [])], (p) => p);
    if (preserve.length) out.preserve = preserve;
    if (reload.length) out.reload = reload;
    if (allowProtected.length) out.allowProtected = allowProtected;
    return Object.keys(out).length ? out : undefined;
}

/** Thrown by merge/validate for malformed specs (before any host mutation). */
export class InstSpecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InstSpecError";
    }
}
