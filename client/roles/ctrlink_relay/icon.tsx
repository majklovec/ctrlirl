// The `ctrlink_relay` role pictogram, rendered by the core's role tags, the
// setup wizard and the device list.
import { OutlineIcon } from "@ui/components/icons";
// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";

const ctrlinkRelayIcon = () => (
	<OutlineIcon class="role-icon role-icon-ctrlink-relay">
		<circle cx="12" cy="12" r="2.5" />
		<circle cx="4.5" cy="5" r="2" />
		<circle cx="19.5" cy="5" r="2" />
		<circle cx="4.5" cy="19" r="2" />
		<circle cx="19.5" cy="19" r="2" />
		<path d="m9.9 10.1-3.4-3.2M14.1 10.1l3.4-3.2M9.9 13.9l-3.4 3.2M14.1 13.9l3.4 3.2" />
	</OutlineIcon>
);

export default ctrlinkRelayIcon;
