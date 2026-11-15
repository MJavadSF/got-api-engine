// ── Tracked background work (stale-while-revalidate, etc.) ───────

export class BackgroundTasks {
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(private readonly waitUntil?: (task: Promise<unknown>) => void) {}

  get size(): number {
    return this.tasks.size;
  }

  run(task: Promise<unknown>): void {
    const tracked = task.catch(() => undefined).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
    // Serverless runtimes (Next.js `after`, Vercel `waitUntil`) keep it alive.
    try {
      this.waitUntil?.(tracked);
    } catch {
      /* waitUntil outside a request scope — the task still runs */
    }
  }

  /** Wait for pending tasks, at most `timeoutMs`. */
  async drain(timeoutMs = 5000): Promise<void> {
    if (this.tasks.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...this.tasks]), timeout]);
    clearTimeout(timer);
  }
}
