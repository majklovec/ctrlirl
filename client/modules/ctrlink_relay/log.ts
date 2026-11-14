/** Log wording of the ctrlink_relay module's methods (the backend registers it). */
import { type LogWording, wording } from "../../../shared/log_messages";

const log: LogWording = {
	methods: {
		"ctrlink_relay.start": wording("Relay", "Start", "mlog.done.started"),
		"ctrlink_relay.stop": wording("Relay", "Stop", "mlog.done.stopped"),
		"ctrlink_relay.reload": wording("Relay", "Reload", "mlog.done.reloaded"),
		"ctrlink_relay.options": wording(
			"Relay",
			"Options update",
			"mlog.done.generic",
		),
	},
	sections: {
		Relay: "Relay",
		Tunnel: "Tunnel",
		Uplink: "Uplink",
	},
	labels: {
		Relay: "dev.card.ctrlink_relay",
		Tunnel: "dev.ctrlink.tunnel",
		Uplink: "dev.ctrlink.uplink",
	},
};

export default log;
