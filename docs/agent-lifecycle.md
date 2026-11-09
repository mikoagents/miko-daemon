# Agent lifecycle

`AgentManager` remains the native owner of provider sessions, turns, permissions and event
streams. `AgentStorage` persists native resume handles and lifecycle snapshots. Miko's local
backend calls these modules directly and scopes every session to its enrolled Hub identity.

Creation and submission are separate keyed operations. Creation can be recovered by its
preallocated agent ID; uncertain submissions are never automatically repeated. Restore uses
the original workspace recovery service, and later turns resume the same native session.
Archive uses the original workspace/agent lifecycle and owned worktree cleanup.

The public service watches before reading an authoritative snapshot. Reconnection reattaches
observation without granting new task authority. Revoking execution authority fences a pending
creation and rolls back resources it created. Shutdown drains admitted work before closing
provider sessions and persistence, while the inherited supervisor owns worker restart and locks.

Provider terminal states coordinate observation and cleanup. Hub alone decides whether required
outputs, structured results and the authorized `finish_execution` call complete a workflow.
