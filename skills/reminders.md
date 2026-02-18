---
name: reminders
description: Set reminders and scheduled notifications for the user
triggers: [remind, reminder, notify, notification, alert, schedule, meeting, before, "in X minutes", pm, am, timer, cron]
---

## How to handle reminders

1. Parse what the user wants reminded and when
2. Calculate the absolute ISO timestamp for when the reminder should fire
3. Use the `schedule_job` tool:
   - For simple reminders: `payload_type: 'notify'`, `payload: { message: "..." }`
   - For work tasks: `payload_type: 'spawn'`, `payload: { task: "..." }`
4. Confirm to the user: what, when, which type
5. NEVER fire the notification during setup — the scheduler handles delivery

## Time calculation
- "in 5 minutes" → add 5 minutes to current time, format as ISO
- "at 4pm" → use user's timezone, today or tomorrow if already past
- "10 minutes before my 4pm meeting" → 3:50pm in user's timezone

## Managing jobs
- `list_jobs` to see all scheduled jobs
- `cancel_job` to cancel a pending job
- Jobs auto-mark as 'fired' after execution

## Common patterns
- "Remind me to X in Y minutes" → schedule_job with notify payload
- "Before my meeting, prepare X" → schedule_job with spawn payload
- "Cancel my reminder" → list_jobs to find it, then cancel_job
