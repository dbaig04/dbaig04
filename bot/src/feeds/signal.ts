// Level-triggered "state may have changed" signal shared by the push feeds
// (Geyser gRPC, ShredStream) and the main loop. notify() while nobody waits is
// remembered (coalesced) until the next wait(), so a burst of updates during a
// tick causes exactly one immediate re-evaluation afterwards.

export class ChangeSignal {
  private pending: string | null = null;
  private waiters: ((reason: string) => void)[] = [];
  /** Count of notify() calls (tests / metrics). */
  notifies = 0;

  notify(reason: string): void {
    this.notifies++;
    if (this.waiters.length) {
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w(reason);
      return;
    }
    if (this.pending === null) this.pending = reason;
  }

  /** Resolves with the notify reason, or "timeout" after timeoutMs. */
  wait(timeoutMs: number): Promise<string> {
    if (this.pending !== null) {
      const r = this.pending;
      this.pending = null;
      return Promise.resolve(r);
    }
    return new Promise<string>((resolve) => {
      let done = false;
      const finish = (r: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== finish);
        resolve(r);
      };
      const timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
      this.waiters.push(finish);
    });
  }

  /** Drop a remembered notification (e.g. after a tick that already consumed the newest state). */
  clear(): void {
    this.pending = null;
  }
}
