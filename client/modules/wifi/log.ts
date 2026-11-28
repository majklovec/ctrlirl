/** Log wording of the wifi module's methods (registered by both the backend and the frontend). */
import {
	type LogWording,
	logTranslate,
	wording,
} from "../../../shared/log_messages";

const log: LogWording = {
	methods: {
		"wifi.connect": wording("WiFi", "Connect", (p) =>
			logTranslate("mlog.done.wifi_connected", { ssid: p.ssid }),
		),
		"wifi.disconnect": wording(
			"WiFi",
			"Disconnect",
			"mlog.done.wifi_disconnected",
		),
		"wifi.scan": wording("WiFi", "Scan", "mlog.done.wifi_scan"),
	},
	sections: { wifi: "WiFi" },
	labels: { WiFi: "set.wifi" },
};

export default log;
