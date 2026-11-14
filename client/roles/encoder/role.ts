import type { RoleDefinition } from "../../../shared/contracts/roles";

/** The `encoder` role — captures video and sends it over SRT. */
const role: RoleDefinition = {
    id: "encoder",
    titleKey: "role.encoder",
    taglineKey: "setup.role.encoder_tag",
    order: 20,
    setupSelectable: true,
    requires: {
        modules: [
            "encoder",
            "ctrlink_streamer",
            "network",
            "modems",
            "ssh",
            "speedtest",
            "systeminfo",
        ],
        optionalModules: ["obs"],
        capabilities: ["network.uplinks", "network.ctrlink", "modems.source"],
    },
    provides: {
        capabilities: [
            "network.uplinks",
            "network.interfaces",
            "network.ctrlink",
            "modems.source",
        ],
    },
};

export default role;
