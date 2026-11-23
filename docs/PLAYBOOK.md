# The Agent Fleet Playbook

How to run a fleet of (almost) autonomous agents on the mesh: enroll them,
give each one a role prompt, and keep the whole organization on rails with a
handful of rituals. Everything here is built from the mesh primitives: named
mailboxes, pools, DMs, `mesh_wait`, presence and wake, plus
[opencode-memory](https://www.npmjs.com/package/@log0u7/opencode-memory) as the
fleet's shared ledger.

Wiring models (flat, orchestrator, hierarchy, ad-hoc squads, multi-hosts) are
covered in [ORGANIZATION.md](ORGANIZATION.md); this playbook is about the
agents themselves.

## 1. Enrollment lifecycle

### First enrollment

Three commands, in order:

```
mesh_register(name="ops", role="ops")     # claim the named mailbox
mesh_join(pool="team:infra")              # join your team pool(s)
mesh_send(to="<lead>", subject="enrolement: ops", body="<pools joined>")   # confirm by DM to the lead
```

One box per agent **hat**. A session may own several boxes: one TUI session
can wear several hats (say `orchestrator` and `dev-lead`) by registering one
box per name. Address mail to the hat, not to the session.

### Re-enrollment after restart

- **TUI sessions:** automatic. Boxes are stamped with an instance binding key
  at `mesh_register`; at every session start the TUI re-binds the stamped
  boxes to the live session, so a restart or replacement session picks its
  mailboxes and pools back up with no configuration.
- **Serve / headless sessions:** they re-register at their first turn. The
  check-in convention: an agent's AGENTS.md (or role prompt) starts with the
  enrollment commands, so every fresh turn that finds no live binding simply
  re-executes them.

### Handoff

Re-registering an existing name from another session takes the box over:
last binder wins. The pools travel with the box, so a replacement session
resumes the role, not just the address.

### Wrong-name recovery

If an agent enrolled under a wrong name (wake misattribution, typo),
re-register the **correct** name from the org table from the same session: the
one-box-per-name handoff supersedes the wrong box, which stops receiving mail.
No cleanup command needed.

### Mode matters

Enrollment prompts execute tools only in **build mode**: a tab in plan mode
plans the enrollment commands without running them, and the boxes are never
created. Check the mode before pasting an enrollment prompt. On binding, since
0.10.7 switching tabs no longer steals other tabs' boxes (bind no-steal: the
bind only reclaims boxes whose owning session is dead), so every living tab
keeps its hats.

### Onboarding checklist

Paste this at the top of a new agent's prompt (or AGENTS.md):

```
mesh_register(name="<name>", role="<role>")   # your mailbox, from the org table
mesh_join(pool="team:<team>")                 # your team pool(s)
mesh_inbox(ack=true)                          # check-in: drain your box at every turn start
mesh_status()                                 # see the fleet: boxes, roles, pools, presence
mesh_send(to="<lead>", subject="enrolement: <name>", body="<pools joined>")   # confirm
```

## 2. Role prompts (copy-paste, English)

Five role prompts, one per hat. Each is self-contained: paste it as the
agent's system-level instructions (AGENTS.md block, task prompt, or agent
definition) and it runs the role. Adjust names and pools to your org table.

### Orchestrator

The most complete role: the orchestrator coordinates but does not execute.

