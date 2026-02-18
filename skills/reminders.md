---
name: reminders
description: Set reminders and scheduled notifications for the user
triggers: [remind, reminder, notify, notification, alert, schedule, meeting, before, "in X minutes", pm, am]
---

## How to handle reminders

1. Parse what the user wants reminded and when
2. Create a cron job with the appropriate payload:
   - `notify` payload for simple reminders (message back to user)
   - `spawn` payload for work tasks (sub-agent does something at the scheduled time)
3. Confirm to the user: what will be reminded, when it will fire, what type
4. NEVER fire the notification during setup — the cron system handles delivery at the scheduled time
5. For relative times ("in 5 minutes"), calculate the absolute time from now
6. For clock times ("at 4pm"), use the user's timezone if known

## Common patterns
- "Remind me to X in Y minutes" → one-shot cron, notify payload
- "Remind me about X before my Y meeting" → one-shot cron, calculate time
- "Every day at 9am, check X" → recurring cron, spawn payload with task description
