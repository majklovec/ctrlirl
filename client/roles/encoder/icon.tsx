// The `encoder` role pictogram, rendered by the core's role tags, the setup
// wizard and the device list.
import { OutlineIcon } from "@ui/components/icons";
// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";

const encoderIcon = () => (
	<OutlineIcon class="role-icon role-icon-encoder">
		<rect x="2" y="6" width="14" height="12" rx="2" />
		<path d="M16 10.5 22 7v10l-6-3.5z" />
	</OutlineIcon>
);

export default encoderIcon;
