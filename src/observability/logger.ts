// =================================================================
// got-api-engine — Logger
// =================================================================

import type { LogLevel } from "../types/http";
import type { LoggerInterface } from "../types/observability";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && v in LEVELS;
}

/**
 * Effective minimum level: explicit `level` > `debug` flag > `LOG_LEVEL` env
 * > "info".
 */
export function resolveLogLevel(level?: LogLevel, debug?: boolean): LogLevel {
  if (level) return level;
  if (debug) return "debug";
  const env = process.env.LOG_LEVEL?.toLowerCase();
  return isLogLevel(env) ? env : "info";
}

// ── Console fallback (zero-dep, works everywhere) ────────────────
class ConsoleLogger implements LoggerInterface {
  constructor(
    private readonly serviceName: string,
    private readonly level: LogLevel,
    private readonly baseMeta: Record<string, unknown> = {},
  ) {}

  isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) return;
    const all = { ...this.baseMeta, ...meta };
    let metaStr = "";
    if (Object.keys(all).length) {
      try {
        metaStr = ` ${JSON.stringify(all)}`;
      } catch {
        metaStr = " [unserializable meta]";
      }
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.serviceName}] ${message}${metaStr}`;
    // eslint-disable-next-line no-console
    console[level](line);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  child(childMeta: Record<string, unknown>): LoggerInterface {
    return new ConsoleLogger(this.serviceName, this.level, { ...this.baseMeta, ...childMeta });
  }
}

// ── Winston-backed logger (optional peer dependency) ─────────────
async function tryCreateWinstonLogger(serviceName: string, level: LogLevel, isDev: boolean): Promise<LoggerInterface | null> {
  try {
    const winston = await import("winston").catch(() => null);
    if (!winston) return null;

    const colorfulFormat = winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
      winston.format.printf(({ timestamp, level: lvl, message, requestId, err, ...meta }) => {
        const reqStr = typeof requestId === "string" ? requestId.slice(0, 8) : "no-req";
        const metaKeys = Object.keys(meta).filter((k) => k !== "service");
        const metaStr = metaKeys.length ? ` | ${JSON.stringify(meta)}` : "";
        const e = err as { code?: unknown; message?: unknown } | undefined;
        const errStr = e ? ` | err: ${JSON.stringify({ code: e.code, message: e.message })}` : "";
        return `${String(timestamp)} ${lvl} [${serviceName}] ${String(message)} | req:${reqStr}${errStr}${metaStr}`;
      }),
    );

    const jsonFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    );

    const selectedFormat = isDev ? colorfulFormat : jsonFormat;
    const wLogger = winston.createLogger({
      defaultMeta: { service: serviceName },
      format: selectedFormat,
      level: level === "silent" ? "error" : level,
      silent: level === "silent",
      transports: [new winston.transports.Console()],
    });

    const wrap = (l: import("winston").Logger): LoggerInterface => ({
      debug: (msg, meta) => void l.debug(msg, meta),
      info: (msg, meta) => void l.info(msg, meta),
      warn: (msg, meta) => void l.warn(msg, meta),
      error: (msg, meta) => void l.error(msg, meta),
      child: (childMeta) => wrap(l.child(childMeta)),
      isLevelEnabled: (lvl) => !l.silent && l.isLevelEnabled(lvl),
    });
    return wrap(wLogger);
  } catch {
    return null;
  }
}

// ── Factories ─────────────────────────────────────────────────────
export function createConsoleLogger(serviceName: string, debugEnabled = false, level?: LogLevel): LoggerInterface {
  return new ConsoleLogger(serviceName, resolveLogLevel(level, debugEnabled));
}

/**
 * Create a logger backed by Winston when it is installed (optional peer
 * dependency), falling back to the built-in console logger. Pass the result
 * as `logger` to `createEngine`.
 */
export async function createLogger(
  serviceName: string,
  debugEnabled = false,
  isDev = process.env.NODE_ENV !== "production",
  level?: LogLevel,
): Promise<LoggerInterface> {
  const resolved = resolveLogLevel(level, debugEnabled);
  return (await tryCreateWinstonLogger(serviceName, resolved, isDev)) ?? new ConsoleLogger(serviceName, resolved);
}
