// Cron/scheduler — in-process one-shot job scheduler backed by SQLite

import type Database from 'better-sqlite3'
import { createLogger } from './logger.js'
import type { createRouter } from './router.js'

const log = createLogger('cron')

export interface CronJob {
  id: string
  name: string
  schedule_at: string
  repeat_cron: string | null
  payload_type: 'notify' | 'spawn'
  payload: string
  created_at: string
  status: string
}

export interface CreateJobOpts {
  name: string
  schedule_at: string
  payload_type: 'notify' | 'spawn'
  payload: Record<string, unknown>
}

let _db: Database.Database | null = null
let _router: ReturnType<typeof createRouter> | null = null
let _spawnFn: ((task: string) => void) | null = null
const _timers = new Map<string, ReturnType<typeof setTimeout>>()

function fireJob(job: CronJob): void {
  if (!_db) return
  log.info('Firing job', { id: job.id, name: job.name, type: job.payload_type })

  // Mark as fired
  _db.prepare('UPDATE cron_jobs SET status = ? WHERE id = ?').run('fired', job.id)
  _timers.delete(job.id)

  const payload = JSON.parse(job.payload) as Record<string, unknown>

  if (job.payload_type === 'notify' && _router) {
    const message = (payload.message as string) ?? job.name
    _router.push({
      channel: 'tui',
      conversation: 'tui',
      messages: [
        {
          id: Date.now(),
          channel: 'tui',
          sender: 'system',
          conversation: 'tui',
          payload: `🔔 Scheduled reminder: ${message}`,
          receivedAt: new Date().toISOString(),
          priority: 5,
          routed: true,
        },
      ],
    })
  } else if (job.payload_type === 'spawn' && _spawnFn) {
    const task = (payload.task as string) ?? job.name
    _spawnFn(task)
  }
}

function scheduleTimer(job: CronJob): void {
  const delay = new Date(job.schedule_at).getTime() - Date.now()
  if (delay <= 0) {
    // Already past — fire immediately
    fireJob(job)
    return
  }
  // Cap at ~24 days (setTimeout max safe delay) — re-check on next boot if longer
  const maxDelay = 2_147_483_647
  if (delay > maxDelay) {
    log.info('Job too far in future, will schedule on next boot', { id: job.id, schedule_at: job.schedule_at })
    return
  }
  const timer = setTimeout(() => fireJob(job), delay)
  _timers.set(job.id, timer)
  log.info('Scheduled job', { id: job.id.slice(0, 8), name: job.name, delay: Math.round(delay / 1000) })
}

export function initCron(
  db: Database.Database,
  router: ReturnType<typeof createRouter>,
  spawnFn?: (task: string) => void,
): void {
  _db = db
  _router = router
  _spawnFn = spawnFn ?? null

  // Load pending jobs and schedule them
  const jobs = db.prepare("SELECT * FROM cron_jobs WHERE status = 'pending'").all() as CronJob[]
  log.info(`Loading ${jobs.length} pending job(s)`)
  for (const job of jobs) {
    scheduleTimer(job)
  }
}

export function createJob(opts: CreateJobOpts): CronJob {
  if (!_db) throw new Error('Cron not initialized')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const payloadStr = JSON.stringify(opts.payload)

  _db
    .prepare(
      'INSERT INTO cron_jobs (id, name, schedule_at, repeat_cron, payload_type, payload, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, opts.name, opts.schedule_at, null, opts.payload_type, payloadStr, now, 'pending')

  const job: CronJob = {
    id,
    name: opts.name,
    schedule_at: opts.schedule_at,
    repeat_cron: null,
    payload_type: opts.payload_type,
    payload: payloadStr,
    created_at: now,
    status: 'pending',
  }

  scheduleTimer(job)
  return job
}

export function cancelJob(id: string): boolean {
  if (!_db) throw new Error('Cron not initialized')
  const timer = _timers.get(id)
  if (timer) {
    clearTimeout(timer)
    _timers.delete(id)
  }
  const result = _db.prepare("UPDATE cron_jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id)
  return result.changes > 0
}

export function listJobs(): CronJob[] {
  if (!_db) throw new Error('Cron not initialized')
  return _db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC LIMIT 50').all() as CronJob[]
}
