interface WsRateLimiterOptions {
  maxConnectionsPerUser?: number;
  maxUpgradesPerIpPerMinute?: number;
}

interface IpUpgradeRecord {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

export class WsRateLimiter {
  private maxConnectionsPerUser: number;
  private maxUpgradesPerIpPerMinute: number;
  private connectionCounts = new Map<string, number>();
  private ipUpgrades = new Map<string, IpUpgradeRecord>();

  constructor(options: WsRateLimiterOptions = {}) {
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
    this.maxUpgradesPerIpPerMinute = options.maxUpgradesPerIpPerMinute ?? 10;
  }

  allowConnection(userId: string): boolean {
    const count = this.connectionCounts.get(userId) ?? 0;
    return count < this.maxConnectionsPerUser;
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

    return false;
  }
}
