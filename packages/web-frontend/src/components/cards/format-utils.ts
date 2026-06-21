/**
 * Shared formatting utilities for card components
 */

export function formatDate(timestamp: number | string | undefined): string {
  if (!timestamp) return "—";
  const date = typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatRelativeTime(timestamp: number | string | undefined): string {
  if (!timestamp) return "—";
  const date = typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
  if (isNaN(date.getTime())) return "—";
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(timestamp);
}
