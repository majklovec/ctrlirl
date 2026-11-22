/*
 * Projects store (TODO/01-projects.md): users, memberships with roles
 * (owner / editor / viewer) and the single-use, expiring invite links that
 * grow a project beyond its owner.
 *
 * The store is the single authority on authorization: every method takes
 * the acting user and re-checks the role in the database, so a handler
 * cannot forget a guard. All mutations run in one SQLite transaction —
 * the (project_id, user_id) primary key plus the owner invariants make a
 * project always have exactly one owner.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../../../core/db";
import {
    projectInvites,
    projectMembers,
    projects as projectsTable,
    tokens,
    users,
} from "../../../core/schema";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../../../../shared/params";
import { LOCAL_PROJECT_ID } from "../../../core/runtime";

export type ProjectRole = "owner" | "editor" | "viewer";
/** The roles an invite link can grant (never `owner`). */
export type InviteRole = "editor" | "viewer";

export interface ProjectSummary {
    id: string;
    name: string;
    /** The calling user's role in the project. */
    role: ProjectRole;
}

export interface ProjectMember {
    userId: number;
    login: string;
    role: ProjectRole;
}

/** A device token bound to a project — authenticates one device. */
export interface DeviceToken {
    id: number;
    /** The full token value — the only place it is ever returned. */
    token: string;
    createdAt: string;
}

export interface ProjectInvite {
    id: string;
    role: InviteRole;
    /** The full URL the link was created for (`<origin>/projects/join/<token>`). */
    url: string;
    createdAt: string;
    /** `null` = no expiry. */
    expiresAt: string | null;
    /** The login of the user who consumed the link, when used. */
    usedBy: string | null;
}

interface MemberRow {
    user_id: number;
    login: string;
    role: ProjectRole;
}

interface InviteRow {
    id: string;
    token: string;
    role: InviteRole;
    created_at: string;
    expires_at: string | null;
    used_by: string | null;
}

interface JoinInviteRow {
    id: string;
    project_id: string;
    role: InviteRole;
    expires_at: string | null;
    used_by: number | null;
    name: string;
}

const INVITE_ROLES: readonly InviteRole[] = ["editor", "viewer"];
/** An invite's default lifetime: 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX = 64;

/** No user database (`--no-auth` mode): projects do not exist there. */
function noDb(): never {
    throw new ApiError("Projects require account authentication", 503);
}

function parseName(raw: unknown): string {
    if (typeof raw !== "string") throw new ApiError("name is required");
    const name = raw.trim();
    if (name.length === 0 || name.length > NAME_MAX)
        throw new ApiError(`name must be 1-${NAME_MAX} characters`);
    return name;
}

/** `InviteRow` → API shape (the URL is rebuilt for the request's origin). */
function inviteOf(row: InviteRow, origin: string): ProjectInvite {
    return {
        id: row.id,
        role: row.role,
        url: `${origin}/projects/join/${row.token}`,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedBy: row.used_by,
    };
}

export interface Projects {
    /** Every project the user is a member of, newest first. */
    list(user: string): ProjectSummary[];
    /** The user's role in the project, `null` when not a member. */
    role(user: string, projectId: string): ProjectRole | null;
    /**
     * The user's role in the project, throwing `ApiError` (404 for a missing
     * project / non-member, 403 for an insufficient role). The guard entity
     * routes run (via `ProjectAccess`) before dispatching to a store.
     */
    requireRole(
        actor: string,
        projectId: string,
        allowed: readonly ProjectRole[],
    ): ProjectRole;
    /**
     * The default project id for a user's project-scoped request when no
     * `?project=` override is given: the user's earliest project as a member
     * (for pre-existing accounts, migration 0012's seeded `personal-<user id>`
     * is the earliest and wins the tie-break). Not auto-created — it throws a
     * 404 `ApiError` when the user has no projects, so such requests 404 (the
     * UI then prompts them to create a project) instead of materialising one.
     */
    personalProjectId(user: string): string;
    /** Create a project; the creator becomes its sole owner. `name` is validated. */
    create(user: string, name: unknown): ProjectSummary;
    /** Rename (owner / editor). `name` is validated. */
    rename(actor: string, projectId: string, name: unknown): ProjectSummary;
    /** Delete (owner); cascades to members and invites and device tokens. */
    remove(actor: string, projectId: string): void;
    /**
     * The project's device tokens, oldest first (any member). Each row carries
     * the full token value.
     */
    listTokens(actor: string, projectId: string): DeviceToken[];
    /**
     * Create a device token (owner/editor). Returns the row; `token` is the
     * value to present to the device.
     */
    createToken(actor: string, projectId: string): DeviceToken;
    /** Delete a device token (owner/editor); 404 for a missing or foreign id. */
    removeToken(actor: string, projectId: string, tokenId: string): void;
    /** The project's members, owner first, then join order (404 on a missing project). */
    members(projectId: string): ProjectMember[];
    /** Change a member's role (owner; the owner row is fixed). */
    setMemberRole(
        actor: string,
        projectId: string,
        targetUserId: number,
        role: InviteRole,
    ): void;
    /** Remove a member (owner; the owner row is protected). */
    removeMember(
        actor: string,
        projectId: string,
        targetUserId: number,
    ): void;
    /** Mint an invite link (owner / editor; at most the creator's role). */
    createInvite(
        actor: string,
        projectId: string,
        role: InviteRole,
        origin: string,
    ): ProjectInvite;
    /** The project's invite links, newest first (owner). */
    listInvites(
        actor: string,
        projectId: string,
        origin: string,
    ): ProjectInvite[];
    /** Revoke an invite link (owner). */
    revokeInvite(
        actor: string,
        projectId: string,
        inviteId: string,
    ): void;
    /** Preview the current project name without consuming a valid invite. */
    previewInvite(user: string, token: string): { name: string };
    /**
     * Accept an invite link: the user joins with the invite's role.
     * Fails for a missing, used or expired link and when the user is
     * already a member.
     */
    join(user: string, token: string): {
        id: string;
        name: string;
        role: InviteRole;
    };
}

