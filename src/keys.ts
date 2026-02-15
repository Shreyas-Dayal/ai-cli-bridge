import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface KeyLimits {
  maxRequestsPerDay: number;    // 0 = unlimited
  maxRequestsPerMonth: number;  // 0 = unlimited
  maxTokensPerMonth: number;    // 0 = unlimited (input + output combined)
  maxCostPerDay: number;        // 0 = unlimited (USD)
  maxCostPerMonth: number;      // 0 = unlimited (USD)
}

export interface KeyEntry {
  name: string;
  createdAt: string;
  limits: KeyLimits;
}

interface DailyUsage {
  requests: number;
  tokens: number;
  costUsd: number;
}

interface MonthlyUsage {
  requests: number;
  tokens: number;
  costUsd: number;
}

interface KeyUsage {
  daily: Record<string, DailyUsage>;    // "2026-02-15" → counts
  monthly: Record<string, MonthlyUsage>; // "2026-02" → counts
}

interface KeysFile {
  keys: Record<string, KeyEntry>; // SHA-256 hash → config
}

interface UsageFile {
  usage: Record<string, KeyUsage>; // SHA-256 hash → usage
}

// ── KeyManager ───────────────────────────────────────────────────────────────

export class KeyManager {
  private keysFile: string;
  private usageFile: string;
  private keys: KeysFile = { keys: {} };
  private usage: UsageFile = { usage: {} };
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.keysFile = join(dataDir, 'keys.json');
    this.usageFile = join(dataDir, 'usage.json');
    this.load();

