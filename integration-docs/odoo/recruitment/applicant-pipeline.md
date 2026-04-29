---
title: "Recruitment Applicant Pipeline"
description: "hr.applicant model, stage and kanban state, priority levels, won/hired tracking, and partner handling"
---

## The Applicant Model

`hr.applicant` tracks candidates through a recruitment pipeline. It works similarly to `crm.lead` — stage-based kanban workflow with readiness signals.

Key fields:
- `job_id`: The job position being filled (`hr.job`)
- `stage_id`: Current recruitment stage (`hr.recruitment.stage`)
- `partner_name`: Candidate's name (plain text — not linked to `res.partner` by default)
- `email_from`: Candidate's email address
- `user_id`: Responsible recruiter

## Kanban State

`kanban_state` signals readiness to move to the next stage:

- `"normal"`: In review, no special status
- `"done"`: Ready to advance (green)
- `"blocked"`: Something is blocking progress (red)

## Priority

`priority` is a selection field ranking candidate quality:

| value | Label |
|---|---|
| `"0"` | Normal |
| `"1"` | Good |
| `"2"` | Excellent |
| `"3"` | Top |

## Date Fields

- `date_open`: When the applicant entered the current stage (updated on stage change)
- `date_closed`: When the recruitment process closed (hired or refused)
- `date_last_stage_update`: Last time `stage_id` changed

## Job Position Fields

`hr.job` tracks open and filled positions:

- `no_of_recruitment`: Target number of new hires for this position
- `no_of_hired_employee`: Count of applicants converted to employees (computed)
- `no_of_expected_employee`: Expected total headcount including current employees

## Marking as Hired

When an applicant is hired, `hr.applicant` has an action to create an `hr.employee` record. The applicant `stage_id` moves to the "hired" stage (configured per company).

## Gotchas

- `partner_name` and `email_from` are plain text fields — there is no automatic `res.partner` link unless the applicant has sent a message via the portal (which creates a partner).
- Multiple applicants for the same job: filter by `job_id` to scope queries per position.
- Refused/archived applicants have `active=false` — default searches exclude them. Add `active=false` to the domain explicitly to include refused candidates.
