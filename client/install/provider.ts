/*
 * The provider contract between the installer orchestrator and the concrete
 * host-mutating providers (systemd, sysctl, firewall, udev, overlay,
 * packages, hooks). The orchestrator knows only this interface, which is what
 * makes it fully testable with a fake (no root, no host).
 *
 * A provider is a bundle of per-step handlers keyed by `StepKey`. The
 * orchestrator walks the fixed per-module step order (handoff §11) and calls
 * `run(step, ctx)` for every step the provider implements. Steps:
 *
 *   install:   packagesCheck → overlayInstall → udevInstall → sysctlInstall
 *              → firewallInstall → systemdInstall → overlayReload → hooksInstall
 *   uninstall: hooksUninstall → systemdUninstall → firewallUninstall
 *              → sysctlUninstall → udevUninstall → overlayUninstall
 *              → packagesPurge
 *
 * Providers must be idempotent and only touch their own `(role, module)`
 * state slice; the orchestrator owns the surrounding state file.
 */
import type {
    ModuleInstallSpec,
    ModuleInstallState,
} from "../../shared/install/types";

/** An artifact a provider reports in a dry run (one line in the plan). */
export interface DryArtifact {
    /** `+` write/create, `~` skip (unchanged), `-` remove, `*` run. */
    mark: "+" | "~" | "-" | "*";
    /** Absolute path on the host (file providers), or a command (reload/hook). */
    target: string;
    /** Optional detail, e.g. `write, 3 rules` or `protected, allowed by opt-in`. */
    detail?: string;
}

/** What a single provider step returned. */
export interface ProviderResult {
    /** True if this step changed (or would change) a file/rule. */
    changed: boolean;
    /** Human-readable log lines. */
    lines: string[];
}

/** One provider action's full context. */
export interface ModuleCtx {
    spec: ModuleInstallSpec;
    role: string;
    module: string;
    /** The state slice for this `(role, module)`, mutated in place by providers. */
    state: ModuleInstallState;
    opts: ProviderOpts;
    /**
     * Per-run, non-serialized scratch space (fresh for each module run).
     * Lets a step record that it wrote something so a later step in the same
     * run (e.g. `overlayReload`) can react. Never persisted to the state file.
     */
    transient: Record<string, unknown>;
}

/** The steps a provider may implement, in the order they run. */
export type StepKey =
    | "packagesCheck"
    | "overlayInstall"
    | "udevInstall"
    | "sysctlInstall"
    | "firewallInstall"
    | "systemdInstall"
    | "overlayReload"
    | "hooksInstall"
    | "hooksUninstall"
    | "systemdUninstall"
    | "firewallUninstall"
    | "sysctlUninstall"
    | "udevUninstall"
    | "overlayUninstall"
    | "packagesPurge";

/** Options the CLI derives and threads through to every provider step. */
export interface ProviderOpts {
    /** The module's `install/` directory (hooks, file reads). May be empty. */
    installDir: string;
    /** `--install-deps`: apt-install missing packages. Default false. */
    installDeps: boolean;
    /** `--purge`: remove newly-added packages on uninstall. Default false. */
    purge: boolean;
    /** `CTRLIRL_ROOT_OVERRIDE`: the destination root for tests (default `/`). */
    root: string;
    /**
     * Set when this step is a rollback of a partially-applied install, so a
     * reverse step (e.g. `packagesPurge`) undoes exactly what the forward pass
     * did in *this* run, independent of the `--purge` flag.
     */
    rollback?: boolean;
}

/**
 * One provider. `run` handles the named step; `dryRun` renders a mutation-free
 * plan. Providers that don't implement a step should not list it in `steps`.
 */
export interface InstallProvider {
    name: string;
    /** The step keys this provider implements. The orchestrator only calls these. */
    steps: readonly StepKey[];
    run(step: StepKey, ctx: ModuleCtx): Promise<ProviderResult>;
    /** Dry-run a full install or uninstall of this module (no host mutation). */
    dryRun(mode: "install" | "uninstall", ctx: ModuleCtx): Promise<DryArtifact[]>;
}
