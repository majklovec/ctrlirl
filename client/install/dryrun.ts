/*
 * Render a resolved install/uninstall plan without touching the host
 * (handoff §15). Each provider contributes `DryArtifact`s via its `dryRun`
 * method; this formats them in the fixed step order.
 */
import type { InstallPlan, InstallState } from "../../shared/install/types";
import { loadState } from "./state";
import { stateRoot } from "./state";
import { makeCtx } from "./ctx";
import type { InstallProvider, ModuleCtx, ProviderOpts, DryArtifact } from "./provider";
import {
    DRY_ORDER,
    type DryGroup,
} from "./dryOrder";

export interface DryRunOpts {
    providers: InstallProvider[];
    cfg: Record<string, unknown>;
    root?: string;
}

/** Render the per-module plan to the exact handoff §15 shape. */
export async function renderDryRun(
    plan: InstallPlan,
    mode: "install" | "uninstall",
    opts: DryRunOpts,
): Promise<string> {
    const state = await loadState(plan.role);
    const baseOpts: ProviderOpts = {
        installDir: "",
        installDeps: false,
        purge: false,
        root: opts.root ?? stateRoot(),
    };
    const out: string[] = [`role ${plan.role} · board ${plan.board}`];
    for (const mod of plan.ordered) {
        const ctx = makeCtx(plan.role, mod.name, mod.spec, state, {
            ...baseOpts,
            installDir: mod.installDir ?? "",
        });
        // Collect artifacts grouped by provider, in the canonical order.
        const groups: DryGroup[] = [];
        for (const provider of opts.providers) {
            const artifacts = await provider.dryRun(mode, ctx);
            if (artifacts.length)
                groups.push({ provider: provider.name, artifacts });
        }
        groups.sort((a, b) => DRY_ORDER.indexOf(a.provider) - DRY_ORDER.indexOf(b.provider));
        out.push(`[${mod.name}] ${mode}`);
        for (const group of groups) {
            out.push(`  ${group.provider}:`);
            for (const a of group.artifacts)
                out.push(
                    `    ${a.mark} ${a.target}${a.detail ? `  (${a.detail})` : ""}`,
                );
        }
        if (!groups.length) out.push(`  (no install rules)`);
    }
    return out.join("\n");
}
