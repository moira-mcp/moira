import { randomUUID } from "node:crypto";
import type { ExecutionReminder, ReminderMutation } from "@mcp-moira/workflow-engine";
import { ConflictError, ValidationError } from "../errors/index.js";

export function applyExecutionReminderMutation(
  source: ExecutionReminder[],
  mutation: ReminderMutation,
): { reminders: ExecutionReminder[]; reminder: ExecutionReminder; changed: boolean } {
  const reminders = structuredClone(source);
  if (mutation.action === "add") {
    const text = mutation.text.trim();
    if (!text || text.length > 1000)
      throw new ValidationError("Reminder text must contain 1-1000 characters");
    if (mutation.idempotencyKey && mutation.idempotencyKey.length > 100)
      throw new ValidationError("Reminder idempotencyKey must not exceed 100 characters");
    const existing = mutation.idempotencyKey
      ? reminders.find((item) => item.idempotencyKey === mutation.idempotencyKey)
      : undefined;
    if (existing) {
      if (existing.text !== text)
        throw new ConflictError("Reminder idempotency key already has a different payload");
      return { reminders, reminder: existing, changed: false };
    }
    if (reminders.length >= 50) throw new ValidationError("Execution reminder limit reached");
    const now = Date.now();
    const reminder: ExecutionReminder = {
      id: randomUUID(),
      text,
      status: "active",
      idempotencyKey: mutation.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    reminders.push(reminder);
    return { reminders, reminder, changed: true };
  }
  const index = reminders.findIndex((item) => item.id === mutation.reminderId);
  if (index < 0) throw new ValidationError("Reminder not found");
  const current = reminders[index];
  if (mutation.action === "cancel") {
    if (current.status === "cancelled") return { reminders, reminder: current, changed: false };
    const reminder: ExecutionReminder = { ...current, status: "cancelled", updatedAt: Date.now() };
    reminders[index] = reminder;
    return { reminders, reminder, changed: true };
  }
  const text = mutation.text.trim();
  if (!text || text.length > 1000)
    throw new ValidationError("Reminder text must contain 1-1000 characters");
  if (current.status !== "active") throw new ConflictError("Cancelled reminder cannot be updated");
  if (current.text === text) return { reminders, reminder: current, changed: false };
  const reminder: ExecutionReminder = { ...current, text, updatedAt: Date.now() };
  reminders[index] = reminder;
  return { reminders, reminder, changed: true };
}