export function createProjects(db: AppDatabase | null): Projects {
    /** The db, or the 503 throw in `--no-auth` mode (narrows `db` to non-null). */
    const useDb = (): AppDatabase => (db ? db : noDb());

    const userIdOf = (login: string): number => {
        const d = useDb();
        const row = d
            .select({ id: users.id })
            .from(users)
            .where(eq(users.login, login))
            .get();
        if (!row) throw new ApiError(`Unknown user: ${login}`, 401);
        return row.id;
    };

    const roleRow = (
        userId: number,
        projectId: string,
    ): ProjectRole | null => {
        const d = useDb();
        const row = d
            .select({ role: projectMembers.role })
            .from(projectMembers)
            .where(
                and(
                    eq(projectMembers.projectId, projectId),
                    eq(projectMembers.userId, userId),
                ),
            )
            .get() as { role: ProjectRole } | undefined;
        return row?.role ?? null;
    };

    function validInvite(token: string): JoinInviteRow {
        const d = useDb();
        if (typeof token !== "string" || token === "")
            throw new ApiError("token is required");
        const row = d
            .select({
                id: projectInvites.id,
                project_id: projectInvites.projectId,
                role: projectInvites.role,
                expires_at: projectInvites.expiresAt,
                used_by: projectInvites.usedBy,
                name: projectsTable.name,
            })
            .from(projectInvites)
            .innerJoin(
                projectsTable,
                eq(projectInvites.projectId, projectsTable.id),
            )
            .where(eq(projectInvites.token, token))
            .get() as JoinInviteRow | undefined;
        if (!row) throw new ApiError("Invite link not found", 404);
        if (row.used_by !== null)
            throw new ApiError("Invite link already used", 409);
        if (row.expires_at && new Date(row.expires_at) < new Date())
            throw new ApiError("Invite link expired", 410);
        return row;
    }

    /**
     * The acting user's role in the project: a uniform 404 for both a
     * missing project and a non-member (no project existence leak), 403
     * when the role is insufficient.
     */
    function requireRole(
        actor: string,
        projectId: string,
        allowed: readonly ProjectRole[],
    ): ProjectRole {
        const role = roleRow(userIdOf(actor), projectId);
        if (!role)
            throw new ApiError(`Project ${projectId} not found`, 404);
        if (!allowed.includes(role))
            throw new ApiError(`Requires the ${allowed.join(" or ")} role`, 403);
        return role;
    }

    return {
        list: (user) => {
            if (!db) return [];
            const uid = db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.login, user))
                .get()?.id;
            if (uid === undefined) return [];
            const rows = db
                .select({
                    id: projectsTable.id,
                    name: projectsTable.name,
                    role: projectMembers.role,
                })
                .from(projectsTable)
                .innerJoin(
                    projectMembers,
                    eq(projectMembers.projectId, projectsTable.id),
                )
                .where(eq(projectMembers.userId, uid))
                .orderBy(desc(projectsTable.createdAt))
                .all() as { id: string; name: string; role: ProjectRole }[];
            return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
        },

        role: (user, projectId) => {
            if (!db) return null;
            return roleRow(userIdOf(user), projectId);
        },

        requireRole: (actor, projectId, allowed) => requireRole(actor, projectId, allowed),

        personalProjectId: (user) => {
            // `--no-auth` has no user rows: the synthetic local project stands in.
            if (!db) return LOCAL_PROJECT_ID;
            const d = useDb();
            const uid = userIdOf(user);
            // Default project for a request without `?project=`: the user's
            // earliest project as a member. Not auto-created — a user without
            // any project 404s (the UI offers to create one).
            const row = d
                .select({ id: projectsTable.id })
                .from(projectsTable)
                .innerJoin(
                    projectMembers,
                    eq(projectMembers.projectId, projectsTable.id),
                )
                .where(eq(projectMembers.userId, uid))
                .orderBy(projectsTable.createdAt, projectsTable.id)
                .limit(1)
                .get();
            if (!row)
                throw new ApiError(`User ${user} has no projects`, 404);
            return row.id;
        },

        create: (user, rawName) => {
            const d = useDb();
            const name = parseName(rawName);
            const id = randomUUID();
            const uid = userIdOf(user);
            d.transaction((t) => {
                t.insert(projectsTable)
                    .values({ id, name, ownerId: uid })
                    .run();
                t.insert(projectMembers)
                    .values({ projectId: id, userId: uid, role: "owner" })
                    .run();
            });
            return { id, name, role: "owner" };
        },

        rename: (actor, projectId, rawName) => {
            const d = useDb();
            const role = requireRole(actor, projectId, ["owner", "editor"]);
            const name = parseName(rawName);
            d.update(projectsTable)
                .set({
                    name,
                    updatedAt: sql`(CURRENT_TIMESTAMP)`,
                })
                .where(eq(projectsTable.id, projectId))
                .run();
            return { id: projectId, name, role };
        },

        remove: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            d.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();
        },

        listTokens: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor", "viewer"]);
            const rows = d
                .select({
                    id: tokens.id,
                    token: tokens.token,
                    created_at: tokens.createdAt,
                })
                .from(tokens)
                .where(eq(tokens.projectId, projectId))
                .orderBy(tokens.id)
                .all();
            return rows.map((r) => ({
                id: r.id,
                token: r.token,
                createdAt: r.created_at,
            }));
        },

        createToken: (actor, projectId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor"]);
            const token = randomBytes(24).toString("hex");
            // The INSERT...SELECT was just "insert with the actor's id" — the
            // role check above already proved the user exists.
            const created = d
                .insert(tokens)
                .values({
                    userId: userIdOf(actor),
                    token,
                    projectId,
                })
                .returning({
                    id: tokens.id,
                    token: tokens.token,
                    created_at: tokens.createdAt,
                })
                .get();
            return {
                id: created.id,
                token: created.token,
                createdAt: created.created_at,
            };
        },

        removeToken: (actor, projectId, tokenId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner", "editor"]);
            // Scope the delete to the project: a missing or foreign id 404s.
            // Scope the delete to the project: a missing or foreign id 404s.
            // tokenId is a string at the API edge (the URL tail).
            const existing = d
                .select({ id: tokens.id })
                .from(tokens)
                .where(
                    and(
                        eq(tokens.id, Number(tokenId)),
                        eq(tokens.projectId, projectId),
                    ),
                )
                .get();
            if (!existing)
                throw new ApiError(`Token ${tokenId} not found`, 404);
            d.delete(tokens)
                .where(
                    and(
                        eq(tokens.id, Number(tokenId)),
                        eq(tokens.projectId, projectId),
                    ),
                )
                .run();
        },

        members: (projectId) => {
            const d = useDb();
            const project = d
                .select({ id: projectsTable.id })
                .from(projectsTable)
                .where(eq(projectsTable.id, projectId))
                .get();
            if (!project)
                throw new ApiError(`Project ${projectId} not found`, 404);
            const rows = d
                .select({
                    user_id: users.id,
                    login: users.login,
                    role: projectMembers.role,
                })
                .from(projectMembers)
                .innerJoin(users, eq(users.id, projectMembers.userId))
                .where(eq(projectMembers.projectId, projectId))
                // Owners first, then by join time — a boolean expr sorts
                // DESC in SQLite (1 > 0).
                .orderBy(
                    desc(sql`(project_members.role = 'owner')`),
                    projectMembers.joinedAt,
                )
                .all() as {
                user_id: number;
                login: string;
                role: ProjectRole;
            }[];
            return rows.map((r) => ({
                userId: r.user_id,
                login: r.login,
                role: r.role,
            }));
        },

        setMemberRole: (actor, projectId, targetUserId, role) => {
            const d = useDb();
            if (!INVITE_ROLES.includes(role))
                throw new ApiError("role must be editor or viewer");
            requireRole(actor, projectId, ["owner"]);
            const target = d
                .select({ role: projectMembers.role })
                .from(projectMembers)
                .where(
                    and(
                        eq(projectMembers.projectId, projectId),
                        eq(projectMembers.userId, targetUserId),
                    ),
                )
                .get();
            if (!target) throw new ApiError("Member not found", 404);
            if (target.role === "owner")
                throw new ApiError("The owner role is fixed", 403);
            d.update(projectMembers)
                .set({ role })
                .where(
                    and(
                        eq(projectMembers.projectId, projectId),
                        eq(projectMembers.userId, targetUserId),
                    ),
                )
                .run();
        },

        removeMember: (actor, projectId, targetUserId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const target = d
                .select({ role: projectMembers.role })
                .from(projectMembers)
                .where(
                    and(
                        eq(projectMembers.projectId, projectId),
                        eq(projectMembers.userId, targetUserId),
                    ),
                )
                .get();
            if (!target) throw new ApiError("Member not found", 404);
            if (target.role === "owner")
                throw new ApiError(
                    "The owner cannot be removed — transfer it first or delete the project",
                    403,
                );
            d.delete(projectMembers)
                .where(
                    and(
                        eq(projectMembers.projectId, projectId),
                        eq(projectMembers.userId, targetUserId),
                    ),
                )
                .run();
        },

        createInvite: (actor, projectId, role, origin) => {
            const d = useDb();
            if (!INVITE_ROLES.includes(role))
                throw new ApiError("role must be editor or viewer");
            const actorRole = requireRole(actor, projectId, [
                "owner",
                "editor",
            ]);
            // The invite role must not exceed the creator's: an editor can
            // only mint viewer links.
            if (actorRole === "editor" && role !== "viewer")
                throw new ApiError(
                    "Editors can create viewer links only",
                    403,
                );
            const id = randomUUID();
            const token = randomBytes(24).toString("hex");
            const createdAt = new Date();
            const expiresAt = new Date(
                createdAt.getTime() + INVITE_TTL_MS,
            ).toISOString();
            d.insert(projectInvites)
                .values({
                    id,
                    projectId,
                    token,
                    role,
                    createdBy: userIdOf(actor),
                    expiresAt,
                })
                .run();
            return {
                id,
                role,
                url: `${origin}/projects/join/${token}`,
                createdAt: createdAt.toISOString(),
                expiresAt,
                usedBy: null,
            };
        },

        listInvites: (actor, projectId, origin) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const rows = d
                .select({
                    id: projectInvites.id,
                    token: projectInvites.token,
                    role: projectInvites.role,
                    created_at: projectInvites.createdAt,
                    expires_at: projectInvites.expiresAt,
                    used_by: users.login,
                })
                .from(projectInvites)
                .leftJoin(users, eq(users.id, projectInvites.usedBy))
                .where(eq(projectInvites.projectId, projectId))
                .orderBy(desc(projectInvites.createdAt))
                .all() as InviteRow[];
            return rows.map((r) => inviteOf(r, origin));
        },

        revokeInvite: (actor, projectId, inviteId) => {
            const d = useDb();
            requireRole(actor, projectId, ["owner"]);
            const existing = d
                .select({ id: projectInvites.id })
                .from(projectInvites)
                .where(
                    and(
                        eq(projectInvites.projectId, projectId),
                        eq(projectInvites.id, inviteId),
                    ),
                )
                .get();
            if (!existing) throw new ApiError("Invite link not found", 404);
            d.delete(projectInvites)
                .where(
                    and(
                        eq(projectInvites.projectId, projectId),
                        eq(projectInvites.id, inviteId),
                    ),
                )
                .run();
        },

        previewInvite: (user, token) => {
            userIdOf(user);
            return { name: validInvite(token).name };
        },

        join: (user, token) => {
            const d = useDb();
            const row = validInvite(token);
            const uid = userIdOf(user);
            if (roleRow(uid, row.project_id))
                throw new ApiError("You are already a member", 409);
            d.transaction((t) => {
                t.insert(projectMembers)
                    .values({ projectId: row.project_id, userId: uid, role: row.role })
                    .run();
                t.update(projectInvites)
                    .set({ usedBy: uid, usedAt: sql`(CURRENT_TIMESTAMP)` })
                    .where(eq(projectInvites.id, row.id))
                    .run();
            });
            return {
                id: row.project_id,
                name: row.name,
                role: row.role,
            };
        },
    };
}
