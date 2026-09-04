Manage execution locks with action-based routing

Actions:

- lock: Create a lock on a running execution and deliver its PIN through the user's trusted Telegram configuration
- status: Check if an execution has an active lock
- list: List all locks (active and unlocked) for an execution
- unlock: Unlock an active lock using the PIN code

Usage:

- Locks can be created by lock workflow nodes or through the lock action.
- The lock action returns only non-secret lock metadata (`lockId`, `locked`). It never returns the generated PIN to the agent.
- The generated PIN is delivered to the configured Telegram chat. Missing or failed trusted delivery leaves no usable active lock.
- Use status to check if an execution is currently locked
- Use unlock only after the user supplies the PIN received through the trusted channel.
- Locked executions show status "locked" in session executions list and detail view

Examples:

- lock({ action: "lock", executionId: "abc123", reason: "Review needed" }) - create lock after trusted PIN delivery; returns no PIN
- lock({ action: "status", executionId: "abc123" }) - check lock status
- lock({ action: "list", executionId: "abc123" }) - list all locks
- lock({ action: "unlock", executionId: "abc123", pin: "123456" }) - unlock with a user-supplied PIN

Related: Use session({ action: "executions", status: ["locked"] }) to find locked executions
