// The `broadcaster` role pictogram, rendered by the core's role tags, the
// setup wizard and the device list.
import { OutlineIcon } from "@ui/components/icons";
// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";

const broadcasterIcon = () => (
	<OutlineIcon class="role-icon role-icon-broadcaster">
		<path d="M12 3v18" />
		<path d="m7 21 5-16 5 16" />
		<path d="M8.25 17h7.5" />
		<path d="M5.5 3a9.5 9.5 0 0 0 0 14" />
		<path d="M18.5 3a9.5 9.5 0 0 1 0 14" />
	</OutlineIcon>
);

export default broadcasterIcon;
