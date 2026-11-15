import type { RoleDefinition } from "../../../shared/contracts/roles";

/** The `ctrlink_relay` role — bridges the LAN to the encoder (transparent IP forwarding). */
const role: RoleDefinition = {
    id: "ctrlink_relay",
    titleKey: "role.ctrlink_relay",
    taglineKey: "setup.role.ctrlink_relay_tag",
    order: 20,
    setupSelectable: true,
    requires: {
        modules: ["network", "modems", "speedtest", "systeminfo"],
        optionalModules: ["ctrlink_relay", "obs"],
        capabilities: [
            "modems.source",
            "network.interfaces",
            "network.uplinks",
        ],
    },
    provides: {
        capabilities: [
            "modems.source",
            "network.ctrlink",
            "network.interfaces",
            "network.uplinks",
        ],
    },
};

export default role;
