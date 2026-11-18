// In-DO serial queue (D13). DO input gates do not serialize across awaits on container calls,
// so every container-touching path (spawn, pause, delete, alarm) runs through one queue.

export class ExclusiveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Run fn after every earlier fn settles. A rejection reaches only its own caller. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const p = this.tail.then(fn).finally(() => {
      this.depth--;
    });
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Jobs queued or running. */
  get pending(): number {
    return this.depth;
  }
}
