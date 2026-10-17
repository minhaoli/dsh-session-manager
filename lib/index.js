/**
 * dsh session-manager plugin — agent tools + browser REST API for session
 * housekeeping.
 *
 * Tools:
 *   session_list      — enumerate sessions (id, title, workspace, archived, tags)
 *   session_move      — move session(s) across workspaces (live, no restart)
 *   session_delete    — permanently delete session(s) (optional backup)
 *   session_tag       — add/remove/set/list tags on sessions
 *   session_archive   — archive a session (wraps the registry's own archive API)
 *   session_unarchive — restore an archived session (complements the GUI, which
 *                       only offers archive)
 *
 * Browser REST API (same-origin, loopback-only; registered when the webServer
 * service is present). Each handler funnels through the tool's own `execute`,
 * so the agent surface and the UI surface share one implementation:
 *   GET  /api/dsh-session-manager/sessions            — full session list
 *   GET  /api/dsh-session-manager/tags                — { tags: { id: [...] } }
 *   PUT  /api/dsh-session-manager/tags                — body { sessionId, tags }
 *   POST /api/dsh-session-manager/sessions/move       — body { sessionIds, targetWorkspaceId|targetPath, createIfMissing? }
 *   POST /api/dsh-session-manager/sessions/delete     — body { sessionIds, backupDir? }
 *   POST /api/dsh-session-manager/sessions/archive    — body { sessionId }
 *   POST /api/dsh-session-manager/sessions/unarchive  — body { sessionId }
 *
 * Archive preservation (no conflict): archiving always funnels through the
 * workspace registry's own `archiveSession()` (the same add-only API the GUI
 * uses); this plugin never rewrites the archive set except when explicitly
 * deleting/unarchiving, and even then it goes through the registry's public
 * `enqueueOperation`/`setState` write chain so the registry's cached state
 * stays coherent.
 *
 * Cross-workspace moves keep the session log's header `cwd` and the on-disk
 * project directory in sync with the workspace registry in real time: the
 * physical move (zstd header rewrite + dir rename) is followed by a registry
 * header re-index and the public `attachSession`/`detachSession` calls, so the
 * GUI reflects the change without a restart. The session-projection cache's
 * `identity.cwd` is updated through the storage-domain table handle.
 *
 * Zero-import by design (only `node:` builtins), matching zen-useragent.js:
 * the file plugin is loaded via native dynamic import, so bare specifiers are
 * avoided entirely; services are reached through `ctx` only.
 */

import { readFileSync, writeFileSync, renameSync, rmSync, cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync, zstdCompressSync, constants } from "node:zlib";

/* ------------------------------------------------------------------ */
/* zstd session-log surgery (proven core from the manual move script)  */
/* ------------------------------------------------------------------ */

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const MAGIC = 4247762216;

/** Scan a zstd multi-frame buffer into frame byte ranges. */
function scanFrames(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error("bad zstd magic");
    o += 4;
    const d = buf.readUInt8(o); o += 1;
    if ((d & 24) !== 0) throw new Error("reserved frame-header bit");
    const cs = d >>> 6, sg = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const cb = cs === 0 ? (sg ? 1 : 0) : 1 << cs;
    const rhb = (sg ? 0 : 1) + db + cb;
    if (buf.length - o < rhb) return { frames, tornStart: s };
    o += rhb;
    for (;;) {
      if (buf.length - o < 3) return { frames, tornStart: s };
      const bh = buf.readUIntLE(o, 3); o += 3;
      const lb = (bh & 1) !== 0, bt = bh >>> 1 & 3, bs = bh >>> 3;
      const pb = bt === 1 ? 1 : bs;
      if (buf.length - o < pb) return { frames, tornStart: s };
      o += pb;
      if (lb) break;
    }
    if (ck) o += 4;
    frames.push([s, o]);
  }
  return { frames };
}

/** Rewrite the header line (first zstd frame) of a session log in place. */
function rewriteHeader(logPath, newCwd) {
  const buf = readFileSync(logPath);
  const { frames } = scanFrames(buf);
  if (frames.length === 0) throw new Error("no zstd frames in " + logPath);
  const [s0, e0] = frames[0];
  const hdr = zstdDecompressSync(buf.subarray(s0, e0)).toString("utf8");
  if (!hdr.endsWith("\n")) throw new Error("header frame is not a single line");
  const parsed = JSON.parse(hdr.trim());
  parsed.cwd = newCwd;
  const newFrame = zstdCompressSync(Buffer.from(JSON.stringify(parsed) + "\n", "utf8"), CHECKSUM);
  writeFileSync(logPath, Buffer.concat([newFrame, buf.subarray(e0)]));
  return parsed;
}

/**
 * List a session directory's log files for every format generation
 * (`session.jsonl.zstd` plus migrated `session.vN.jsonl.zstd`).
 * @param dir - the session directory.
 * @returns generation log basenames (empty when the directory is missing).
 */
function generationLogNames(dir) {
  try {
    return readdirSync(dir).filter((n) => /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(n));
  } catch {
    return [];
  }
}

/**
 * Rewrite the header cwd of EVERY generation file in a session directory.
 * Rewriting the v0 source alone is not enough: dsh validates the identity of the
 * CURRENT generation (e.g. `session.v3.jsonl.zstd`) on boot, so a stale migrated
 * header cwd makes the session log look corrupt after a move.
 * @param dir - the session directory.
 * @param newCwd - the destination project path.
 * @returns the rewritten basenames.
 */
function rewriteAllGenerationHeaders(dir, newCwd) {
  const names = generationLogNames(dir);
  if (names.length === 0) throw new Error("session log missing at " + dir);
  for (const name of names) rewriteHeader(join(dir, name), newCwd);
  return names;
}

