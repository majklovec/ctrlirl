/*
 * The web UI's Modules panel — the post-setup enable/disable/edit path (the
 * rev. 2 deliverable). A single Card listing every module the active role
 * serves (required + optional), each with an enable toggle, a dependency
 * preflight dot, and an Edit button that opens a schema-driven config form
 * built from the module's `configFields` (via `modules.info`).
 *
 * Secrets are write-only: the stored secret never comes back (the device
 * masks it as `configured`), so the form starts empty and a blank password on
 * save keeps the existing one. Nothing here names a module — every row is
 * driven by the `modules.info` payload.
 */
import "./module_panel.css";
import { Badge, Button, Card, DynamicForm, Modal } from "@ui/components/";
import { t } from "@ui/i18n";
import type { RpcClient } from "@ui/services/rpc";
import m from "mithril";
import type {
	FieldSchema,
	FormSchema,
} from "../../shared/ui/components/dynamic_form";
import {
	type ModuleInfoField,
	type ModuleInfoView,
} from "../../shared/contracts/wire";
import { errorMessage } from "../../shared/util";

const panelState = {
	rpc: undefined as RpcClient | undefined,
	infos: [] as ModuleInfoView[],
	loaded: false,
	editing: null as ModuleInfoView | null,
	draft: {} as Record<string, unknown>,
	message: "",
	saving: false,
};

export function bindPanel(rpc: RpcClient): void {
	panelState.rpc = rpc;
}

/** Fetch `modules.info` (role rows + fields + dependency preflight). */
async function loadPanel(): Promise<void> {
	const rpc = panelState.rpc;
	if (rpc === undefined) return;
	try {
		const res = await rpc.call<{ modules: ModuleInfoView[] }>("modules.info");
		panelState.infos = res.modules ?? [];
		panelState.loaded = true;
	} catch {
		// The panel degrades to "not loaded"; the device card's retry covers the link flap.
	} finally {
		m.redraw();
	}
}

export { loadPanel };

const titleOf = (info: ModuleInfoView): string =>
	info.titleKey ? t(info.titleKey) : info.title;

const depsState = (info: ModuleInfoView): "ok" | "bad" | "na" =>
	info.deps === undefined ? "na" : info.deps.ok ? "ok" : "bad";

const depsTitle = (info: ModuleInfoView): string => {
	const st = depsState(info);
	if (st === "ok") return t("set.mod_deps_ok");
	if (st === "bad")
		return info.deps?.messageKey
			? t(info.deps.messageKey, info.deps.messageParams)
			: t("set.mod_deps_fail");
	return t("set.mod_deps_na");
};

function toFieldSchema(f: ModuleInfoField): FieldSchema {
	const base = { name: f.name, labelKey: f.labelKey };
	switch (f.type) {
		case "boolean":
			return { ...base, type: "checkbox" };
		case "select":
			return {
				...base,
				type: "select",
				options: (f.options ?? []).map(([value, labelKey]) => ({
					value,
					labelKey,
				})),
			};
		case "password":
			return {
				...base,
				type: "password",
				placeholderKey: f.configured ? "set.mod_secret_configured" : undefined,
			};
		case "number":
			return { ...base, type: "number", min: f.min, max: f.max, step: f.step };
		default:
			return { ...base, type: "text", placeholderKey: f.placeholderKey };
	}
}

/** Build a DynamicForm schema from a module's `modules.info` fields (shared by the settings panel and the setup wizard). */
export const schemaFor = (info: ModuleInfoView): FormSchema => ({
	fields: info.fields.map(toFieldSchema),
});

function openEdit(info: ModuleInfoView): void {
	const draft: Record<string, unknown> = {};
	for (const f of info.fields) {
		// Secrets start empty (the stored value is never echoed back); booleans
		// default off, everything else blank (the device keeps omitted values).
		draft[f.name] = f.type === "boolean" ? false : "";
	}
	panelState.editing = info;
	panelState.draft = draft;
	panelState.message = "";
	m.redraw();
}

