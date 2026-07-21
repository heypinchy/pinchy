---
name: odoo-activities
description: Schedule, complete, and reschedule Odoo activities (the "needs attention" follow-ups on any record) with the odoo_schedule_activity / odoo_complete_activity / odoo_reschedule_activity tools. Use whenever an agent adds, closes, or pushes a follow-up on a lead, order, ticket, request, or any record. Explains why you must never odoo_create / odoo_write on mail.activity directly.
---

# Managing activities (follow-ups)

`mail.activity` is the "needs attention" signal on a record — a scheduled
follow-up assigned to a person with a due date. It is how a team sees which
lead, order, or request still needs action.

**Read** activities with `odoo_read` on `mail.activity` (filter `state`:
`"overdue"`, `"today"`, `"planned"`). **Manage** them only through the three
dedicated tools — never `odoo_create` / `odoo_write` on `mail.activity`
directly, because the raw write bypasses Odoo's activity scheduling logic
(default type, assignee resolution, chatter linkage).

- **Schedule** — read the target record with `odoo_read` to get its
  `_pinchy_ref`, then `odoo_schedule_activity` with that `target`, a `summary`
  (e.g. "Call about the quote"), and a `dueDate` (`YYYY-MM-DD`). It defaults to a
  "To-Do" assigned to the record's owner/salesperson.
- **Complete** — once handled, `odoo_read` the activity on `mail.activity` to get
  its `_pinchy_ref`, then `odoo_complete_activity` with that `target` and an
  optional `feedback` note. This marks it done and clears it from the to-do list.
- **Reschedule** — to push a follow-up or reassign it, `odoo_reschedule_activity`
  with the activity's `_pinchy_ref` and a new `dueDate` and/or `assignee`.

## When to use

- The user asks to follow up on, chase, or set a reminder on a record.
- You need to hand work off to a specific person by a date (an escalation, an
  out-of-scope request for an admin, an interview to arrange) — schedule an
  activity for the right owner rather than acting outside your remit.
- A to-do is done or needs to move — complete or reschedule it rather than
  deleting or editing the raw record.
