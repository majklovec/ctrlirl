/*
 * Install/uninstall rules for device modules — the shared, host-agnostic
 * data model. These types are plain data: nothing in this folder mutates the
 * host (that is `client/install`), so the control server can read the specs
 * for previews too.
 *
 * A module declares its rules in `client/modules/<id>/install/install.json`
 * (plus an optional `install.<role>.json` for role-scoped deltas). The
 * installer loads, merges and resolves them per role, then applies them
 * through named providers (systemd, sysctl, firewall, udev, overlay,
 * packages, hooks). Every write is tagged and recorded in a per-role state
 * file so uninstall is exact.
 */

/** The only supported spec version. Bump on a breaking schema change. */
export const INSTALL_SPEC_VERSION = 1 as const;

/** What the module needs present before install can succeed (package names). */
export type DependencyList = readonly string[];

/**
 * One systemd unit the module wants installed.
 *
 * `content` (inline unit text) and `contentFile` (a path relative to the
 * module's `install/` directory) are mutually exclusive; `contentFile` is
 * preferred for readability of long units. The installer inlines the file at
 * resolve time, so the *resolved* spec always has `content` set.
 */
export interface ServiceSpec {
    name: string;
    unit: "systemd";
    content?: string;
    contentFile?: string;
    /** Enable the unit at boot. Default true. */
    enabled?: boolean;
    /** Start the unit during install (enable --now). Default true. */
    started?: boolean;
}

/**
 * One firewall rule. `tool: "nft"` (the default table is `inet`) installs the
 * module's rules into the module-owned table `ctrlirl_<role>_<module>`;
 * `tool: "iptables"` tags each rule with a comment so uninstall can delete
 * exactly those rules.
 */
export interface FirewallRule {
    tool: "nft" | "iptables";
    /** nft: table family (default `inet`). iptables: table name (default `filter`). */
    table?: string;
    chain: string;
    rule: string;
    /** iptables: the comment used to tag the rule (required for iptables). */
    comment?: string;
    /** nft only: address family. Default `inet`. */
    family?: "inet" | "ip" | "ip6";
}

/** One udev rule file. The basename must match `^\d{2}-ctrlirl-.+\.rules$`. */
export interface UdevRule {
    file: string;
    content?: string;
    contentFile?: string;
    /** Optional targeted re-trigger after the rules are written. */
    trigger?: {
        subsystem?: string;
        attrMatch?: string;
        action?: "change" | "add";
    };
}

/**
 * Filesystem overlay: the module's `install/overlay/` tree mirrors the
 * destination root (default `/`; tests override it via `CTRLIRL_ROOT_OVERRIDE`).
 */
export interface OverlaySpec {
    /** Relative paths (under `overlay/`) to leave in place with a warning if the destination was modified by the operator. */
    preserve?: string[];
    /** Commands run after install/uninstall, only if the overlay actually wrote or removed something. */
    reload?: string[];
    /** Explicit opt-in to writing protected paths (see the installer's protected list). */
    allowProtected?: string[];
}

/** A script path, or a script path followed by literal command-line arguments. */
export type HookCommand = string | [script: string, ...args: string[]];

export interface ModuleInstallSpec {
    version: 1;
    /** Package names to check (dpkg). Checked, not installed, unless `--install-deps`. */
    dependencies?: string[];
    /** Informational capabilities the role expects from this module. */
    capabilities?: { ambient?: string[] };
    services?: ServiceSpec[];
    /** `key = value` lines written to `/etc/sysctl.d/90-ctrlirl-<module>.conf`. */
    sysctl?: Record<string, number | string>;
    firewall?: FirewallRule[];
    udev?: UdevRule[];
    /** Presence of the module's `install/overlay/` directory is the real signal; this object carries controls only. */
    overlay?: OverlaySpec;
    /** Shell hooks, relative to `install/`; array elements after the path are arguments. */
    hooks?: { install?: HookCommand; uninstall?: HookCommand };
}

/** What the installer recorded in the per-role state file for one module. */
export interface ModuleInstallState {
    services: Array<{
        name: string;
        path: string;
        enabled: boolean;
        started: boolean;
    }>;
    /** key -> previous value (null = the key was not set before install). */
    sysctl: Record<string, { prev: string | null }>;
    firewall: { type: "nft"; table: string } | { type: "iptables"; comments: string[] };
    udevFiles: string[];
    overlayFiles: string[];
    /** Directories the overlay created, pruned on uninstall. */
    overlayDirs: string[];
    packagesAdded: string[];
    hooksRun: string[];
}

/** The per-role state file: `/var/lib/ctrlirl/installed/<role>.json`. */
export interface InstallState {
    role: string;
    /** Board the state was installed for. Absent in older state files. */
    board?: string;
    updatedAt: string;
    modules: Record<string, ModuleInstallState>;
}

/** One module's resolved spec plus its position in the plan. */
export interface ModulePlan {
    /** The module id, or `__role__` for the role-level (synthetic) spec. */
    name: string;
    spec: ModuleInstallSpec;
    /** `install/` directory of the module (absent for the synthetic role entry). */
    installDir?: string;
}

/** The fully resolved, ordered plan for one role. */
export interface InstallPlan {
    role: string;
    /** The board this plan was resolved for (per-board deltas were applied). */
    board: string;
    /** Ordered for installation; uninstall runs the exact reverse. */
    ordered: ModulePlan[];
}
