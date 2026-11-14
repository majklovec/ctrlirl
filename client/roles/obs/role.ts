import type { RoleDefinition } from "../../../shared/contracts/roles";

/** The `obs` role — controls OBS Studio. */
const role: RoleDefinition = {
    id: "obs",
    titleKey: "role.obs",
    taglineKey: "setup.role.obs_tag",
    order: 40,
    setupSelectable: true,
    requires: {
        modules: ["obs", "speedtest", "systeminfo"],
        capabilities: [],
    },
    provides: {
        capabilities: [],
    },
};

export default role;