/** Verify a session log decodes fully; returns frame count + header line. */
function verifyFullDecode(logPath) {
  const buf = readFileSync(logPath);
  const { frames } = scanFrames(buf);
  let plain = "";
  for (const [s, e] of frames) plain += zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
  return { frames: frames.length, bytes: plain.length, firstLine: plain.split("\n")[0] };
}

/* ------------------------------------------------------------------ */
/* persistence path encoding (mirror of dsh-session-persistence-jsonl) */
/* ------------------------------------------------------------------ */

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}

function logPath(root, cwd, id) {
  return join(sessionDir(root, cwd, id), "session.jsonl.zstd");
}

/* ------------------------------------------------------------------ */
/* tag store (sidecar JSON, like ~/.dsh/dsh-ssh.json)                  */
/* ------------------------------------------------------------------ */

function tagFilePath() {
  if (process.env.DSH_SESSION_TAGS) return process.env.DSH_SESSION_TAGS;
  return join(homedir(), ".dsh", "session-tags.json");
}

function readTags() {
  try {
    const data = JSON.parse(readFileSync(tagFilePath(), "utf8"));
    return data && typeof data === "object" && data.tags ? data.tags : {};
  } catch {
    return {};
  }
}

function writeTags(tags) {
  const file = tagFilePath();
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, tags }, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function sessionTags(id) {
  return readTags()[id] ?? [];
}

function setSessionTags(id, list) {
  const tags = readTags();
  const cleaned = [...new Set(list.filter((t) => typeof t === "string" && t.length > 0))];
  if (cleaned.length === 0) delete tags[id];
  else tags[id] = cleaned;
  writeTags(tags);
}

/* ------------------------------------------------------------------ */
/* service helpers                                                     */
/* ------------------------------------------------------------------ */

function text(s) {
  return [{ type: "text", text: String(s) }];
}

/** Recursively drop undefined fields so tool results round-trip as lossless JSON. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = clean(item);
    }
    return out;
  }
  return value;
}

/** Full-identity error object tool output. */
function failure(message) {
  return { ok: false, error: String(message) };
}

function ok(value) {
  return clean({ ok: true, ...value });
}

/* ------------------------------------------------------------------ */
/* tool definitions (hand-rolled; parameters are compiled JSON Schema) */
/* ------------------------------------------------------------------ */

/**
 * 0.1.5 兼容归一化：新版 persistence.list() 返回 SessionStorageMetadata[]（header 在 .meta 里），
 * 旧版（<=0.1.1）直接返回 SessionHeader[]。两种结构都归一化为 header 数组。
 */
