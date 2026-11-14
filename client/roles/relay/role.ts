import type { RoleDefinition } from "../../../shared/contracts/roles";

/**
 * The `relay` role — receives streams and forwards them with SRTLA.
 *
 * A role owns the knowledge of which modules run on it and which capabilities
 * those modules consume and register; the modules never name a role.
 * `requires.modules` are enabled by default, `optionalModules` start disabled;
 * `requires.capabilities` is the union of the `services.consumes` of every
 * module the role runs, `provides.capabilities` the union of the capabilities
 * its modules register. `shared/registry.ts` validates both against the module
 * registrations at load.
 */
const role: RoleDefinition = {
    id: "relay",
    titleKey: "role.relay",
    taglineKey: "setup.role.relay_tag",
    order: 10,
    default: true,
    setupSelectable: true,
    requires: {
        modules: [
            "relay",
            "network",
            "modems",
            "ssh",
            "speedtest",
            "systeminfo",
        ],
        optionalModules: ["obs"],
        capabilities: ["network.uplinks", "modems.source"],
    },
    provides: {
        capabilities: [
            "stream.relay",
            "network.uplinks",
            "network.interfaces",
            "network.ctrlink",
            "modems.source",
        ],
    },
};

export default role;
