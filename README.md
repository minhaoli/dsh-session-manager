# dsh-session-manager

Agent tools and a loopback REST API for DSH session housekeeping — list, move across workspaces, delete with an optional backup, tag, archive and unarchive.

DSH's own GUI covers only part of this surface (it can archive, but not unarchive; it has no tags; cross-workspace moves need a restart). This plugin puts the whole surface on two rails that share one implementation:

- **Agent tools** — six tools the model can call directly.
- **Loopback REST API** — the same six operations over HTTP, so a browser plugin can drive them without an IPC bridge. [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) uses this to render tags, drag-and-drop and the archive menu in the sidebar.

## Requirements

| | |
|---|---|
| DSH | `0.2.1-rc.2` (developed and tested against it) |
| `@deepseek-ai/cordis` | `~4.0.5` |
| Runtime | Node.js 22+ (ships with the DSH desktop runtime) |

Earlier DSH releases are untested. The plugin reads `workspaceRegistry`, `sessionPersistence`, `storageDomain` and `webServer`; a release that renames or removes any of those will make the corresponding feature fail soft (logged as a warning) rather than crash the host.

## Install

```bash
# from git (recommended)
dsh plugin --profile <your-profile> add github:minhaoli/dsh-session-manager

# or from a local checkout
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-session-manager
```

`<your-profile>` is the profile you actually boot — `desktop` for the Electron app, `web` / `headless` / `node` for the CLI modes. The `desktop` profile is managed by the Electron app and refuses `dsh` CLI writes while the app is running; install into it from the app's own plugin manager, or close the app first.

The package declares `dsh.bundle.patch`, so `dsh plugin add` also appends it to `dsh.profile.bundles` and the loader mounts it on the next start. If you installed by hand, add the row yourself:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-manager
      name: 'dsh-session-manager'
```

## Agent tools

All six take JSON arguments and return `{ ok: true, ... }` or `{ ok: false, error }`.

| Tool | Purpose |
|---|---|
| `session_list` | Enumerate persisted sessions with workspace, archive state, tags and title. Filters: `workspaceId`, `path`, `archived`, `tag`. |
| `session_move` | Move sessions across workspaces. Rewrites the log header `cwd` and renames the directory on disk, then updates the registry live — the GUI reflects it without a restart. |
| `session_delete` | Permanently delete sessions and their log directories. Pass `backupDir` to copy each directory first. |
| `session_tag` | `set` / `add` / `remove` / `clear` / `drop` / `list` tags. Stored in `~/.dsh/session-tags.json`. |
| `session_archive` | Hide a session from every grouping surface; log and workspace slot preserved. Idempotent. |
| `session_unarchive` | Restore an archived session to its original position — the direction the GUI is missing. |

Live sessions (the conversation the model is currently running in) are refused by `session_move` and `session_delete`.

## REST API

Registered only when the `webServer` service is present (the `web` and `desktop` modes). Every handler funnels through the corresponding tool's `execute`, so both surfaces behave identically.

Every request is fenced by `isLoopbackRequest(req)` — a non-loopback peer gets `403 {"error":"forbidden: loopback-only"}`. There is no token; the fence is the transport, not a credential. Do not expose the DSH web server beyond localhost while this plugin is mounted.

| Method | Path | Body / query |
|---|---|---|
| `GET` | `/api/dsh-session-manager/sessions` | — |
| `GET` | `/api/dsh-session-manager/tags` | — |
| `PUT` | `/api/dsh-session-manager/tags` | `{ "sessionId": "...", "tags": ["a","b"] }` |
| `DELETE` | `/api/dsh-session-manager/tags` | `{ "tags": ["a"] }` — drops those tags from every session |
| `POST` | `/api/dsh-session-manager/sessions/move` | `{ "sessionIds": [...], "targetWorkspaceId": "..." }` or `{ ..., "targetPath": "...", "createIfMissing": true }` |
| `POST` | `/api/dsh-session-manager/sessions/delete` | `{ "sessionIds": [...], "backupDir": "..." }` (`backupDir` optional) |
| `POST` | `/api/dsh-session-manager/sessions/archive` | `{ "sessionId": "..." }` |
| `POST` | `/api/dsh-session-manager/sessions/unarchive` | `{ "sessionId": "..." }` |
| `POST` | `/api/dsh-session-manager/projcache/warm` | — (diagnostics: returns the title warm-up report) |

Status codes: `200` when the tool returned `ok: true`, `400` for a business failure or a malformed body, `403` off-loopback, `405` wrong method, `500` unexpected throw.

Request bodies are capped at 1 MB and must be JSON objects.

```bash
curl -s http://127.0.0.1:3080/api/dsh-session-manager/tags
curl -s -X PUT http://127.0.0.1:3080/api/dsh-session-manager/tags \
  -H 'content-type: application/json' \
  -d '{"sessionId":"abc123","tags":["research","todo"]}'
```

## Behaviour worth knowing

**Moves keep three things in sync.** The physical move (zstd header rewrite plus directory rename) is followed by a registry header re-index and the public `attachSession` / `detachSession` calls, and the projection cache's `identity.cwd` is updated through the storage-domain table handle. Skipping any of the three leaves the GUI showing a stale path.

**Titles are pre-warmed at startup.** `session.list` carries no title for a cold session; the durable title lives in the projection-cache checkpoint, which is only written when a session was attached in some process. After a restart every unopened session is cold and the sidebar falls back to the directory basename. 800 ms after mount the plugin walks persisted sessions lacking a title row and calls the official `coldSnapshot(meta, inheritedEventCount, events)` to write the checkpoint back.

The tail probe that validates an existing title row is **off** (`WARM_TAIL_PROBE = false` in `lib/index.js`). With it on, every start re-read the log tail of all sessions — the dominant cost of a slow sidebar after a restart, at roughly 620 sessions. The trade-off: a rename that happened during a projection-cache write failure window is no longer corrected at startup; the official cold-read ladder still heals it when the session is opened. Set the constant to `true` to restore the old behaviour.

**Archive goes through the registry.** Archiving funnels through `archiveSession()` — the same add-only API the GUI uses. The plugin never rewrites the archive set except on an explicit delete or unarchive, and even then it goes through the registry's public `enqueueOperation` / `setState` write chain so the registry's cached state stays coherent.

**Zero imports by design.** `lib/index.js` uses only `node:` builtins. The file plugin is loaded by native dynamic import, so a bare specifier would have to resolve from the profile's `node_modules`; the builtin-only rule keeps it loadable as a standalone file plugin (the same shape as `zen-useragent.js`).

## Companion plugins

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) — the sidebar UI (tags, grouping, drag-to-move, delete) that consumes this REST API. It replaces the official `ui-workspace` bundle, so disable that row when both are installed.
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) — semantic session search backend.
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) — in-conversation find bar.
- [`dsh-ui-reload`](https://github.com/minhaoli/dsh-ui-reload) — one-click frontend reload button.

## License

MIT — see [LICENSE](./LICENSE).