function closeEdit(): void {
	panelState.editing = null;
	panelState.draft = {};
	panelState.saving = false;
	m.redraw();
}

/** Build the `modules.configure` payload from the draft: omit blank secrets (keep the stored one). */
function payloadFor(info: ModuleInfoView): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of info.fields) {
		const v = panelState.draft[f.name];
		if (f.type === "password" && (v === "" || v === undefined)) continue;
		if (v !== undefined && v !== "") out[f.name] = v;
	}
	return out;
}

async function saveEdit(): Promise<void> {
	const rpc = panelState.rpc;
	const info = panelState.editing;
	if (rpc === undefined || info === null) return;
	panelState.saving = true;
	panelState.message = "";
	m.redraw();
	try {
		await rpc.call("modules.configure", {
			id: info.id,
			config: payloadFor(info),
		});
		closeEdit();
		await loadPanel();
	} catch (error: unknown) {
		panelState.message = errorMessage(error);
		panelState.saving = false;
		m.redraw();
	}
}

async function toggle(info: ModuleInfoView): Promise<void> {
	const rpc = panelState.rpc;
	if (rpc === undefined) return;
	try {
		await rpc.call(info.enabled ? "modules.disable" : "modules.enable", {
			id: info.id,
		});
		await loadPanel();
	} catch {
		await loadPanel();
	}
}

function row(info: ModuleInfoView): m.Vnode {
	const st = depsState(info);
	return (
		<div class="mp-row" key={info.id}>
			<div class="mp-name">
				<span class="mp-title">{titleOf(info)}</span>
				<Badge
					text={info.required ? t("set.mod_required") : t("set.mod_optional")}
					kind={info.required ? "on" : ""}
				/>
			</div>
			<span
				class={`mp-dot mp-dot-${st}`}
				title={depsTitle(info)}
				role="img"
				aria-label={depsTitle(info)}
			/>
			{info.fields.length > 0 ? (
				<Button
					label={t("set.mod_edit")}
					onClick={() => openEdit(info)}
				/>
			) : (
				<span class="mp-spacer" />
			)}
			<label class="mp-toggle">
				<input
					type="checkbox"
					checked={info.enabled}
					disabled={panelState.saving}
					onchange={() => void toggle(info)}
				/>
				<span class="mp-toggle-label">
					{info.enabled ? t("set.mod_on") : t("set.mod_off")}
				</span>
			</label>
		</div>
	);
}

export function modulePanelCard(): m.Vnode {
	const infos = panelState.infos;
	const editing = panelState.editing;
	return (
		<Card key="modules" title={t("set.modules")}>
			<p class="muted">{t("set.modules_desc")}</p>
			{infos.length === 0 ? (
				<p class="muted">{t("set.mod_none")}</p>
			) : (
				<div class="mp-table">
					{infos.map(row)}
					{panelState.message !== "" && editing === null ? (
						<p class="muted mp-message" role="status">
							{panelState.message}
						</p>
					) : null}
				</div>
			)}
			{editing !== null ? (
				<Modal title={titleOf(editing)} onClose={closeEdit}>
					<DynamicForm
						schema={schemaFor(editing)}
						value={panelState.draft}
						onChange={(next) => {
							panelState.draft = next;
							m.redraw();
						}}
					/>
					{panelState.message !== "" ? (
						<p class="muted mp-message" role="status">
							{panelState.message}
						</p>
					) : null}
					<div class="mp-actions">
						<Button
							label={t("set.mod_save")}
							type="button"
							disabled={panelState.saving}
							onClick={() => void saveEdit()}
						/>
						<Button
							label={t("set.mod_cancel")}
							type="button"
							disabled={panelState.saving}
							onClick={closeEdit}
						/>
					</div>
				</Modal>
			) : null}
		</Card>
	);
}
