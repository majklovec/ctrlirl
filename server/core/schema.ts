/*
 * The Drizzle schema for the control server's SQLite database.
 *
 * This file is a TYPE-LEVEL description of the schema the numbered
 * `.sql` migrations in `server/core/migrations/` build up (see db.ts) —
 * the migrations stay the source of truth for the on-disk structure and
 * this file drives the typed queries. Keep the two in lockstep: every
 * column change lands as a new migration file AND a schema edit here.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    login: text("login").notNull().unique(),
    password: text("password").notNull(),
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
        .notNull()
        .default(sql`(CURRENT_TIMESTAMP)`),
});

export const projects = sqliteTable("projects", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerId: integer("owner_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    /** The auto-created per-user "Personal" project (migration 0012). */
    isPersonal: integer("is_personal", { mode: "boolean" })
        .notNull()
        .default(false),
    /** The project's persistent token (migration 0014): authenticates the
     * overlay runtime URLs and device connections to it. */
    token: text("token")
        .notNull()
        .default(sql`(lower(hex(randomblob(24))))`),
    createdAt: text("created_at")
        .notNull()
        .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at")
        .notNull()
        .default(sql`(CURRENT_TIMESTAMP)`),
});

/** A project member's role (`owner` row is fixed, one per project). */
export const projectMembers = sqliteTable(
    "project_members",
    {
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        userId: integer("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        role: text("role").notNull(),
        joinedAt: text("joined_at")
            .notNull()
            .default(sql`(CURRENT_TIMESTAMP)`),
    },
    (t) => [index("project_members_user").on(t.userId)],
);

/** Single-use, expiring project invite links. */
export const projectInvites = sqliteTable(
    "project_invites",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        token: text("token").notNull().unique(),
        role: text("role").notNull(),
        createdBy: integer("created_by").references(() => users.id, {
            onDelete: "set null",
        }),
        createdAt: text("created_at")
            .notNull()
            .default(sql`(CURRENT_TIMESTAMP)`),
        expiresAt: text("expires_at"),
        usedBy: integer("used_by").references(() => users.id, {
            onDelete: "set null",
        }),
        usedAt: text("used_at"),
    },
    (t) => [index("project_invites_project").on(t.projectId)],
);

/** Device tokens: authenticate one device, bound to a project + user. */
export const tokens = sqliteTable(
    "tokens",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        userId: integer("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        token: text("token").notNull().unique(),
        projectId: text("project_id").references(() => projects.id, {
            onDelete: "cascade",
        }),
        createdAt: text("created_at")
            .notNull()
            .default(sql`(CURRENT_TIMESTAMP)`),
    },
    (t) => [index("tokens_project").on(t.projectId)],
);

/** Single-use registration invitation codes (after the first account). */
export const invitations = sqliteTable("invitations", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    createdBy: integer("created_by").references(() => users.id, {
        onDelete: "set null",
    }),
    createdAt: text("created_at")
        .notNull()
        .default(sql`(CURRENT_TIMESTAMP)`),
    usedBy: integer("used_by").references(() => users.id, {
        onDelete: "set null",
    }),
    usedAt: text("used_at"),
    expiresAt: text("expires_at"),
});

/** Dashboard rows (the whole widget grid is a JSON blob). */
export const dashboards = sqliteTable(
    "dashboards",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id").references(() => projects.id, {
            onDelete: "cascade",
        }),
        name: text("name").notNull(),
        color: text("color"),
        version: integer("version").notNull().default(1),
        // `columns` is not a SQLite keyword — no quoting needed in SQL
        columns: integer("columns").notNull().default(12),
        widgets: text("widgets").notNull().default("[]"),
        position: integer("position").notNull().default(0),
        createdAt: text("created_at")
            .notNull()
            .default(sql`(CURRENT_TIMESTAMP)`),
    },
    (t) => [index("dashboards_project").on(t.projectId)],
);

/** One row per OBS overlay (the whole overlay is a JSON blob). */
export const overlays = sqliteTable(
    "overlays",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id").references(() => projects.id, {
            onDelete: "cascade",
        }),
        schemaVersion: integer("schema_version").notNull().default(1),
        data: text("data").notNull(),
        updatedAt: integer("updated_at").notNull().default(0),
    },
    (t) => [index("overlays_project").on(t.projectId)],
);

/** The per-project asset folder tree (a single "Root" folder per project). */
export const assetFolders = sqliteTable(
    "asset_folders",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id").references(() => projects.id, {
            onDelete: "cascade",
        }),
        parentId: text("parent_id"),
        name: text("name").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (t) => [
        index("asset_folders_project_parent").on(t.projectId, t.parentId),
    ],
);

/** Asset file metadata (the bytes live on disk in the storage dir). */
export const assetFiles = sqliteTable(
    "asset_files",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id").references(() => projects.id, {
            onDelete: "cascade",
        }),
        folderId: text("folder_id").notNull(),
        name: text("name").notNull(),
        size: integer("size").notNull(),
        mimeType: text("mime_type").notNull(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (t) => [
        index("asset_files_project_folder").on(t.projectId, t.folderId),
    ],
);

/** Live-map route history: the routes of one overlay's keep_history map. */
export const mapPaths = sqliteTable(
    "map_paths",
    {
        id: text("id").primaryKey(),
        overlayId: text("overlay_id").notNull(),
        name: text("name").notNull(),
        startedAt: integer("started_at").notNull(),
        endedAt: integer("ended_at"),
    },
    (t) => [index("map_paths_overlay").on(t.overlayId, t.startedAt)],
);

/** The recorded GPS points of the live-map routes. */
export const mapPoints = sqliteTable(
    "map_points",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        overlayId: text("overlay_id").notNull(),
        pathId: text("path_id").notNull(),
        lat: real("lat").notNull(),
        lon: real("lon").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (t) => [index("map_points_overlay").on(t.overlayId, t.recordedAt)],
);

/** The migration runner's applied-file tracker (see db.ts). */
export const schemaMigrations = sqliteTable("schema_migrations", {
    name: text("name").primaryKey(),
    appliedAt: text("applied_at")
        .notNull()
        .default(sql`(CURRENT_TIMESTAMP)`),
});
