/*
 * Build a provider `ModuleCtx` for one (role, module). Kept in its own file so
 * `dryrun.ts` and `installer.ts` share the exact same context shape.
 */
import type { InstallState, ModuleInstallSpec } from "../../shared/install/types";
import { emptyModuleState } from "./state";
import type { ModuleCtx, ProviderOpts } from "./provider";

export function makeCtx(
    role: string,
    module: string,
    spec: ModuleInstallSpec,
    state: InstallState,
    opts: ProviderOpts,
): ModuleCtx {
    return {
        spec,
        role,
        module,
        state: (state.modules[module] ??= emptyModuleState()),
        opts,
        transient: {},
    };
}
