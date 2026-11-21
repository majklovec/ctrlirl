/* Event log: device entries arrive via `log` events (persisted on the device; the control
 * server adds its own online / offline ones); browser entries (connection, request failures)
 * live in this page only. */
import m from "mithril";
import {
	LOG_MAX,
	type LogEntry,
	type LogEvent,
	label,
} from "../../log_messages";
import { Card, IconButton } from "../components";
import { confirmDialog } from "../components/confirm";
import { Icon, type Level } from "../components/icons";
import { t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";

const LEVEL_KEY: Record<Level, string> = {
	info: "log.level.info",
	warn: "log.level.warning",
	error: "log.level.error",
};

const rows = new Map<string, LogEntry>();
const keyOf = (e: LogEntry) => `${e.origin ?? "device"}:${e.id}`;
let nextLocalId = 1;

export function applyLog(data: LogEvent): void {
	if (data.cleared) {
		rows.clear();
	} else if (data.reset) {
		for (const [key, e] of rows) if (e.origin !== "browser") rows.delete(key);
	}
	for (const e of data.entries) rows.set(keyOf(e), e);
	m.redraw();
}

export interface LogCardProps {
	clear: () => Promise<unknown>;
}

let clearing = false;

async function clearLog(clear: () => Promise<unknown>): Promise<void> {
	if (clearing) return;
	if (
		!(await confirmDialog(t("dev.log.clear_confirm"), {
			okLabel: t("mlog.action.delete"),
			danger: true,
		}))
	)
		return;
	clearing = true;
	m.redraw();
	try {
		const result = await clear();
		if (result !== undefined) {
			rows.clear();
			m.redraw();
		}
	} finally {
		clearing = false;
		m.redraw();
	}
}

/** Browser-side entry; a repeat of the newest entry bumps its counter instead. */
export function log(level: Level, section: string, message: string): void {
	const at = Date.now();
	const newest = [...rows.values()].reduce<LogEntry | undefined>(
		(n, e) => (!n || e.at >= n.at ? e : n),
		undefined,
	);
	if (
		newest?.origin === "browser" &&
		newest.level === level &&
		newest.section === section &&
		newest.message === message
	) {
		newest.count = (newest.count ?? 1) + 1;
		newest.at = at;
	} else {
		const entry: LogEntry = {
			id: nextLocalId++,
			origin: "browser",
			at,
			level,
			section,
			message,
		};
		rows.set(keyOf(entry), entry);
	}
	m.redraw();
}

/** Newest first, trimmed to LOG_MAX. */
function sorted(): LogEntry[] {
	const list = [...rows.values()].sort((a, b) => b.at - a.at || b.id - a.id);
	for (const old of list.splice(LOG_MAX)) rows.delete(keyOf(old));
	return list;
}

function time(at: number): m.Vnode {
	const date = new Date(at);
	const today = date.toDateString() === new Date().toDateString();
	return (
		<time datetime={date.toISOString()} title={date.toLocaleString()}>
			{today ? date.toLocaleTimeString() : date.toLocaleString()}
		</time>
	);
}

const LogCardComponent: m.Component<LogCardProps> = {
	view: ({ attrs: { clear } }) => {
		const entries = sorted();
		return (
			<Card
				title={t("dev.card.log")}
				class="log-card"
				headActions={
					<IconButton
						danger
						class="log-clear"
						label={t("dev.log.clear")}
						icon={<Icon name="delete" class="role-icon" />}
						disabled={clearing || entries.length === 0}
						onclick={() => void clearLog(clear)}
					/>
				}
			>
				<code id="log">
					{entries.map((e) => (
						<li key={keyOf(e)} class={`log-${e.level}`}>
							<Icon name={e.level} class="role-icon log-icon" />
							{time(e.at)}
							<span class="log-level">{t(LEVEL_KEY[e.level])}</span>
							<span class="log-section">{label(e.section)}</span>
							<span class="log-message">{e.message}</span>
							<span class="log-count">
								{(e.count ?? 1) > 1 ? `×${e.count}` : null}
							</span>
						</li>
					))}
				</code>
			</Card>
		);
	},
};

export const LogCard =
	LogCardComponent as MithrilJSXComponent<LogCardProps>;
