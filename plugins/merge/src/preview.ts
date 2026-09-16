/**
 * The dialog's one rule for `merge.preview`: a burst of option changes is one call, and
 * only one preview job is ever outstanding. A request made while a job runs is remembered,
 * not queued — the newest signature wins and everything between it and the last answer is
 * dropped, the same coalescing the slider path uses for `op.update`.
 *
 * `run` resolves when the *job* is done, not when the RPC returned; that is what makes
 * "one in flight" mean one job rather than one call.
 */
export class PreviewRequester {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /** Signature waiting for a slot; null when nothing is owed. */
  private pending: string | null = null;
  /** Signature the last dispatched run carried — what the screen shows or is about to. */
  private sent = "";

  constructor(
    private readonly run: (signature: string) => Promise<void>,
    private readonly delayMs = 180,
  ) {}

  /** Asks for a preview of `signature`, unless that is already the one being waited for. */
  request(signature: string): void {
    if (signature === (this.pending ?? this.sent)) return;
    this.pending = signature;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.delayMs);
  }

  /**
   * Forgets a request that has not gone out yet and the memory of what was last asked for,
   * so a reopened dialog asks again. A call already on the wire lands and is ignored by
   * whoever asked for it.
   */
  drop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.sent = "";
  }

  private start(): void {
    if (this.inFlight) return;
    const signature = this.pending;
    if (signature === null) return;
    this.pending = null;
    // The answer on screen already matches — this is the A → B → A case, where B never
    // went out and A is what the last run carried.
    if (signature === this.sent) return;
    this.sent = signature;
    this.inFlight = true;
    void this.run(signature).finally(() => {
      this.inFlight = false;
      // Whatever arrived while the job ran goes out now, without a second debounce wait.
      this.start();
    });
  }
}
