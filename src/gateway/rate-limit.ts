/** A bounded, per-TCP-peer budget, reserved before reading bodies or credentials. */
export class AttemptBudget {
  private readonly peers = new Map<string, { used: number; until: number }>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 5 * 60_000,
    private readonly maxAttempts = 5,
    private readonly maxPeers = 1024,
  ) {}

  reserve(peer: string | undefined): number | undefined {
    const now = this.now()
    for (const [key, value] of this.peers) if (value.until <= now) this.peers.delete(key)
    // Normalize IPv4-mapped peers, never trust X-Forwarded-For / Host for identity.
    const key = peer?.replace(/^::ffff:/i, '') ?? '<unknown>'
    let value = this.peers.get(key)
    if (!value) {
      // Refuse overflow rather than evicting and resetting an active peer's budget.
      if (this.peers.size >= this.maxPeers) return Math.max(1, Math.ceil(this.windowMs / 1000))
      value = { used: 0, until: now + this.windowMs }
      this.peers.set(key, value)
    }
    if (value.used >= this.maxAttempts) return Math.max(1, Math.ceil((value.until - now) / 1000))
    value.used++
    return undefined
  }

  clear(): void {
    this.peers.clear()
  }
}
