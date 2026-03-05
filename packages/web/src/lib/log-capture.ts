type LogLevel = "error" | "warn";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 100;

class LogCapture {
  private entries: LogEntry[] = [];
  private installed = false;

  add(level: LogLevel, message: string) {
    this.entries.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  formatAsText(): string {
    return this.entries
      .map((e) => `${e.timestamp} [${e.level.toUpperCase()}] ${e.message}`)
      .join("\n");
  }

  clear() {
    this.entries = [];
    this.installed = false;
  }

  install() {
    if (this.installed) return;
    this.installed = true;

    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = (...args: unknown[]) => {
      this.add("error", args.map(String).join(" "));
      originalError.apply(console, args);
    };

    console.warn = (...args: unknown[]) => {
      this.add("warn", args.map(String).join(" "));
      originalWarn.apply(console, args);
    };
  }
}

const GLOBAL_KEY = Symbol.for("pinchy:log-capture");
const g = globalThis as Record<symbol, LogCapture>;

export const logCapture: LogCapture = g[GLOBAL_KEY] ?? (g[GLOBAL_KEY] = new LogCapture());
