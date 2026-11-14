// The `relay` role pictogram, rendered by the core's role tags, the setup
// wizard and the device list (no role id is drawn in core code).
import { OutlineIcon } from "@ui/components/icons";
// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";

const relayIcon = () => (
	<OutlineIcon class="role-icon role-icon-relay">
		<circle cx="12" cy="9" r="2" />
		<path d="M12 11v11M9 22h6" />
		<path d="M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7" />
		<path d="M5.6 2.6a9 9 0 0 0 0 12.8M18.4 2.6a9 9 0 0 1 0 12.8" />
	</OutlineIcon>
);

export default relayIcon;
