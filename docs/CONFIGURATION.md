# Configuration

The plugin takes a single options object in `opencode.json` (project or global
`~/.config/opencode/opencode.json`). Everything is optional; unset options use
documented defaults. Options travel in a package-and-options tuple under the
`plugin` key (OpenCode 1.x), shown in the reference below; on 2.x hosts the same
options object is passed through the `plugins` key.

## Reference

```json
{
  "plugin": [
    ["@log0u7/opencode-mesh", { "dataDir": "/srv/mesh-data", "port": 4399, "bind": "lan", "advertise": true }]
  ]
}
```

On OpenCode 2.x hosts the key is `plugins` and each entry is an object with
`package` and `options`:

```json
{
  "plugins": [
    { "package": "@log0u7/opencode-mesh", "options": { "dataDir": "/srv/mesh-data", "bind": "lan" } }
  ]
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dataDir` | `string` | `os.homedir()/.local/share/opencode-mesh` | Directory holding `node.json`, `mesh.db` and `workers/`. The directory is created with mode `0700` on first run. Honors `XDG_DATA_HOME`. |
| `port` | `number` | `4399` | Port the mesh HTTP server listens on. Not an integer in `[0, 65535]`: setup fails. When taken (two OpenCode sessions on one machine), the server falls back to an ephemeral port instead of colliding. |
| `bind` | `"loopback" \| "lan"` | `"loopback"` | `"loopback"` binds `127.0.0.1` (the mesh API stays local); `"lan"` binds `0.0.0.0` for a LAN or tailnet pool. Anything else fails setup. |
| `advertise` | `boolean` | `true` | Advertise over mDNS (and browse for peers). `false` disables both: the node then pairs only through exchanged `mesh_pair` offers. |
| `worktreeClient` | object | none | **Test/injection only.** A REST-shaped worktree client the tools use instead of the host's worktree domain. Not a supported user option. |
| `spawnFn` | function | `nodeSpawn` | **Test/injection only.** Replaces the child-process spawn for workers. Not a supported user option. |

Invalid options fail fast: the plugin throws during setup with a message naming
the offending field, and the mesh never half-starts (no identity, database or
server is touched before validation).

## Environment

- `XDG_DATA_HOME`: preferred base for the data dir (default `~/.local/share`).
- `HOME`: user home, for the default data dir; falls back to `os.homedir()`,
  then `os.tmpdir()` when unset or blank.
- `OPENCODE_MESH_CHILD=1`: set by `mesh_spawn`; a child process that boots the
  plugin skips the mesh server, mDNS and tool registration.