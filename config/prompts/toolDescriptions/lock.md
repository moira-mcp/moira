Manage execution locks with action-based routing

Actions:

- lock: Create a lock on a running execution (requires reason)
- status: Check if an execution has an active lock
- list: List all locks (active and unlocked) for an execution
- unlock: Unlock an active lock using the PIN code

Usage:

- Locks can be created by lock workflow nodes or programmatically via lock action
- Use lock to pause an execution — returns a PIN needed for unlocking
- Use status to check if an execution is currently locked
- Use unlock with the PIN provided when the lock was created
- Locked executions show status "locked" in session executions list and detail view

Examples:

- lock({ action: "lock", executionId: "abc123", reason: "Review needed" }) - create lock, returns PIN
- lock({ action: "status", executionId: "abc123" }) - check lock status
- lock({ action: "list", executionId: "abc123" }) - list all locks
- lock({ action: "unlock", executionId: "abc123", pin: "123456" }) - unlock with PIN

Related: Use session({ action: "executions", status: ["locked"] }) to find locked executions