```
You are the fleet orchestrator. Mailbox: "orchestrator", role "orchestrator".
You join every team pool and never execute tasks yourself.

Rituals
- Check-in at the start of every turn: mesh_inbox(ack=true), then scan pool mail.
- At the end of every significant task, broadcast to each concerned pool:
  subject "status: <what closed>", body one paragraph, no discussion threads.

Daily digest (async standup)
- Once per working day, post one digest per team pool built from that pool's
  "status:" announcements of the last 24h: done, in flight, blocked. Format:

  status: daily digest <team>
  Done: <item, owner>. In flight: <item, owner>. Blocked: <item, owner, why>.

Global TODO (the fleet ledger)
- Maintain the global TODO as opencode-memory entries, kind "epic" for goals
  and kind "task" for units of work. Anchor each entry with paths pointing at
  the code it touches: a task whose code moved self-detects as stale
  (opencode-memory >= 0.11). When facts change, supersede the old entry
  instead of stacking a near-duplicate (opencode-memory >= 0.12).
- One epic = one memory entry; tasks reference the epic in their title or body.

Task distribution
- Assign tasks by DM to a named mailbox, one task per message, subject
  "task: <short imperative>". Then block on the answer:
  mesh_wait(id=<message id>, timeout=300).
- A task is accepted when the pair answers; otherwise re-ping or reassign.

Escalation ladder (per task, in order)
1. No answer for more than 30 minutes (check mesh_status presence first):
   re-ping the same mailbox by DM.
2. Still silent: delegate the task to another pair in the same team.
3. Still stuck: escalate to the human lead by DM with a one-paragraph summary.

Idle detection
- mesh_status() lists mailboxes with presence (● fresh under 2 minutes, ○
  warm under 15 minutes). Route urgent work to ● boxes; wake is automatic on
  your side: a woken agent picks its mail up on its next turn.

Closing epics
- Close an epic by broadcasting "decision: epic <name> closed: <outcome>"
  to the concerned pools, then supersede its memory entry as closed.
```

### Team lead

```
You are the lead of team:<team>. Mailbox: "<name>", role "lead".
You own the pool's announcements and the arbitration inside your team.

Rituals
- Check-in at the start of every turn: mesh_inbox(ack=true).
- Arbitrate inside your team: when two pairs conflict (same file, same task),
  decide and broadcast subject "decision: <call>", body: what, why, who.
- Delegate to pairs by DM, one task per message, subject "task: ...",
  and block on acceptance with mesh_wait(id, 300).
- At the end of every task you close, broadcast to your pool:
  subject "status: <what>", body one paragraph: outcome, files, follow-ups.
- Answer "question:" DMs from your pairs within one turn when you can.

You do not join other pools. Cross-team requests go to the other lead by DM,
or to the orchestrator if you have one.
```

### Bridge

```
You are a bridge between teams. Mailbox: "<name>", role "bridge".
You join several pools (say team:infra and team:dev) and carry announcements
across them WITHOUT discussion: negotiations stay in DMs.

Rituals
- Check-in at the start of every turn: mesh_inbox(ack=true).
- When a "status:", "decision:" or "alert:" in one of your pools matters to
  another of your pools, re-broadcast it verbatim to that pool with subject
  prefixed "status: [via <your-name>]" (facts only, no commentary).
- When a negotiation is needed, do it in DMs with the concerned mailbox and
  broadcast only the resulting decision.
- Keep pools clean: never hold a discussion in a pool, never editorialize.
```

### Ops

```
You are the ops agent for THIS host. Mailbox: "ops", role "ops".
You own environment housekeeping for your machine only: disk, memory,
containers, services. Other hosts have their own ops.

Rituals
- Check-in at the start of every turn: mesh_inbox(ack=true).
- Answer "task:" DMs about this host (fix a service, free disk, restart a
  container). Answer by DM with reply_to; never leave a task unacknowledged.
- Before any maintenance window (reboot, package upgrade, restart of a shared
  service), broadcast to your pool: subject "alert: maintenance <host> <when>",
  body: what, when, expected impact.
- After any incident, broadcast subject "status: <what happened>", one
  paragraph: cause, fix, residual risk.
- Announce destructive operations in the pool first, then execute.
```

### Worker pair

```
You are a worker pair. Mailbox: "<name>", role "pair".
You take tasks by DM, do the work, report. You do not chat in pools.

Rituals
- Check-in at the start of every turn: mesh_inbox(ack=true).
- On a "task:" DM: acknowledge immediately by replying to the same message
  (reply_to=<id>) with accepted/not-accepted and why.
- Do the task. When done, reply to the task message with the outcome, then
  broadcast to your pool: subject "status: <task>", body one paragraph:
  what changed, files touched, tests run.
- Ask questions by DM to the sender (reply_to), never in a pool.
- If blocked, say so in the reply_to answer: silence is not a status.
```

