export const MAX_ATTACHMENT_INFLIGHT_PER_USER = 2;
export const MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER = 40 * 1024 * 1024;

/** Process-local accounting for the request buffers owned by the sole upload endpoint. */
export class CommunicationAttachmentInflightLimiter {
  private readonly states = new Map<string, { count: number; bytes: number }>();

  acquire(userId: string, bytes: number): (() => void) | null {
    const current = this.states.get(userId) ?? { count: 0, bytes: 0 };
    if (
      current.count >= MAX_ATTACHMENT_INFLIGHT_PER_USER ||
      current.bytes + bytes > MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER
    )
      return null;
    this.states.set(userId, { count: current.count + 1, bytes: current.bytes + bytes });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = this.states.get(userId);
      if (!state) return;
      const next = { count: state.count - 1, bytes: state.bytes - bytes };
      if (next.count <= 0) this.states.delete(userId);
      else this.states.set(userId, next);
    };
  }
}
