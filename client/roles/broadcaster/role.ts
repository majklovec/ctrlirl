import type { RoleDefinition } from "../../../shared/contracts/roles";

/** The `broadcaster` role — broadcasts to RTMP destinations. */
const role: RoleDefinition = {
    id: "broadcaster",
    titleKey: "role.broadcaster",
    taglineKey: "setup.role.broadcaster_tag",
    order: 50,
    setupSelectable: true,
    requires: {
        modules: ["broadcaster", "speedtest", "systeminfo"],
        optionalModules: ["obs"],
        capabilities: [],
    },
    provides: {
        capabilities: [],
    },
};

export default role;
