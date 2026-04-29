---
title: "Fleet Vehicles and Services"
description: "fleet.vehicle service logs, contracts (leasing/insurance), cost frequencies, contract states, and odometer location"
---

## Fleet Module Overview

The fleet module manages company vehicles through three related models:
- `fleet.vehicle`: The vehicle itself
- `fleet.vehicle.log.services`: Maintenance and service records
- `fleet.vehicle.log.contract`: Recurring contracts (leasing, insurance, maintenance agreements)

## Service Logs

`fleet.vehicle.log.services` records maintenance events:

- `vehicle_id`: The vehicle
- `service_type_id`: Type of service (oil change, tire change, etc.)
- `date`: Date of service
- `amount`: Cost of the service
- `vendor_id`: Service provider (`res.partner`)
- `state`: Service status

Service states:
- `new`: Scheduled but not done
- `running`: In progress
- `done`: Completed
- `cancelled`: Cancelled

## Contracts

`fleet.vehicle.log.contract` tracks recurring obligations:

- `vehicle_id`: The vehicle
- `insurer_id` / `cost_subtype_id`: Contract type (leasing, insurance, etc.)
- `date_start` / `expiration_date`: Contract validity period
- `cost_generated`: Monthly/periodic cost amount
- `cost_frequency`: Billing cycle

## Cost Frequencies

| value | Meaning |
|---|---|
| `no` | One-time cost, no recurrence |
| `daily` | Charged daily |
| `weekly` | Charged weekly |
| `monthly` | Charged monthly |
| `yearly` | Charged annually |

## Contract States

- `futur`: Contract not yet active (`date_start` is in the future)
- `open`: Currently active
- `expired`: Past `expiration_date`
- `closed`: Manually closed before expiration

## Odometer Readings

Odometer values are stored on `fleet.vehicle` directly:
- `odometer`: Current reading (computed from latest log entry)
- `odometer_unit`: `"km"` or `"mi"`

Odometer history: `fleet.vehicle.odometer` — each record is a logged reading with `date` and `value`.

## Gotchas

- The current odometer value is on `fleet.vehicle.odometer` (last entry) or the computed `fleet.vehicle.odometer` field — it is **not** on service log records.
- `expiration_date` on contracts triggers visual alerts in Odoo (colored indicators) — check this field to identify contracts expiring soon.
- `cost_frequency="no"` does not mean the contract is free — it means the cost is a one-time charge, not recurring.