    // Auto-save usage every 30 seconds if dirty, prune old entries daily
    this.pruneOldUsage();
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.saveUsage();
        this.dirty = false;
      }
    }, 30_000);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    if (existsSync(this.keysFile)) {
      try {
        this.keys = JSON.parse(readFileSync(this.keysFile, 'utf-8'));
      } catch {
        console.error('[keys] Failed to parse keys.json — starting with empty keys');
        this.keys = { keys: {} };
      }
    }
    if (existsSync(this.usageFile)) {
      try {
        this.usage = JSON.parse(readFileSync(this.usageFile, 'utf-8'));
      } catch {
        console.error('[keys] Failed to parse usage.json — starting with empty usage');
        this.usage = { usage: {} };
      }
    }
  }

  private saveKeys(): void {
    writeFileSync(this.keysFile, JSON.stringify(this.keys, null, 2), { mode: 0o600 });
  }

  private saveUsage(): void {
    writeFileSync(this.usageFile, JSON.stringify(this.usage, null, 2), { mode: 0o600 });
  }

  // ── Hashing ──────────────────────────────────────────────────────────────

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  // ── Key CRUD ─────────────────────────────────────────────────────────────

  createKey(name: string, limits: Partial<KeyLimits> = {}): string {
    // Check for duplicate name
    for (const entry of Object.values(this.keys.keys)) {
      if (entry.name === name) {
        throw new Error(`Key with name "${name}" already exists`);
      }
    }

    const rawKey = randomBytes(32).toString('hex');
    const keyHash = this.hash(rawKey);

    this.keys.keys[keyHash] = {
      name,
      createdAt: new Date().toISOString(),
      limits: {
        maxRequestsPerDay: limits.maxRequestsPerDay ?? 0,
        maxRequestsPerMonth: limits.maxRequestsPerMonth ?? 0,
        maxTokensPerMonth: limits.maxTokensPerMonth ?? 0,
        maxCostPerDay: limits.maxCostPerDay ?? 0,
        maxCostPerMonth: limits.maxCostPerMonth ?? 0,
      },
    };

    this.saveKeys();
    return rawKey;
  }

  deleteKey(name: string): boolean {
    for (const [hash, entry] of Object.entries(this.keys.keys)) {
      if (entry.name === name) {
        delete this.keys.keys[hash];
        delete this.usage.usage[hash];
        this.saveKeys();
        this.saveUsage();
        return true;
      }
    }
    return false;
  }

  updateLimits(name: string, limits: Partial<KeyLimits>): boolean {
    for (const entry of Object.values(this.keys.keys)) {
      if (entry.name === name) {
        if (limits.maxRequestsPerDay !== undefined) entry.limits.maxRequestsPerDay = limits.maxRequestsPerDay;
        if (limits.maxRequestsPerMonth !== undefined) entry.limits.maxRequestsPerMonth = limits.maxRequestsPerMonth;
        if (limits.maxTokensPerMonth !== undefined) entry.limits.maxTokensPerMonth = limits.maxTokensPerMonth;
        if (limits.maxCostPerDay !== undefined) entry.limits.maxCostPerDay = limits.maxCostPerDay;
        if (limits.maxCostPerMonth !== undefined) entry.limits.maxCostPerMonth = limits.maxCostPerMonth;
        this.saveKeys();
        return true;
      }
    }
    return false;
  }

  private normalizeUsage(raw: Partial<DailyUsage> | undefined): DailyUsage {
    return { requests: raw?.requests || 0, tokens: raw?.tokens || 0, costUsd: raw?.costUsd || 0 };
  }

  listKeys(): Array<{ name: string; createdAt: string; limits: KeyLimits; usage: { today: DailyUsage; thisMonth: MonthlyUsage } }> {
    const today = this.todayKey();
    const month = this.monthKey();

    return Object.entries(this.keys.keys).map(([hash, entry]) => {
      const keyUsage = this.usage.usage[hash];
      return {
        name: entry.name,
        createdAt: entry.createdAt,
        limits: entry.limits,
        usage: {
          today: this.normalizeUsage(keyUsage?.daily[today]),
          thisMonth: this.normalizeUsage(keyUsage?.monthly[month]),
        },
      };
    });
  }

  getKeyUsage(name: string): { name: string; limits: KeyLimits; usage: { today: DailyUsage; thisMonth: MonthlyUsage } } | null {
    const today = this.todayKey();
    const month = this.monthKey();

    for (const [hash, entry] of Object.entries(this.keys.keys)) {
      if (entry.name === name) {
        const keyUsage = this.usage.usage[hash];
        return {
          name: entry.name,
          limits: entry.limits,
          usage: {
            today: this.normalizeUsage(keyUsage?.daily[today]),
            thisMonth: this.normalizeUsage(keyUsage?.monthly[month]),
          },
        };
      }
    }
    return null;
  }

  resetUsage(name: string): boolean {
    for (const [hash, entry] of Object.entries(this.keys.keys)) {
      if (entry.name === name) {
        this.usage.usage[hash] = { daily: {}, monthly: {} };
        this.saveUsage();
        return true;
      }
    }
    return false;
  }

  // ── Auth & Limits ────────────────────────────────────────────────────────

  /** Validate key and check limits in one call. Returns hash so rawKey never needs to be stored. */
  validateAndCheck(rawKey: string): { name?: string; hash?: string; error?: string } {
    const incomingHash = this.hash(rawKey);

    let matchedEntry: KeyEntry | null = null;
    for (const [storedHash, entry] of Object.entries(this.keys.keys)) {
      if (incomingHash.length === storedHash.length) {
        if (timingSafeEqual(Buffer.from(incomingHash), Buffer.from(storedHash))) {
          matchedEntry = entry;
          break;
        }
      }
    }

    if (!matchedEntry) return { error: 'Forbidden' };

    // Check limits
    const limitError = this.checkLimitsByHash(incomingHash, matchedEntry);
    if (limitError) return { error: limitError };

    return { name: matchedEntry.name, hash: incomingHash };
  }

  private checkLimitsByHash(keyHash: string, entry: KeyEntry): string | null {

    const today = this.todayKey();
    const month = this.monthKey();
    const keyUsage = this.usage.usage[keyHash];

    if (entry.limits.maxRequestsPerDay > 0) {
      const dailyReqs = keyUsage?.daily[today]?.requests || 0;
      if (dailyReqs >= entry.limits.maxRequestsPerDay) {
        return `Daily request limit reached (${entry.limits.maxRequestsPerDay}/day)`;
      }
    }

    if (entry.limits.maxRequestsPerMonth > 0) {
      const monthlyReqs = keyUsage?.monthly[month]?.requests || 0;
      if (monthlyReqs >= entry.limits.maxRequestsPerMonth) {
        return `Monthly request limit reached (${entry.limits.maxRequestsPerMonth}/month)`;
      }
    }

    if (entry.limits.maxTokensPerMonth > 0) {
      const monthlyTokens = keyUsage?.monthly[month]?.tokens || 0;
      if (monthlyTokens >= entry.limits.maxTokensPerMonth) {
        return `Monthly token limit reached (${entry.limits.maxTokensPerMonth}/month)`;
      }
    }

    if (entry.limits.maxCostPerDay > 0) {
      const dailyCost = keyUsage?.daily[today]?.costUsd || 0;
      if (dailyCost >= entry.limits.maxCostPerDay) {
        return `Daily cost limit reached ($${entry.limits.maxCostPerDay.toFixed(2)}/day)`;
      }
    }

    if (entry.limits.maxCostPerMonth > 0) {
      const monthlyCost = keyUsage?.monthly[month]?.costUsd || 0;
      if (monthlyCost >= entry.limits.maxCostPerMonth) {
        return `Monthly cost limit reached ($${entry.limits.maxCostPerMonth.toFixed(2)}/month)`;
      }
    }

    return null;
  }

  /** Record usage after a successful generation. Accepts pre-computed hash. */
  recordUsage(keyHash: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    if (!this.keys.keys[keyHash]) return;

    const today = this.todayKey();
    const month = this.monthKey();
    const totalTokens = inputTokens + outputTokens;

    if (!this.usage.usage[keyHash]) {
      this.usage.usage[keyHash] = { daily: {}, monthly: {} };
    }

    const u = this.usage.usage[keyHash];

    // Daily
    if (!u.daily[today]) u.daily[today] = { requests: 0, tokens: 0, costUsd: 0 };
    u.daily[today].requests++;
    u.daily[today].tokens += totalTokens;
    u.daily[today].costUsd = (u.daily[today].costUsd || 0) + costUsd;

    // Monthly
    if (!u.monthly[month]) u.monthly[month] = { requests: 0, tokens: 0, costUsd: 0 };
    u.monthly[month].requests++;
    u.monthly[month].tokens += totalTokens;
    u.monthly[month].costUsd = (u.monthly[month].costUsd || 0) + costUsd;

    this.dirty = true;
  }

  hasKeys(): boolean {
    return Object.keys(this.keys.keys).length > 0;
  }

  keyCount(): number {
    return Object.keys(this.keys.keys).length;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Remove daily entries older than 90 days and monthly entries older than 12 months. */
  private pruneOldUsage(): void {
    const now = Date.now();
    const dailyCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const monthlyCutoff = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7);
    let pruned = false;

    for (const keyUsage of Object.values(this.usage.usage)) {
      for (const day of Object.keys(keyUsage.daily)) {
        if (day < dailyCutoff) {
          delete keyUsage.daily[day];
          pruned = true;
        }
      }
      for (const month of Object.keys(keyUsage.monthly)) {
        if (month < monthlyCutoff) {
          delete keyUsage.monthly[month];
          pruned = true;
        }
      }
    }

    if (pruned) this.saveUsage();
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10); // "2026-02-15"
  }

  private monthKey(): string {
    return new Date().toISOString().slice(0, 7); // "2026-02"
  }

  shutdown(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) this.saveUsage();
  }
}
