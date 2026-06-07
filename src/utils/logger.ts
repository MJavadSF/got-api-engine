// =================================================================
// got-api-engine — Logger
// =================================================================

import type { LoggerInterface } from "../types";

// ── Console fallback (zero-dep, works everywhere) ────────────────
class ConsoleLogger implements LoggerInterface {
  private prefix: string;
  private debugEnabled: boolean;

  constructor(serviceName: string, debugEnabled = false) {
    this.prefix = `[${serviceName}]`;
    this.debugEnabled = debugEnabled;
  }

  private format(level: string, message: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${ts} ${level.toUpperCase().padEnd(5)} ${this.prefix} ${message}${metaStr}`;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.debugEnabled) console.debug(this.format("debug", message, meta));
  }

  info(message: string, meta?: Record<string, unknown>): void {
    console.info(this.format("info", message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(this.format("warn", message, meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(this.format("error", message, meta));
  }

  child(childMeta: Record<string, unknown>): LoggerInterface {
    const childLogger = new ConsoleLogger(this.prefix.slice(1, -1), this.debugEnabled);
    const originalFormat = childLogger["format"].bind(childLogger);
    childLogger["format"] = (level: string, message: string, meta?: Record<string, unknown>) =>
      originalFormat(level, message, { ...childMeta, ...meta });
    return childLogger;
  }
}

// ── Winston-backed logger (optional, tree-shaken if not present) ──
let winstonLoaded = false;

async function tryCreateWinstonLogger(
  serviceName: string,
  debugEnabled: boolean,
  isDev: boolean,
): Promise<LoggerInterface | null> {
  try {
    const winston = await import("winston").catch(() => null);
    if (!winston) return null;

    winstonLoaded = true;

    const colorfulFormat = winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
      winston.format.printf(({ timestamp, level, message, requestId, userId, err, ...meta }) => {
        const reqStr = typeof requestId === "string" ? requestId.slice(0, 8) : "no-req";
        const userStr = typeof userId === "string" ? userId : "anon";
        const metaKeys = Object.keys(meta).filter((k) => k !== "service");
        const metaStr = metaKeys.length ? ` | ${JSON.stringify(meta)}` : "";
        const errStr = err
          ? ` | err: ${JSON.stringify({
              code: (err as any).code,
              message: (err as any).message,
            })}`
          : "";
        return `${timestamp} ${level} [${serviceName}] ${message} | req:${reqStr} | user:${userStr}${errStr}${metaStr}`;
      }),
    );

    const jsonFormat = winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      winston.format.errors({ stack: true }),
      winston.format.metadata({ fillExcept: ["message", "level", "timestamp"] }),
      winston.format.json(),
    );

    const selectedFormat = isDev ? colorfulFormat : jsonFormat;

    const wLogger = winston.createLogger({
      defaultMeta: { service: serviceName },
      format: selectedFormat,
      level: debugEnabled ? "debug" : isDev ? "debug" : "info",
      transports: [new winston.transports.Console({ format: selectedFormat })],
    });

    // Wrap to match our interface
    const wrapped: LoggerInterface = {
      debug: (msg, meta) => wLogger.debug(msg, meta),
      info: (msg, meta) => wLogger.info(msg, meta),
      warn: (msg, meta) => wLogger.warn(msg, meta),
      error: (msg, meta) => wLogger.error(msg, meta),
      child: (childMeta) => {
        const c = wLogger.child(childMeta);
        return {
          debug: (msg, meta) => c.debug(msg, meta),
          info: (msg, meta) => c.info(msg, meta),
          warn: (msg, meta) => c.warn(msg, meta),
          error: (msg, meta) => c.error(msg, meta),
        };
      },
    };

    return wrapped;
  } catch {
    return null;
  }
}

// ── Factory ───────────────────────────────────────────────────────
export function createConsoleLogger(serviceName: string, debugEnabled = false): LoggerInterface {
  return new ConsoleLogger(serviceName, debugEnabled);
}

export async function createLogger(
  serviceName: string,
  debugEnabled = false,
  isDev = process.env.NODE_ENV !== "production",
): Promise<LoggerInterface> {
  const winston = await tryCreateWinstonLogger(serviceName, debugEnabled, isDev);
  return winston ?? createConsoleLogger(serviceName, debugEnabled);
}

export { winstonLoaded };