function unwrapSessionHeaders(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.header) return row.header;   // 0.1.5 jsonl 运行时：{ header, revision, sizeBytes }
    if (row.meta) return row.meta;       // 类型定义形态：{ meta, inheritedEventCount }
    return row;                          // <=0.1.1：直接是 SessionHeader
  });
}
function makeTools(ctx) {
  const registry = () => ctx.get("workspaceRegistry");
  const persistence = () => ctx.get("sessionPersistence");
  const storageDomain = () => ctx.get("storageDomain");
  const liveSessions = () => ctx.get("sessions");
  const liveAgents = () => ctx.get("agents");

  /**
  * Whether the session is the current running conversation.
  *
  * Neither `ctx.sessions.get(id)` nor a bare `ctx.agents.get(id)` is a correct
  * "current conversation" test in the web profile:
  * - `sessions.get(id)` returns ANY session ever loaded into the in-memory
  *   store (opened in the GUI, resumed once, …).
  * - `agents.get(id) !== undefined` is ALSO too broad: opening a session in
  *   the web GUI mounts/keeps a (usually idle) agent for it, so every session
  *   the user has ever opened reports a live agent. That would still refuse to
  *   delete or move almost everything the user sees.
  *
  * The accurate signal is the agent's STATUS: an agent whose phase is not
  * idle is genuinely running a conversation turn right now (this is exactly
  * how the host API computes the `activity` field of `session.list` —
  * `ctx.agents.get(id)?.status === "running"`). An idle agent merely holds the
  * session open; the conversation log is durable on disk and no loop is
  * actively writing it, so moving/deleting the session is safe (the agent's
  * in-memory session will simply end up detached from a deleted/moved log).
  * @param id - the session id to test.
  * @returns true only when a live agent is RUNNING a conversation on that id.
  */
  function isLive(id) {
    return liveAgents()?.get(id)?.status === "running";
  }

  /** Find the workspace entity owning a session by its stored cwd. */
  async function owningWorkspaceByCwd(cwd) {
    const reg = registry();
    if (reg === undefined || cwd === undefined) return undefined;
    try {
      return await reg.resolveByPath(cwd);
    } catch {
      return undefined;
    }
  }

  /**
  * Header for a persisted session, with DISK as the authority.
  *
  * We deliberately do NOT use `registry().readSessionHeader(id)` here: that API
  * returns the LIVE in-memory session header first (`ctx.sessions.get(id)`),
  * which is the header captured when the session was opened. After a move the
  * in-memory session keeps the OLD cwd while the log physically lives under the
  * new project dir — subsequent move/delete calls would then look for the log
  * under the old dir and fail with "session dir missing". Scanning
  * `persistence.list()` (the same disk scan the host uses for cold summaries)
  * reflects the true on-disk location even for sessions with stale memory
  * headers. This also fixes delete-after-move and move-back-after-move.
  */
  async function sessionHeader(id) {
    for (const header of unwrapSessionHeaders(await persistence().list())) {
      if (header.id === id) return header;
    }
    return undefined;
  }

  /** projcache title, best-effort. */
  function cachedTitle(id) {
    try {
      const domain = storageDomain()?.get("session_projcache");
      const record = domain?.table("sessions").get(id);
      const val = record?.rows?.title?.val;
      return typeof val === "string" ? val : undefined;
    } catch {
      return undefined;
    }
  }

  /**
  * Drop the in-memory mounts (SessionStore entry + AgentRegistry entry) for a
  * session whose durable log has been deleted or moved.
  *
  * Why this is required: the host API builds `session.list` from
  * `ctx.sessions.list()` (the LIVE in-memory store) plus a cold scan of
  * persisted logs. Deleting the log on disk is NOT enough — if the session was
  * ever opened in the web GUI, its SessionStore entry and (usually idle) agent
  * stay mounted in memory until the web process exits, so `session.list` keeps
  * returning the session and the UI shows it under "Ungrouped" until a restart.
  * Moving has the same trap in reverse: the mounted agent still points at the
  * old cwd, so a later prompt would write to a stale path / trip the host's
  * cwd-consistency guard.
  *
  * `sessions.detachEntered(entry)` and `agents.detachEntered(entry)` are the
  * store's own public teardown entry points (same code path the agent-lifecycle
  * disposer uses); `store` is the store's public backing map. Each is
  * idempotent and no-ops when the entry is already gone, and each emits the
  * matching `session/disposed` / `agent/disposed` edge so listeners (projcache,
  * title service, …) observe the teardown. Live (running) sessions are never
  * released this way — isLive() refuses them before any of this runs.
  */
  function releaseMount(id) {
    const sessions = ctx.get("sessions");
    const agents = ctx.get("agents");
    try {
      const entry = sessions?.store?.get(id);
      if (entry !== undefined) sessions.detachEntered(entry);
    } catch (error) {
      ctx.logger?.warn?.(`session-manager: releasing session mount for ${id} failed: ${String(error)}`);
    }
    try {
      const entry = agents?.store?.get(id);
      if (entry !== undefined) agents.detachEntered(entry);
    } catch (error) {
      ctx.logger?.warn?.(`session-manager: releasing agent mount for ${id} failed: ${String(error)}`);
    }
  }

  /** Refresh the registry's in-memory header index from disk (public API). */
  async function refreshRegistryIndex() {
    const reg = registry();
    if (reg === undefined) return;
    await reg.replaceHeaderIndex(unwrapSessionHeaders(await persistence().list()));
  }

  /** Update the projcache identity.cwd for a moved session (best-effort). */
  function updateProjectionCwd(id, cwd) {
    try {
      const domain = storageDomain()?.get("session_projcache");
      const table = domain?.table("sessions");
      const current = table?.get(id);
      if (table === undefined || current === undefined) return;
      table.update(id, (record) => ({ ...record, identity: { ...record.identity, cwd } }));
    } catch {
      /* fail-soft: cache row mismatch falls back to a cold-log replay */
    }
  }

  /** Remove a session from the registry-global archive set (public chain). */
  async function removeFromArchive(id) {
    const reg = registry();
    if (reg === undefined) return;
    await reg.enqueueOperation(async () => {
      const state = reg.requireState();
      if (!state.archivedSessionIds.includes(id)) return;
      await reg.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id)
      });
    });
  }

  /** Resolve a target workspace entity from id or path (optionally creating). */
  async function resolveTargetWorkspace(target) {
    const reg = registry();
    if (reg === undefined) throw new Error("workspace registry service unavailable");
    const id = typeof target === "string" ? target : target.id;
    const path = typeof target === "string" ? undefined : target.path;
    const createIfMissing = typeof target === "string" ? false : target.createIfMissing === true;
    const title = typeof target === "string" ? undefined : target.title;
    if (typeof id === "string" && id.length > 0) {
      const byId = reg.get(id);
      if (byId !== undefined) return byId;
      if (path === undefined && !createIfMissing) {
        throw new Error(`workspace ${id} not found`);
      }
    }
    if (typeof path === "string" && path.length > 0) {
      try {
        const byPath = await reg.resolveByPath(path);
        if (byPath !== undefined) return byPath;
      } catch { /* fall through to create attempt */ }
      if (createIfMissing) {
        return await reg.create(path, title);
      }
      throw new Error(`no workspace owns path '${path}'; pass createIfMissing:true to adopt it`);
    }
    throw new Error("target must be a workspaceId or a directory path");
  }

  /* ---- session_list ---- */
  const sessionListTool = {
    name: "session_list",
    description: "List persisted sessions with their workspace, archive status, tags, and title. "
      + "Filters by workspaceId, a path, archived state, or a tag. Use before move/delete/tag operations.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Restrict to one workspace by id." },
        path: { type: "string", description: "Restrict to the workspace owning this directory path." },
        archived: { type: "boolean", description: "true = only archived sessions, false = only visible ones, omitted = both." },
        tag: { type: "string", description: "Restrict to sessions carrying this tag." }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                title: { type: "string" },
                cwd: { type: "string" },
                workspaceId: { type: "string" },
                workspaceTitle: { type: "string" },
                workspacePath: { type: "string" },
                archived: { type: "boolean" },
                tags: { type: "array", items: { type: "string" } },
                createdAt: { type: "number" }
              },
              required: ["sessionId", "cwd", "archived", "tags", "createdAt"],
              additionalProperties: false
            }
          }
        },
        required: ["ok", "sessions"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        if (value.sessions.length === 0) return text("no sessions match");
        const lines = value.sessions.map((s) => {
          const ws = s.workspaceTitle ? ` [${s.workspaceTitle}]` : " [ungrouped]";
          const ar = s.archived ? " (archived)" : "";
          const tg = s.tags.length ? ` tags=${s.tags.join(",")}` : "";
          const title = s.title ? ` "${s.title}"` : "";
          return `- ${s.sessionId}${title}${ws}${ar}${tg}\n    cwd: ${s.cwd}`;
        });
        return text(`sessions (${value.sessions.length}):\n` + lines.join("\n"));
      }
    },
    async execute(args) {
      try {
        const headers = unwrapSessionHeaders(await persistence().list());
        const reg = registry();
        const workspaces = reg?.list() ?? [];
        const archivedSet = new Set(reg?.archivedSessionIds ?? []);
        const allTags = readTags();
        const wsFilter = args.workspaceId;
        let pathFilter;
        if (args.path !== undefined) {
          try { pathFilter = (await reg?.resolveByPath(args.path))?.id; } catch { pathFilter = undefined; }
          if (pathFilter === undefined) return ok({ sessions: [] });
        }
        const sessions = headers
          .map((header) => {
            const owning = [...workspaces].find((w) => w.sessionIds.includes(header.id));
            return {
              sessionId: header.id,
              title: cachedTitle(header.id),
              cwd: header.cwd ?? "",
              workspaceId: owning?.id,
              workspaceTitle: owning?.title,
              workspacePath: owning?.path,
              archived: archivedSet.has(header.id),
              tags: allTags[header.id] ?? [],
              createdAt: header.createdAt ?? 0
            };
          })
          .filter((s) => wsFilter === undefined || s.workspaceId === wsFilter)
          .filter((s) => pathFilter === undefined || s.workspaceId === pathFilter)
          .filter((s) => args.archived === undefined || s.archived === args.archived)
          .filter((s) => args.tag === undefined || s.tags.includes(args.tag))
          .sort((a, b) => b.createdAt - a.createdAt);
        return ok({ sessions });
      } catch (error) {
        return failure(error);
      }
    }
  };

  /* ---- session_move ---- */
  const sessionMoveTool = {
    name: "session_move",
    description: "Move session(s) to another workspace (cross-workspace organization). "
      + "The session log directory and its header cwd are moved on disk and the workspace "
      + "registry is updated live — the GUI reflects the change immediately, no restart. "
      + "Archived sessions may be moved too (their archive state is untouched). "
      + "Live sessions (the one you are in right now) are refused.",
    parameters: {
      type: "object",
      properties: {
        sessionIds: { type: "array", items: { type: "string" }, description: "Session ids to move." },
        targetWorkspaceId: { type: "string", description: "Destination workspace id (from session_list)." },
        targetPath: { type: "string", description: "Destination directory path; its owning workspace is used." },
        createIfMissing: { type: "boolean", description: "With targetPath: adopt the directory as a new workspace if none owns it yet." }
      },
      required: ["sessionIds"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          moved: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                from: { type: "string" },
                to: { type: "string" }
              },
              required: ["sessionId", "from", "to"],
              additionalProperties: false
            }
          },
          error: { type: "string" }
        },
        required: ["ok", "moved"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        if (value.moved.length === 0) return text("nothing to move");
        return text("moved:\n" + value.moved.map((m) => `- ${m.sessionId}\n    ${m.from} -> ${m.to}`).join("\n"));
      }
    },
    async execute(args) {
      const moved = [];
      try {
        if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
          throw new Error("sessionIds must be a non-empty array");
        }
        if (!args.targetWorkspaceId && !args.targetPath) {
          throw new Error("provide targetWorkspaceId or targetPath");
        }
        const target = await resolveTargetWorkspace({
          id: args.targetWorkspaceId,
          path: args.targetPath,
          title: args.targetPath ? basename(args.targetPath) : undefined,
          createIfMissing: args.createIfMissing === true
        });
        const root = persistence().root;
        for (const id of args.sessionIds) {
          if (isLive(id)) throw new Error(`session ${id} is live (the current conversation); refusing to move it`);
          releaseMount(id); // drop stale in-memory mounts FIRST so every later lookup reads the true on-disk location
          const header = await sessionHeader(id);
          if (header === undefined) throw new Error(`session ${id} not found`);
          const oldCwd = header.cwd;
          if (oldCwd === undefined) throw new Error(`session ${id} has no cwd; cannot move`);
          const targetCwd = target.path;
          if (oldCwd === targetCwd) {
            moved.push({ sessionId: id, from: oldCwd, to: targetCwd, note: "already there" });
            continue;
          }
          const oldDir = sessionDir(root, oldCwd, id);
          const newDir = sessionDir(root, targetCwd, id);
          if (generationLogNames(oldDir).length === 0) throw new Error(`session log missing at ${oldDir}`);
          if (existsSync(newDir)) throw new Error(`target dir already exists: ${newDir}`);
          const sourceWorkspace = await owningWorkspaceByCwd(oldCwd);
          // Rewrite the cwd in EVERY generation header (v0 AND the migrated current
          // generation). Rewriting only the v0 leaves the current header with the old
          // cwd, and dsh then reports the log as corrupt after the directory rename.
          rewriteAllGenerationHeaders(oldDir, targetCwd);
          mkdirSync(projectDir(root, targetCwd), { recursive: true }); // empty targets have no project dir yet
          renameSync(oldDir, newDir);
          for (const name of generationLogNames(newDir)) {
            const verified = verifyFullDecode(join(newDir, name));
            if (verified.frames === 0) throw new Error("post-move decode failed for " + newDir + "/" + name);
          }
          await refreshRegistryIndex();
          await target.attachSession(id);
          if (sourceWorkspace !== undefined && sourceWorkspace.id !== target.id) {
            await sourceWorkspace.detachSession(id);
          }
          updateProjectionCwd(id, targetCwd);
          releaseMount(id);
          moved.push({ sessionId: id, from: oldCwd, to: targetCwd });
        }
        return ok({ moved });
      } catch (error) {
        return failure(error);
      }
    }
  };

  /* ---- session_delete ---- */
  const sessionDeleteTool = {
    name: "session_delete",
    description: "Permanently delete session(s) and their log directories. "
      + "Optionally copies each session dir to a backup location first. "
      + "Removes the session from its workspace account and (if archived) from the archive set, "
      + "and deletes its projection-cache row and tags. Live sessions (the current conversation) are refused.",
    parameters: {
      type: "object",
      properties: {
        sessionIds: { type: "array", items: { type: "string" }, description: "Session ids to delete." },
        backupDir: { type: "string", description: "Optional: copy each session dir here before deleting (recommended)." }
      },
      required: ["sessionIds"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          deleted: { type: "array", items: { type: "string" } },
          backedUpTo: { type: "string" },
          error: { type: "string" }
        },
        required: ["ok", "deleted"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        const backup = value.backedUpTo ? `\nbacked up to: ${value.backedUpTo}` : "";
        return text("deleted:\n- " + value.deleted.join("\n- ") + backup);
      }
    },
    async execute(args) {
      const deleted = [];
      try {
        if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
          throw new Error("sessionIds must be a non-empty array");
        }
        const root = persistence().root;
        const backupDir = args.backupDir;
        if (backupDir !== undefined) mkdirSync(backupDir, { recursive: true });
        for (const id of args.sessionIds) {
          if (isLive(id)) throw new Error(`session ${id} is live (the current conversation); refusing to delete it`);
          releaseMount(id); // drop stale in-memory mounts FIRST so every later lookup reads the true on-disk location
          const header = await sessionHeader(id);
          if (header === undefined) throw new Error(`session ${id} not found`);
          const dir = sessionDir(root, header.cwd, id);
          if (!existsSync(dir)) throw new Error(`session dir missing: ${dir}`);
          if (backupDir !== undefined) {
            cpSync(dir, join(backupDir, encodeSegment(id)), { recursive: true });
          }
          const sourceWorkspace = await owningWorkspaceByCwd(header.cwd);
          if (sourceWorkspace !== undefined) await sourceWorkspace.detachSession(id);
          await removeFromArchive(id);
          try {
            storageDomain()?.get("session_projcache")?.table("sessions").delete(id);
          } catch { /* best-effort */ }
          try {
            setSessionTags(id, []);
          } catch { /* best-effort: a tags-file failure must not block the deletion */ }
          rmSync(dir, { recursive: true, force: true });
          releaseMount(id);
          deleted.push(id);
        }
        try { await refreshRegistryIndex(); } catch { /* best-effort */ }
        return ok({ deleted, ...(backupDir !== undefined ? { backedUpTo: backupDir } : {}) });
      } catch (error) {
        return failure(error);
      }
    }
  };

  /* ---- session_tag ---- */
  const sessionTagTool = {
    name: "session_tag",
    description: "Manage tags on sessions (categorization). Tags are stored in ~/.dsh/session-tags.json, "
      + "survive restarts, and ride along when sessions move across workspaces. "
      + "Actions: set (replace all), add (append), remove (drop), clear (remove all), "
      + "drop (remove the tag from EVERY session at once — the tag ceases to exist), list.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "add", "remove", "clear", "drop", "list"] },
        sessionId: { type: "string", description: "Session id; required for set/add/remove/clear." },
        tags: { type: "array", items: { type: "string" }, description: "Tag names for set/add/remove/drop." }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sessionId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          dropped: { type: "integer" },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        if (value.dropped !== undefined) return text(`dropped tag(s) ${value.tags.join(", ")} from ${value.dropped} tag instance(s)`);
        if (value.tags === undefined) return text("tags updated");
        return text(`tags (${value.tags.length}): ${value.tags.length ? value.tags.join(", ") : "(none)"}`);
      }
    },
    async execute(args) {
      try {
        const action = args.action;
        if (action === "list") {
          const all = readTags();
          return ok({ tags: Object.keys(all) });
        }
        if (action === "drop") {
          const dropped = args.tags ?? [];
          if (dropped.length === 0) throw new Error("tags are required for drop");
          const all = readTags();
          let purged = 0;
          for (const id of Object.keys(all)) {
            const before = all[id];
            const after = before.filter((t) => !dropped.includes(t));
            if (after.length !== before.length) {
              purged += before.length - after.length;
              if (after.length === 0) delete all[id];
              else all[id] = after;
            }
          }
          writeTags(all);
          return ok({ tags: dropped, dropped: purged, sessionId: "all" });
        }
        if (args.sessionId === undefined) throw new Error("sessionId is required for " + action);
        const current = sessionTags(args.sessionId);
        const incoming = args.tags ?? [];
        switch (action) {
          case "set":
            setSessionTags(args.sessionId, incoming);
            break;
          case "add":
            setSessionTags(args.sessionId, [...current, ...incoming]);
            break;
          case "remove":
            setSessionTags(args.sessionId, current.filter((t) => !incoming.includes(t)));
            break;
          case "clear":
            setSessionTags(args.sessionId, []);
            break;
          default:
            throw new Error("unknown action: " + action);
        }
        return ok({ sessionId: args.sessionId, tags: sessionTags(args.sessionId) });
      } catch (error) {
        return failure(error);
      }
    }
  };

  /* ---- session_archive ---- */
  const sessionArchiveTool = {
    name: "session_archive",
    description: "Archive a session (hides it from every grouping surface; the log and workspace account "
      + "slot are preserved). Wraps the workspace registry's own archive API — identical to the GUI archive "
      + "menu, idempotent for already-archived ids.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id to archive." }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sessionId: { type: "string" },
          archivedSessionIds: { type: "array", items: { type: "string" } },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        return text(`archived ${value.sessionId} (${value.archivedSessionIds.length} archived total)`);
      }
    },
    async execute(args) {
      try {
        const reg = registry();
        if (reg === undefined) throw new Error("workspace registry service unavailable");
        await reg.archiveSession(args.sessionId);
        return ok({ sessionId: args.sessionId, archivedSessionIds: reg.archivedSessionIds });
      } catch (error) {
        return failure(error);
      }
    }
  };

  /* ---- session_unarchive ---- */
  const sessionUnarchiveTool = {
    name: "session_unarchive",
    description: "Restore an archived session so it reappears in its workspace grouping. "
      + "The GUI only offers archive; this tool adds the missing restore direction. "
      + "The workspace accounting slot is preserved by the archive design, so the session "
      + "reappears in its original position.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id to restore." }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sessionId: { type: "string" },
          archivedSessionIds: { type: "array", items: { type: "string" } },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render: (_args, value) => {
        if (!value.ok) return text("error: " + value.error);
        return text(`restored ${value.sessionId} (${value.archivedSessionIds.length} archived remaining)`);
      }
    },
    async execute(args) {
      try {
        await removeFromArchive(args.sessionId);
        const reg = registry();
        return ok({ sessionId: args.sessionId, archivedSessionIds: reg?.archivedSessionIds ?? [] });
      } catch (error) {
        return failure(error);
      }
    }
  };

  return [
    sessionListTool,
    sessionMoveTool,
    sessionDeleteTool,
    sessionTagTool,
    sessionArchiveTool,
    sessionUnarchiveTool
  ];
}

