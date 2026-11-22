/*
 * Assets manager backend: a per-project folder tree with file storage.
 *
 * Every project owns an isolated subtree — all queries are project_id-scoped, so a
 * project only ever sees (or mutates) their own folders and files. Each project's
 * tree has a single root folder (created lazily on first access). File bytes
 * live on disk in the server's storage directory (one file per asset, keyed
 * by its id); the database keeps only the metadata.
 *
 * The API is child-oriented (list children of a folder) so the frontend can
 * load the tree lazily as it expands.
 */
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { AppDatabase } from "../../../core/db";
import { assetFiles, assetFolders } from "../../../core/schema";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../../../../shared/params";

export const ROOT_NAME = "Root";
const MAX_NAME_LENGTH = 200;
const MAX_FOLDER_DEPTH = 16;
export const MAX_FILE_SIZE = 200 * 1024 * 1024;

export interface AssetFolder {
    id: string;
    parentId: string | null;
    name: string;
    createdAt: number;
    /** `true` when the folder has at least one subfolder (tree chevron). */
    hasChildren: boolean;
    /** Number of files directly in the folder. */
    fileCount: number;
}

export interface AssetFile {
    id: string;
    folderId: string;
    name: string;
    size: number;
    mimeType: string;
    createdAt: number;
    updatedAt: number;
}

interface FolderRow {
    id: string;
    project_id: string;
    parent_id: string | null;
    name: string;
    created_at: number;
}

interface FileRow {
    id: string;
    folder_id: string;
    name: string;
    size: number;
    mime_type: string;
    created_at: number;
    updated_at: number;
}

export interface Assets {
    /** The project's single root folder (created on first access). */
    rootFolder(project: string): AssetFolder;
    /** The child folders of `parentId` (`null` for the root list). */
    listFolders(project: string, parentId: string | null): AssetFolder[];
    /** Every folder of the project (move-target pickers). */
    allFolders(project: string): AssetFolder[];
    createFolder(
        project: string,
        parentId: string,
        name: string,
    ): AssetFolder;
    renameFolder(project: string, folderId: string, name: string): AssetFolder;
    moveFolder(project: string, folderId: string, parentId: string): AssetFolder;
    deleteFolder(project: string, folderId: string): void;
    listFiles(project: string, folderId: string): AssetFile[];
    uploadFile(
        project: string,
        folderId: string,
        name: string,
        mimeType: string,
        data: Uint8Array,
    ): AssetFile;
    renameFile(project: string, fileId: string, name: string): AssetFile;
    moveFile(project: string, fileId: string, folderId: string): AssetFile;
    deleteFile(project: string, fileId: string): void;
    /** A file's metadata (project_id-checked; for the drag-and-drop move path). */
    fileMeta(project: string, fileId: string): AssetFile;
    /** The file metadata + raw bytes (project_id-checked). */
    fileBlob(project: string, fileId: string): { file: AssetFile; data: Uint8Array };
    /**
     * The project's files of one media kind, flattened across the whole tree
     * with their folder path (the overlay editor's asset picker).
     */
    browseFiles(
        project: string,
        kind: "image" | "video" | "audio",
    ): (AssetFile & { path: string })[];
}