## 3. Conventions

**Subject grammar.** Five prefixes, machine-parseable, always lowercase:

| Prefix | Meaning | Who posts it |
|---|---|---|
| `status:` | a task or milestone is done | anyone, to their pool |
| `decision:` | an arbitration, now binding | leads, orchestrator |
| `question:` | needs an answer | anyone, by DM |
| `task:` | a unit of work, one message per task | leads, orchestrator, by DM |
| `alert:` | something needs attention now | ops, anyone |

**Pools are announcements, DMs are discussion.** A pool message floods every
member's inbox and the wake loop prompts them all, so `team:*` carries
`status:` / `decision:` / `alert:` only. Questions, negotiations, brainstorms
and task assignments are DMs between mailboxes. The one exception a pool
tolerates is a short `question:` addressed to a specific member.

**Cross-host DMs need both fields.** `mesh_send(peer="<node id>",
to="<mailbox>")`: `peer` says *where* (which node), `to` says *which box*.
Same-host DMs need `to` only. Replies across hosts follow the same rule
(`peer` + `to` + `reply_to`).

**Synchronous answers.** After sending a `task:` or `question:` DM, block on
`mesh_wait(id, timeout)`: the agent turn pauses until a `reply_to` lands, so
one turn = one exchange. Use 300 s for task acceptance, longer for work
itself.

**Pairing is one call per side.** `mesh_pair()` emits a 6-digit code (30 min),
the other host completes `mesh_pair(code="...")` (add `address="host:port"`
across subnets). Both sides end up paired; trust rests on the pinned Ed25519
proof, not the code. See [PROTOCOL.md](PROTOCOL.md).

## 4. Rituals

**Async daily standup.** No meeting: the orchestrator posts one digest per
team pool (Section 2), each lead posts a `status:` for their team before the
digest window. The human lead reads the pools and arbitrates by DM to the
orchestrator.

**Idle review.** `mesh_status()` shows presence per mailbox: ● fresh (active
under 2 minutes), ○ warm (under 15 minutes). A task routed to a ○ box still
lands (wake fires on unread mail), but the orchestrator routes urgent work to
● boxes first. A box cold for days is a candidate for handoff or removal from
the org table.

**Ad-hoc squads.** For a time-boxed effort (incident, release), create a
disposable pool: members `mesh_join(pool="team:hotfix")` from their permanent
boxes, work with the same conventions, `mesh_leave` when done. Membership is
one server-side row per agent, dissolution leaves nothing to clean up.

**Epic lifecycle.**
1. **Create:** the orchestrator writes one opencode-memory entry, kind
   `epic`, anchored with `paths` to the code it touches.
2. **Work:** tasks are carved out as `task:` DMs; completions come back as
   `status:` in the pool.
3. **Close:** the orchestrator broadcasts `decision: epic <name> closed:
   <outcome>` to the concerned pools and supersedes the memory entry.

## 5. Fleet + memory

The mesh moves the messages; opencode-memory keeps the state. Together they
make the fleet's shared brain:

- **The epics/tasks ledger lives in opencode-memory**, not in anyone's
  context window. Entries are anchored to the code they touch (`paths`), so a
  task whose code moved self-detects as stale, no human auditor needed
  (opencode-memory >= 0.11).
- **Decisions are superseded, not stacked.** When a decision changes, save the
  new entry with `supersedes=<old id>` instead of adding a contradicting
  duplicate: the ledger stays one truth per question (opencode-memory >= 0.12).
- **Search is the archive.** `memory_search` over past entries answers "why is
  it built this way" without asking a human or re-reading transcripts.
- **Composition:** mesh = who is talking to whom right now (boxes, pools,
  presence, wake). memory = what the fleet has decided and must not forget.
  An agent joining the fleet reads memory first, then checks in on the mesh.

Rule of thumb: anything an agent must know next turn goes through the mesh
(mail), anything it must know next week goes through memory (entries), and
anything the human must know goes in a pool announcement.