/* ------------------------------------------------------------------ */
/* browser REST API (same-origin, loopback-only; funnel through tools) */
/* ------------------------------------------------------------------ */

/** Loopback literal check plus browser same-origin markers (mirrors the pairing routes' fence). */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  });
  res.end(payload);
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > 1_000_000) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Build the browser REST routes; each handler funnels through the tool's execute. */
function makeRoutes(tools, ctx) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  /** Guard helper: fence + method check. */
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "forbidden: loopback-only" });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  };
  /** Run one tool with JSON args; 200 with its value on success, 400 on business failure. */
  const runTool = async (req, res, toolName, args) => {
    try {
      const tool = byName.get(toolName);
      if (tool === undefined) {
        writeJson(res, 404, { error: `tool ${toolName} not found` });
        return;
      }
      const result = await tool.execute(args);
      const status = result && result.ok === true ? 200 : 400;
      writeJson(res, status, result);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const routes = [];
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/sessions",
    handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      await runTool(req, res, "session_list", {});
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/tags",
    handler: async (req, res) => {
      if (req.method === "GET") {
        if (!guard(req, res, "GET")) return;
        const raw = readTags();
        const normalized = {};
        for (const [id, list] of Object.entries(raw)) {
          if (Array.isArray(list)) normalized[id] = [...new Set(list.filter((t) => typeof t === "string" && t.length > 0))];
        }
        writeJson(res, 200, { tags: normalized });
        return;
      }
      if (req.method === "PUT") {
        if (!guard(req, res, "PUT")) return;
        const body = await readJsonBody(req);
        if (body === undefined || typeof body.sessionId !== "string") {
          writeJson(res, 400, { ok: false, error: "sessionId (string) is required" });
          return;
        }
        const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [];
        setSessionTags(body.sessionId, tags);
        writeJson(res, 200, { ok: true, sessionId: body.sessionId, tags: sessionTags(body.sessionId) });
        return;
      }
      if (req.method === "DELETE") {
        if (!guard(req, res, "DELETE")) return;
        const body = await readJsonBody(req).catch(() => undefined);
        const dropped = Array.isArray(body?.tags) ? body.tags.filter((t) => typeof t === "string" && t.length > 0) : [];
        if (dropped.length === 0) {
          writeJson(res, 400, { ok: false, error: "tags (string array) is required" });
          return;
        }
        const all = readTags();
        let purged = 0;
        for (const id of Object.keys(all)) {
          const after = all[id].filter((t) => !dropped.includes(t));
          if (after.length !== all[id].length) {
            purged += all[id].length - after.length;
            if (after.length === 0) delete all[id];
            else all[id] = after;
          }
        }
        writeTags(all);
        writeJson(res, 200, { ok: true, tags: dropped, dropped: purged });
        return;
      }
      writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/sessions/move",
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      await runTool(req, res, "session_move", {
        sessionIds: body.sessionIds,
        targetWorkspaceId: body.targetWorkspaceId,
        targetPath: body.targetPath,
        createIfMissing: body.createIfMissing
      });
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/sessions/delete",
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      await runTool(req, res, "session_delete", {
        sessionIds: body.sessionIds,
        backupDir: body.backupDir
      });
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/sessions/archive",
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined || typeof body.sessionId !== "string") {
        writeJson(res, 400, { ok: false, error: "sessionId (string) is required" });
        return;
      }
      await runTool(req, res, "session_archive", { sessionId: body.sessionId });
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/sessions/unarchive",
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined || typeof body.sessionId !== "string") {
        writeJson(res, 400, { ok: false, error: "sessionId (string) is required" });
        return;
      }
      await runTool(req, res, "session_unarchive", { sessionId: body.sessionId });
    }
  });
  routes.push({
    kind: "exact",
    path: "/api/dsh-session-manager/projcache/warm",
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      try {
        const report = await warmProjectionTitles(ctx);
        writeJson(res, 200, { ok: true, report });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  return routes;
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

const SESSION_MANAGER_GUIDANCE = [
  "You can manage DSH sessions directly:",
  "- `session_list` — inspect sessions (workspace, archive state, tags, title).",
  "- `session_move` — organize sessions across workspaces (live, no restart).",
  "- `session_delete` — permanently delete sessions (pass backupDir to keep a copy first).",
  "- `session_tag` — categorize sessions with tags (stored in ~/.dsh/session-tags.json).",
  "- `session_archive` / `session_unarchive` — hide / restore sessions.",
  "Never move or delete a live session (the current conversation); the tools refuse them."
].join("\n");

function apply(ctx) {
  // 【2026-09-12】前端自愈已退役：标签/删除/拖拽/分组 UI 已迁到独立插件 dsh-session-tree
  // （自带 lib/client.js，不再替换官方 dsh-client-ui-workspace/lib/client.js），
  // 旧的整包还原脚本 session-manager-ui-repatch.mjs 与备份文件同时下线。
  // 本插件（host 侧）必须保留：dsh-session-tree 的浏览器端仍调用 /api/dsh-session-manager/*。
  try {
    const tools = makeTools(ctx);
    ctx.effect(() => {
      const disposers = tools.map((tool) => ctx.tools.register(tool));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "session-manager: tools");
    try {
      ctx.systemPrompt?.section({
        name: "plugin:session-manager",
        order: 900,
        text: SESSION_MANAGER_GUIDANCE
      });
    } catch { /* guidance is optional */ }
    try {
      const webServer = ctx.get("webServer");
      if (webServer !== undefined) {
        const routes = makeRoutes(tools, ctx);
        ctx.effect(() => {
          const disposers = routes.map((route) => webServer.register(route));
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, "session-manager: routes");
      }
    } catch (error) {
      ctx.logger?.warn?.("[session-manager] REST API unavailable: " + String(error));
    }
    // 启动预热：给冷会话补 projcache 标题行（非 seeded 会话的标题靠它）。
    setTimeout(() => {
      warmProjectionTitles(ctx).catch(() => {});
    }, 800);
  } catch (error) {
    ctx.logger?.warn?.("[session-manager] failed to initialize: " + String(error));
  }
}

/**
* Warm the session-projection cache for persisted sessions that lack a
* checkpoint row. Returns a diagnostic report (also used by the REST
* endpoint); the apply-time call is fire-and-forget, everything fail-soft.
*
* Why this is required: the host's `session.list` has NO title for cold
* (not-yet-opened) sessions — the wire summary carries only
* sessionId/updatedAt/running/blank/cwd, and the durable title is served
* through the `projections` block, which for cold rows is read from the
* projcache checkpoint (`sessionProjectionCache.cachedSnapshot`). A session
* only receives a checkpoint row when it was ever attached in some process
* (the write-behind fires on session/event / dispose). After a web restart,
* every session the user has not opened in the new process is cold, and
* sessions that were never attached in ANY process have no projcache row at
* all — the frontend then falls back to the workspace directory basename for
* the title ("工作区名称") until the user opens the session once.
*
* The official `coldSnapshot(id)` restores the projections from the persisted
* log tail and writes the checkpoint back (putSoft, "cold-read write-back"),
* so the next cold list read serves the title. Pre-warming every persisted
* session that lacks a title row makes the post-restart list show real titles
* immediately, with zero reads on the listing path afterwards.
* @param ctx - the cordis context.
* @returns the diagnostic report:
*   { serviceAvailable, persisted, checked, warmed, skippedAttached, skippedTitlePresent, failed: [{id, error}] }
*/
/**
 * 0.1.5 兼容：读取某个持久化会话的完整事件日志。
 *
 * 新版持久化层移除了 `readFrom(id, offset)`，改为 `open(id)` 返回
 * SessionHandle，再用 `handle.read(offset)` 取切片（读句柄，纯读）。
 * 旧版（<=0.1.1）保留 readFrom 分支，便于回退。
 * @returns 事件数组；读不到时返回 undefined（调用方保守跳过）。
 */
async function readWholeLog(persistenceSvc, sessionId) {
  return readLogFrom(persistenceSvc, sessionId, 0);
}

/**
 * 0.1.5 兼容：从指定 offset 起读取某会话的事件日志切片。
 * @returns 事件数组；读不到时返回 undefined（调用方保守跳过）。
 */
async function readLogFrom(persistenceSvc, sessionId, offset) {
  if (persistenceSvc === undefined || persistenceSvc === null) return undefined;
  // 旧版：readFrom(id, offset) -> { events }
  if (typeof persistenceSvc.readFrom === "function") {
    try {
      const r = await persistenceSvc.readFrom(sessionId, offset);
      return Array.isArray(r?.events) ? r.events : undefined;
    } catch {
      return undefined;
    }
  }
  // 0.1.5：open(id) -> handle.read(offset)
  if (typeof persistenceSvc.open === "function") {
    let handle;
    try {
      handle = await persistenceSvc.open(sessionId);
      const r = await handle.read(offset);
      return Array.isArray(r?.events) ? r.events : undefined;
    } catch {
      return undefined;
    } finally {
      try { await handle?.close?.(); } catch { /* 读句柄关闭失败不影响结果 */ }
    }
  }
  return undefined;
}

/**
 * 2026-10-10 性能开关：投影缓存标题预热的「日志尾巴探测」。
 *
 * 背景：apply 时（延迟 800ms）fire-and-forget 调用 warmProjectionTitles，它会
 * 先 persistence.list() 全量扫盘，再对每个「已有标题行」的会话调用 readLogFrom
 * 读一次日志尾巴来判定该行是否新鲜。标题行一旦写过就长期存在，于是**每次启动**
 * 都会对全部（约 620 个）会话各做一次日志读——这是「启动后会话列表加载慢」的主因。
 *
 * 关掉探测后：已有非空标题行的会话直接视为 warm（跳过读日志）；只有**没有**标题行
 * 的会话才会走下面的 coldSnapshot 全量预热——功能主体保留。
 * 代价：投影缓存写入失败窗口内发生的改名，不再于启动时被自动纠正；但按原注释，
 * 打开该会话时的官方冷读阶梯仍会自愈。需要恢复原行为把此值改为 true。
 */
const WARM_TAIL_PROBE = false;

async function warmProjectionTitles(ctx) {
  const report = {
    serviceAvailable: false,
    persisted: 0,
    checked: 0,
    warmed: 0,
    skippedAttached: 0,
    skippedTitlePresent: 0,
    failed: []
  };
  try {
    const persistenceSvc = ctx.get("sessionPersistence");
    const cacheSvc = ctx.get("sessionProjectionCache");
    if (persistenceSvc === undefined || cacheSvc === undefined) {
      ctx.logger?.warn?.("[session-manager] projcache warm: sessionProjectionCache service unavailable: " + String(cacheSvc) + " persistence=" + String(persistenceSvc !== undefined));
      return report;
    }
    report.serviceAvailable = true;
    const sessionsSvc = ctx.get("sessions");
    const domain = ctx.get("storageDomain");
    const metas = unwrapSessionHeaders(await persistenceSvc.list());
    report.persisted = metas.length;
    for (const meta of metas) {
      try {
        report.checked += 1;
        if (sessionsSvc?.get?.(meta.id) !== undefined) {
          report.skippedAttached += 1;
          continue; // attached: live snapshot already carries the title
        }
        const table = domain?.get?.("session_projcache")?.table("sessions");
        const record = table?.get?.(meta.id);
        if (typeof record?.rows?.title?.val === "string" && record.rows.title.val.length > 0) {
          if (!WARM_TAIL_PROBE) {
            // 已有非空标题行且未开启尾巴探测：直接视为 warm。
            // 省掉「每个会话一次日志尾读」——这是启动后列表慢的主要开销。
            report.skippedTitlePresent += 1;
            continue;
          }
          // 行存在 ≠ 行新鲜：投影缓存断档期（写入失败窗口）发生的改名/LLM 重写
          // 不会体现在旧行里。从行水位起读日志尾巴，发现更新的 session/title
          // 事件才落到 coldSnapshot 刷新该行；尾巴干净才算 already warm。
          // 水位要用 **title 行自身** 的 seq：用 min(所有行) 会把 title 行自己那条
          // session/title 事件也算成「更新的标题事件」，让这行每次启动都被重刷
          // 而永不收敛（实测 warmed 恒为 7）。从 title 行的 seq+1 起读，
          // 只有真正更晚的标题事件才算 fresh。
          const titleRowSeq = typeof record.rows.title.seq === "number" ? record.rows.title.seq : undefined;
          const seqs = Object.values(record.rows ?? {}).map((row) => (typeof row?.seq === "number" ? row.seq : 0));
          if (titleRowSeq !== undefined || seqs.length > 0) {
            try {
              const floor = titleRowSeq !== undefined
                ? titleRowSeq + 1
                : Math.max(Math.min(...seqs), 0);
              const tailEvents = await readLogFrom(persistenceSvc, meta.id, floor);
              if (tailEvents === undefined) {
                report.skippedTitlePresent += 1;
                continue; // 探测失败保守跳过；打开该会话时的冷读 ladder 仍会自愈
              }
              if (!tailEvents.some((event) => event?.type === "session/title")) {
                report.skippedTitlePresent += 1;
                continue; // 行已是最新（日志尾巴没有更新的标题事件）
              }
            } catch {
              report.skippedTitlePresent += 1;
              continue; // 探测失败保守跳过；打开该会话时的冷读 ladder 仍会自愈
            }
          }
          // 日志尾巴有更新的标题事件 → 落到下方 coldSnapshot 刷新该行
        }
        // 0.1.5 起 coldSnapshot 变成同步三参 (meta, inheritedEventCount, events)，
        // 需要该会话的完整事件日志；旧的两参调用会静默失效（预热整体不再生效）。
        // 按新签名重建：读全量事件后交给官方 restore，由它写回 checkpoint 行。
        if (cacheSvc.coldSnapshot.length >= 3) {
          const events = await readWholeLog(persistenceSvc, meta.id);
          if (events === undefined || events.length === 0) {
            report.skippedTitlePresent += 1;
            continue; // 无事件可折：保持原状，打开该会话时官方冷读阶梯仍会自愈
          }
          // 日志里从来没有 session/title 事件（全新空白会话）：重刷也产不出标题，
          // 只会每次启动空转重写缓存行。跳过，打开该会话并由官方 fallback 生成后自然会自愈。
          if (!events.some((event) => event?.type === "session/title")) {
            report.skippedTitlePresent += 1;
            continue;
          }
          const inherited = typeof meta.inheritedEventCount === "number"
            ? meta.inheritedEventCount
            : (typeof record?.identity?.inheritedEventCount === "number" ? record.identity.inheritedEventCount : 0);
          cacheSvc.coldSnapshot(meta, inherited, events);
          report.warmed += 1;
          continue;
        }
        await cacheSvc.coldSnapshot(meta.id);
        report.warmed += 1;
      } catch (error) {
        report.failed.push({ id: meta.id, error: error instanceof Error ? error.message : String(error) });
        ctx.logger?.warn?.(`[session-manager] projcache warm failed for ${meta.id}: ${String(error)}`);
      }
    }
    ctx.logger?.info?.("[session-manager] projcache title warm-up finished: " + JSON.stringify(report));
  } catch (error) {
    report.failed.push({ id: "(run)", error: error instanceof Error ? error.message : String(error) });
    ctx.logger?.warn?.("[session-manager] projcache title warm-up unavailable: " + String(error));
  }
  return report;
}

apply.inject = ["tools", "workspaceRegistry", "storageDomain", "sessionPersistence", "systemPrompt", "webServer"];

export default apply;
