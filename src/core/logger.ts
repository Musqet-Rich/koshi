export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'
if (!LEVEL_ORDER[currentLevel]) currentLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel]
}

function write(level: LogLevel, component: string, message: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return
  const entry: Record<string, unknown> = {
    level,
    timestamp: new Date().toISOString(),
    component,
    message,
    ...extra,
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, extra?) => write('debug', component, msg, extra),
    info: (msg, extra?) => write('info', component, msg, extra),
    warn: (msg, extra?) => write('warn', component, msg, extra),
    error: (msg, extra?) => write('error', component, msg, extra),
  }
}

// Fastify logger adapter
const fastifyBase = createLogger('fastify')

function noop() {}

function createFastifyChild(component: string): FastifyLoggerAdapter {
  const child = createLogger(component)
  return {
    info: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'info', msgOrObj, ...args),
    error: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'error', msgOrObj, ...args),
    debug: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'debug', msgOrObj, ...args),
    warn: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'warn', msgOrObj, ...args),
    fatal: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'error', msgOrObj, ...args),
    trace: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(child, 'debug', msgOrObj, ...args),
    child: (bindings: Record<string, unknown>) => createFastifyChild((bindings.name as string) || component),
    silent: noop,
    level: 'info',
  }
}

function fastifyLog(
  logger: Logger,
  level: 'debug' | 'info' | 'warn' | 'error',
  msgOrObj: unknown,
  ...args: unknown[]
): void {
  if (typeof msgOrObj === 'string') {
    logger[level](msgOrObj)
  } else if (typeof msgOrObj === 'object' && msgOrObj !== null) {
    const msg = typeof args[0] === 'string' ? args[0] : ''
    const { msg: _m, message: _msg, ...extra } = msgOrObj as Record<string, unknown>
    logger[level](msg || (_m as string) || (_msg as string) || '', extra)
  }
}

interface FastifyLoggerAdapter {
  info: (msgOrObj: unknown, ...args: unknown[]) => void
  error: (msgOrObj: unknown, ...args: unknown[]) => void
  debug: (msgOrObj: unknown, ...args: unknown[]) => void
  warn: (msgOrObj: unknown, ...args: unknown[]) => void
  fatal: (msgOrObj: unknown, ...args: unknown[]) => void
  trace: (msgOrObj: unknown, ...args: unknown[]) => void
  child: (bindings: Record<string, unknown>) => FastifyLoggerAdapter
  silent: () => void
  level: string
}

export const fastifyLogger: FastifyLoggerAdapter = {
  info: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'info', msgOrObj, ...args),
  error: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'error', msgOrObj, ...args),
  debug: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'debug', msgOrObj, ...args),
  warn: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'warn', msgOrObj, ...args),
  fatal: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'error', msgOrObj, ...args),
  trace: (msgOrObj: unknown, ...args: unknown[]) => fastifyLog(fastifyBase, 'debug', msgOrObj, ...args),
  child: (bindings: Record<string, unknown>) => createFastifyChild((bindings.name as string) || 'fastify'),
  silent: noop,
  level: 'info',
}
