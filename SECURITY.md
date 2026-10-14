# Security Policy

## Reporting a vulnerability

Do not open a public issue for security problems.

Use GitHub private vulnerability reporting: repository page -> Security -> Report a vulnerability. Include reproduction steps, affected versions, and impact. You will get an acknowledgment within 72 hours.

## Scope

- The plugin runs locally with your user privileges. Report anything that lets mesh messages escape the local store, execute code, or read files beyond intended scope.
- The store intentionally contains model-written text. Treat untrusted-content handling (injection from received messages into future sessions) as in scope.

## Hardening notes

- The mesh has no credential filtering or secret scanning: anything a model
  writes to `mesh_send` is stored and relayed as-is. Do not save credentials
  through the model.
- Data path: `~/.local/share/opencode-mesh/` (honors `XDG_DATA_HOME`). The
  directory is created with mode `0700` on first run, so access is protected at
  the directory level. The SQLite file itself is not `chmod`ed: do not point
  `dataDir` at a shared or group-readable location.
- Messages travel over plain HTTP between peers: there is no TLS on the wire.
  Restrict the mesh to loopback or networks you control.
