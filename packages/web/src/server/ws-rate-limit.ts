export type RejectionReason =
  | { kind: "upgrade"; ip: string }
  | { kind: "connection"; userId: string };

interface WsRateLimiterOptions {
  maxConnectionsPerUser?: number;
  maxUpgradesPerIpPerMinute?: number;
  /**
   * Called whenever the limiter denies an upgrade or connection. The host
   * uses this to surface a warn-level log so silent throttling cannot mask
   * UI bugs (every previous "Smithers won't reconnect" debugging session
   * was made painful by the absence of this signal).
   */
  onReject?: (reason: RejectionReason) => void;
}

interface IpUpgradeRecord {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

export class WsRateLimiter {
  private maxConnectionsPerUser: number;
  private maxUpgradesPerIpPerMinute: number;
  private onReject?: (reason: RejectionReason) => void;
  private connectionCounts = new Map<string, number>();
  private ipUpgrades = new Map<string, IpUpgradeRecord>();

  constructor(options: WsRateLimiterOptions = {}) {
    // Defaults are tuned to absorb legitimate UI behavior — exponential
    // backoff reconnect loops, multi-tab usage, agent switching, brief
    // network blips — without throttling real users. The limiter is a
    // brute-force / DoS guard, not a UI throttle.
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 10;
    this.maxUpgradesPerIpPerMinute = options.maxUpgradesPerIpPerMinute ?? 60;
    this.onReject = options.onReject;
  }

  allowConnection(userId: string): boolean {
    const count = this.connectionCounts.get(userId) ?? 0;
    if (count >= this.maxConnectionsPerUser) {
      this.onReject?.({ kind: "connection", userId });
      return false;
    }
    return true;
  }

  trackConnection(userId: string): void {
    const count = this.connectionCounts.get(userId) ?? 0;
    this.connectionCounts.set(userId, count + 1);
  }

  releaseConnection(userId: string): void {
    const count = this.connectionCounts.get(userId) ?? 0;
    if (count <= 1) {
      this.connectionCounts.delete(userId);
    } else {
      this.connectionCounts.set(userId, count - 1);
    }
  }

  allowUpgrade(ip: string): boolean {
    const now = Date.now();
    const record = this.ipUpgrades.get(ip);

    if (!record || now - record.windowStart > WINDOW_MS) {
      this.ipUpgrades.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (record.count < this.maxUpgradesPerIpPerMinute) {
      record.count++;
      return true;
    }

    this.onReject?.({ kind: "upgrade", ip });
    return false;
  }
}
