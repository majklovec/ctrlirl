// The `obs` role pictogram, rendered by the core's role tags, the setup
// wizard and the device list.
import { OutlineIcon } from "@ui/components/icons";
// biome-ignore lint/correctness/noUnusedImports: the JSX factory (tsconfig jsxFactory "m")
import m from "mithril";

const obsIcon = () => (
	<OutlineIcon class="role-icon role-icon-obs">
		<rect x="2" y="3" width="20" height="14" rx="2" />
		<path d="m9 7 5 3.5L9 14z" />
		<path d="M8 21h8M12 17v4" />
	</OutlineIcon>
);

export default obsIcon;
