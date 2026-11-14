/** Log wording of the ctrlink_streamer module's methods (the backend registers it). */
import { type LogWording, wording } from "../../../shared/log_messages";

const log: LogWording = {
	methods: {
		"ctrlink_streamer.options": wording(
			"Relay tunnels",
			"Options update",
			"mlog.done.generic",
		),
	},
	sections: {
		"Relay tunnels": "Relay tunnels",
		Tunnel: "Tunnel",
		Uplink: "Uplink",
	},
	labels: {
		"Relay tunnels": "dev.card.ctrlink_streamer",
		Tunnel: "dev.mstream.tunnel",
		Uplink: "dev.mstream.uplink",
	},
};

export default log;
