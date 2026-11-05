/** Bounded queue: preserve one user's message order while limiting concurrent analyses. */
export class JobQueue {
  private waiting: { key: string; task: () => Promise<void> }[] = [];
  private activeKeys = new Set<string>();
  private total = 0;
  private accepting = true;
  private idleWaiters: (() => void)[] = [];
  constructor(private concurrency = 2, private capacity = 40, private perUser = 5) {}

  enqueue(key: string, task: () => Promise<void>): boolean {
    if (!this.accepting || this.total >= this.capacity || this.waiting.filter(job => job.key === key).length + Number(this.activeKeys.has(key)) >= this.perUser) return false;
    this.waiting.push({ key, task });
    this.total++;
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.activeKeys.size < this.concurrency) {
      const index = this.waiting.findIndex(job => !this.activeKeys.has(job.key));
      if (index < 0) break;
      const job = this.waiting.splice(index, 1)[0]!;
      this.activeKeys.add(job.key);
      // The controller reports errors; this catch keeps an unexpected failure from stalling the queue.
      void Promise.resolve().then(job.task).catch(() => {}).finally(() => {
        this.activeKeys.delete(job.key);
        this.total--;
        this.pump();
        if (!this.total) this.idleWaiters.splice(0).forEach(resolve => resolve());
      });
    }
  }

  async drain(): Promise<void> {
    this.accepting = false;
    if (this.total) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }
}