export function createAssets({
    db,
    storageDir = "assets",
}: {
    db: AppDatabase | null;
    /** Directory the asset files are written to (flat, one file per id). */
    storageDir: string;
}): Assets {
    if (!db) {
        // `--no-auth` runs without a project database: the asset API stays
        // disabled and answers with empty lists.
        const unavailable = () => {
            throw new ApiError("Assets are unavailable");
        };
        return {
            rootFolder: unavailable,
            listFolders: () => [],
            allFolders: () => [],
            createFolder: unavailable,
            renameFolder: unavailable,
            moveFolder: unavailable,
            deleteFolder: unavailable,
            listFiles: () => [],
            uploadFile: unavailable,
            renameFile: unavailable,
            moveFile: unavailable,
            deleteFile: unavailable,
            fileMeta: unavailable,
            fileBlob: unavailable,
            browseFiles: () => [],
        };
    }
    const database: AppDatabase = db;

    const now = () => Date.now();

    // File bytes live on disk, one file per asset id (ids are server-minted
    // UUIDs, so a flat layout is collision-free and path-safe).
    const storagePath = (fileId: string): string => join(storageDir, fileId);

    const removeDiskFile = (fileId: string): void => {
        try {
            rmSync(storagePath(fileId), { force: true });
        } catch {
            // a missing disk file is not an error
        }
    };

    /** Validate a folder/file display name and return its trimmed form. */
    function parseName(raw: unknown, what: "folder" | "file"): string {
        if (typeof raw !== "string")
            throw new ApiError(`${what} name is required`);
        const name = raw.trim();
        if (!name) throw new ApiError(`${what} name is required`);
        if (name.length > MAX_NAME_LENGTH)
            throw new ApiError(
                `${what} name is too long (max ${MAX_NAME_LENGTH})`,
            );
        if (name.includes("/"))
            throw new ApiError(`${what} name cannot contain “/”`);
        if (/[\x00-\x1f]/.test(name))
            throw new ApiError(`${what} name contains invalid characters`);
        return name;
    }

    const folderById = (
        project: string,
        id: string,
    ): FolderRow | undefined =>
        database
            .select({
                id: assetFolders.id,
                project_id: assetFolders.projectId,
                parent_id: assetFolders.parentId,
                name: assetFolders.name,
                created_at: assetFolders.createdAt,
            })
            .from(assetFolders)
            .where(
                and(
                    eq(assetFolders.id, id),
                    eq(assetFolders.projectId, project),
                ),
            )
            .get() as FolderRow | undefined;

    const getFolder = (project: string, id: string): FolderRow => {
        const row = folderById(project, id);
        if (!row) throw new ApiError("Folder not found", 404);
        return row;
    };

    const toFile = (row: FileRow): AssetFile => ({
        id: row.id,
        folderId: row.folder_id,
        name: row.name,
        size: row.size,
        mimeType: row.mime_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });

    const getFile = (project: string, id: string): AssetFile => {
        const row = database
            .select({
                id: assetFiles.id,
                folder_id: assetFiles.folderId,
                name: assetFiles.name,
                size: assetFiles.size,
                mime_type: assetFiles.mimeType,
                created_at: assetFiles.createdAt,
                updated_at: assetFiles.updatedAt,
            })
            .from(assetFiles)
            .where(
                and(
                    eq(assetFiles.id, id),
                    eq(assetFiles.projectId, project),
                ),
            )
            .get() as FileRow | undefined;
        if (!row) throw new ApiError("File not found", 404);
        return toFile(row);
    };

    /** Ancestor chain of `folderId` (the folder itself first). */
    const ancestorIds = (project: string, folderId: string): string[] => {
        const chain: string[] = [];
        let current: FolderRow | undefined = getFolder(project, folderId);
        while (current) {
            chain.push(current.id);
            if (!current.parent_id) break;
            current = folderById(project, current.parent_id);
        }
        return chain;
    };

    const nameTaken = (
        project: string,
        folderId: string,
        name: string,
    ): boolean =>
        (database
            .select({ n: sql<number>`count(*)` })
            .from(assetFiles)
            .where(
                and(
                    eq(assetFiles.projectId, project),
                    eq(assetFiles.folderId, folderId),
                    eq(assetFiles.name, name),
                ),
            )
            .get()?.n ?? 0) > 0;

    const toFolder = (project: string, row: FolderRow): AssetFolder => ({
        id: row.id,
        parentId: row.parent_id,
        name: row.name,
        createdAt: row.created_at,
        hasChildren:
            (database
                .select({ n: sql<number>`count(*)` })
                .from(assetFolders)
                .where(
                    and(
                        eq(assetFolders.projectId, project),
                        eq(assetFolders.parentId, row.id),
                    ),
                )
                .get()?.n ?? 0) > 0,
        fileCount:
            (database
                .select({ n: sql<number>`count(*)` })
                .from(assetFiles)
                .where(
                    and(
                        eq(assetFiles.projectId, project),
                        eq(assetFiles.folderId, row.id),
                    ),
                )
                .get()?.n ?? 0),
    });

    function rootFolder(project: string): AssetFolder {
        const existing = database
            .select({
                id: assetFolders.id,
                project_id: assetFolders.projectId,
                parent_id: assetFolders.parentId,
                name: assetFolders.name,
                created_at: assetFolders.createdAt,
            })
            .from(assetFolders)
            .where(
                and(
                    eq(assetFolders.projectId, project),
                    isNull(assetFolders.parentId),
                ),
            )
            .get() as FolderRow | undefined;
        if (existing) return toFolder(project, existing);
        const id = randomUUID();
        const ts = now();
        database
            .insert(assetFolders)
            .values({
                id,
                projectId: project,
                parentId: null,
                name: ROOT_NAME,
                createdAt: ts,
            })
            .run();
        return toFolder(project, {
            id,
            project_id: project,
            parent_id: null,
            name: ROOT_NAME,
            created_at: ts,
        });
    }

    function listFolders(
        project: string,
        parentId: string | null,
    ): AssetFolder[] {
        if (parentId === null) rootFolder(project);
        const rows = database
            .select({
                id: assetFolders.id,
                project_id: assetFolders.projectId,
                parent_id: assetFolders.parentId,
                name: assetFolders.name,
                created_at: assetFolders.createdAt,
            })
            .from(assetFolders)
            .where(
                and(
                    eq(assetFolders.projectId, project),
                    parentId === null
                        ? isNull(assetFolders.parentId)
                        : eq(assetFolders.parentId, parentId),
                ),
            )
            .orderBy(sql`${assetFolders.name} COLLATE NOCASE`)
            .all() as FolderRow[];
        return rows.map((row) => toFolder(project, row));
    }

    function allFolders(project: string): AssetFolder[] {
        const rows = database
            .select({
                id: assetFolders.id,
                project_id: assetFolders.projectId,
                parent_id: assetFolders.parentId,
                name: assetFolders.name,
                created_at: assetFolders.createdAt,
            })
            .from(assetFolders)
            .where(eq(assetFolders.projectId, project))
            .all() as FolderRow[];
        return rows.map((row) => toFolder(project, row));
    }

    function createFolder(
        project: string,
        parentId: string,
        name: string,
    ): AssetFolder {
        const clean = parseName(name, "folder");
        getFolder(project, parentId);
        const taken = (
            database
                .select({ n: sql<number>`count(*)` })
                .from(assetFolders)
                .where(
                    and(
                        eq(assetFolders.projectId, project),
                        eq(assetFolders.parentId, parentId),
                        sql`${assetFolders.name} = ${clean} COLLATE NOCASE`,
                    ),
                )
                .get()?.n ?? 0
        );
        if (taken)
            throw new ApiError(
                "A folder with this name already exists",
                409,
            );
        const depth = ancestorIds(project, parentId).length + 1;
        if (depth > MAX_FOLDER_DEPTH)
            throw new ApiError(`Folder is too deep (max ${MAX_FOLDER_DEPTH})`);
        const id = randomUUID();
        database
            .insert(assetFolders)
            .values({
                id,
                projectId: project,
                parentId,
                name: clean,
                createdAt: now(),
            })
            .run();
        return toFolder(project, getFolder(project, id));
    }

    function renameFolder(
        project: string,
        folderId: string,
        name: string,
    ): AssetFolder {
        const clean = parseName(name, "folder");
        const folder = getFolder(project, folderId);
        if (folder.parent_id === null)
            throw new ApiError("The root folder cannot be renamed");
        database
            .update(assetFolders)
            .set({ name: clean })
            .where(
                and(
                    eq(assetFolders.id, folderId),
                    eq(assetFolders.projectId, project),
                ),
            )
            .run();
        return toFolder(project, getFolder(project, folderId));
    }

    function moveFolder(
        project: string,
        folderId: string,
        parentId: string,
    ): AssetFolder {
        const folder = getFolder(project, folderId);
        if (folder.parent_id === null)
            throw new ApiError("The root folder cannot be moved");
        const parent = getFolder(project, parentId);
        if (parent.id === folderId)
            throw new ApiError("A folder cannot be moved into itself");
        const chain = ancestorIds(project, parentId);
        if (chain.includes(folderId))
            throw new ApiError("A folder cannot be moved into its own subtree");
        const depth = chain.length + 1;
        if (depth > MAX_FOLDER_DEPTH)
            throw new ApiError(`Folder is too deep (max ${MAX_FOLDER_DEPTH})`);
        database
            .update(assetFolders)
            .set({ parentId })
            .where(
                and(
                    eq(assetFolders.id, folderId),
                    eq(assetFolders.projectId, project),
                ),
            )
            .run();
        return toFolder(project, getFolder(project, folderId));
    }

    function deleteFolder(project: string, folderId: string): void {
        const folder = getFolder(project, folderId);
        if (folder.parent_id === null)
            throw new ApiError("The root folder cannot be deleted");
        // Walk the subtree breadth-first: the folder plus all descendants.
        const doomed = new Set<string>([folderId]);
        const queue = [folderId];
        while (queue.length) {
            const id = queue.shift();
            if (id === undefined) break;
            const children = database
                .select({ id: assetFolders.id })
                .from(assetFolders)
                .where(
                    and(
                        eq(assetFolders.projectId, project),
                        eq(assetFolders.parentId, id),
                    ),
                )
                .all();
            for (const child of children) {
                if (!doomed.has(child.id)) {
                    doomed.add(child.id);
                    queue.push(child.id);
                }
            }
        }
        // The disk file names are the file ids — collect them while the rows
        // still exist.
        const doomedIds = [...doomed];
        const doomedFileIds = (
            database
                .select({ id: assetFiles.id })
                .from(assetFiles)
                .where(
                    and(
                        eq(assetFiles.projectId, project),
                        inArray(assetFiles.folderId, doomedIds),
                    ),
                )
                .all()
        ).map((r) => r.id);
        database.transaction((t) => {
            for (const id of doomed) {
                t.delete(assetFiles)
                    .where(
                        and(
                            eq(assetFiles.projectId, project),
                            eq(assetFiles.folderId, id),
                        ),
                    )
                    .run();
                t.delete(assetFolders)
                    .where(
                        and(
                            eq(assetFolders.id, id),
                            eq(assetFolders.projectId, project),
                        ),
                    )
                    .run();
            }
        });
        for (const id of doomedFileIds) removeDiskFile(id);
    }

    function listFiles(project: string, folderId: string): AssetFile[] {
        getFolder(project, folderId); // project_id + existence check
        const rows = database
            .select({
                id: assetFiles.id,
                folder_id: assetFiles.folderId,
                name: assetFiles.name,
                size: assetFiles.size,
                mime_type: assetFiles.mimeType,
                created_at: assetFiles.createdAt,
                updated_at: assetFiles.updatedAt,
            })
            .from(assetFiles)
            .where(
                and(
                    eq(assetFiles.projectId, project),
                    eq(assetFiles.folderId, folderId),
                ),
            )
            .orderBy(sql`${assetFiles.name} COLLATE NOCASE`)
            .all() as FileRow[];
        return rows.map(toFile);
    }

    /** The name as given, or `name (n).ext` with the smallest free `n`. */
    function uniqueName(
        project: string,
        folderId: string,
        name: string,
    ): string {
        if (!nameTaken(project, folderId, name)) return name;
        const dot = name.lastIndexOf(".");
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        for (let i = 1; ; i++) {
            const candidate = `${base} (${i})${ext}`;
            if (candidate.length > MAX_NAME_LENGTH)
                throw new ApiError("File name is too long", 409);
            if (!nameTaken(project, folderId, candidate)) return candidate;
        }
    }

    function uploadFile(
        project: string,
        folderId: string,
        name: string,
        mimeType: string,
        data: Uint8Array,
    ): AssetFile {
        const clean = parseName(name, "file");
        getFolder(project, folderId);
        // Browser File objects carry `;charset=utf-8` on text/* types —
        // store the bare media type, not the parameter.
        const mime = (mimeType || "").split(";")[0].trim();
        if (data.byteLength > MAX_FILE_SIZE)
            throw new ApiError(
                `File is too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`,
                413,
            );
        const finalName = uniqueName(project, folderId, clean);
        const id = randomUUID();
        const ts = now();
        // Bytes go to the storage directory; the row keeps only the metadata.
        mkdirSync(storageDir, { recursive: true });
        writeFileSync(storagePath(id), data);
        database
            .insert(assetFiles)
            .values({
                id,
                projectId: project,
                folderId,
                name: finalName,
                size: data.byteLength,
                mimeType: mime || "application/octet-stream",
                createdAt: ts,
                updatedAt: ts,
            })
            .run();
        return getFile(project, id);
    }

    function renameFile(
        project: string,
        fileId: string,
        name: string,
    ): AssetFile {
        const clean = parseName(name, "file");
        const file = getFile(project, fileId);
        if (clean !== file.name && nameTaken(project, file.folderId, clean))
            throw new ApiError("A file with this name already exists", 409);
        database
            .update(assetFiles)
            .set({ name: clean, updatedAt: now() })
            .where(
                and(
                    eq(assetFiles.id, fileId),
                    eq(assetFiles.projectId, project),
                ),
            )
            .run();
        return getFile(project, fileId);
    }

    function moveFile(
        project: string,
        fileId: string,
        folderId: string,
    ): AssetFile {
        const file = getFile(project, fileId);
        getFolder(project, folderId);
        if (file.folderId !== folderId && nameTaken(project, folderId, file.name))
            throw new ApiError("A file with this name already exists", 409);
        database
            .update(assetFiles)
            .set({ folderId, updatedAt: now() })
            .where(
                and(
                    eq(assetFiles.id, fileId),
                    eq(assetFiles.projectId, project),
                ),
            )
            .run();
        return getFile(project, fileId);
    }

    function deleteFile(project: string, fileId: string): void {
        getFile(project, fileId);
        database
            .delete(assetFiles)
            .where(
                and(
                    eq(assetFiles.id, fileId),
                    eq(assetFiles.projectId, project),
                ),
            )
            .run();
        removeDiskFile(fileId);
    }

    function fileBlob(
        project: string,
        fileId: string,
    ): { file: AssetFile; data: Uint8Array } {
        const file = getFile(project, fileId);
        let data: Uint8Array;
        try {
            data = new Uint8Array(readFileSync(storagePath(fileId)));
        } catch {
            throw new ApiError("File not found", 404);
        }
        return { file, data };
    }

    function browseFiles(
        project: string,
        kind: "image" | "video" | "audio",
    ): (AssetFile & { path: string })[] {
        rootFolder(project);
        const folders = database
            .select({
                id: assetFolders.id,
                project_id: assetFolders.projectId,
                parent_id: assetFolders.parentId,
                name: assetFolders.name,
                created_at: assetFolders.createdAt,
            })
            .from(assetFolders)
            .where(eq(assetFolders.projectId, project))
            .all() as FolderRow[];
        const byId = new Map(folders.map((f) => [f.id, f]));
        const prefix = `${kind}/`;
        const out: (AssetFile & { path: string })[] = [];
        // Walk the tree depth-first; `path` is the folder chain without the
        // root folder itself (its name is constant).
        const walk = (folderId: string, trail: string[]): void => {
            const folder = byId.get(folderId);
            if (!folder) return;
            const rows = database
                .select({
                    id: assetFiles.id,
                    folder_id: assetFiles.folderId,
                    name: assetFiles.name,
                    size: assetFiles.size,
                    mime_type: assetFiles.mimeType,
                    created_at: assetFiles.createdAt,
                    updated_at: assetFiles.updatedAt,
                })
                .from(assetFiles)
                .where(
                    and(
                        eq(assetFiles.projectId, project),
                        eq(assetFiles.folderId, folderId),
                        like(assetFiles.mimeType, `${prefix}%`),
                    ),
                )
                .orderBy(sql`${assetFiles.name} COLLATE NOCASE`)
                .all() as FileRow[];
            for (const row of rows)
                out.push({ ...toFile(row), path: trail.join("/") });
            const children = folders
                .filter((f) => f.parent_id === folderId)
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const child of children)
                walk(child.id, [...trail, child.name]);
        };
        for (const root of folders.filter((f) => f.parent_id === null))
            walk(root.id, []);
        out.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
        return out;
    }

    return {
        rootFolder,
        listFolders,
        allFolders,
        createFolder,
        renameFolder,
        moveFolder,
        deleteFolder,
        listFiles,
        uploadFile,
        renameFile,
        moveFile,
        deleteFile,
        fileMeta: getFile,
        fileBlob,
        browseFiles,
    };
}
