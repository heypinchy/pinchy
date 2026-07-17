# Screenshot Scenario: Springfield Energy

Pinchy's demo screenshots use a fictional company inspired by _The Simpsons_.
References are subtle — first names and plausible job titles only, never
full cartoon names. Fans will grin; everyone else sees a normal enterprise demo.

## Company

**Springfield Energy** — `snpp.com`
A mid-size energy company running Pinchy to give every team AI-powered assistants.

## Admin / Primary User

| Name        | Email          | Role  | Inspiration                    |
| ----------- | -------------- | ----- | ------------------------------ |
| Monty Burns | monty@snpp.com | admin | C. Montgomery Burns — the boss |

**Smithers chat message (typed in input, not sent):**

> "It's Burns. Industrialist, bon vivant, amateur lepidopterist. Keep answers brief and never mention the word 'union.' Excellent."

This mirrors Burns' self-aggrandizing introductions from the show.

## Agents

| Name     | Tagline                               | Preset        | Inspiration                                          |
| -------- | ------------------------------------- | ------------- | ---------------------------------------------------- |
| Smithers | Your reliable personal assistant      | the-butler    | Waylon Smithers — Burns' devoted assistant           |
| Frink    | Reactor docs and safety protocols     | the-professor | Prof. Frink — the absent-minded genius               |
| Tibor    | Infrastructure and deployment support | the-pilot     | Tibor — the mysterious employee no one has ever seen |
| Mindy    | New employee onboarding               | the-coach     | Mindy Simmons — the new hire at the plant            |

## Users

| Name          | Email          | Role   | Status  | Inspiration                         |
| ------------- | -------------- | ------ | ------- | ----------------------------------- |
| Monty Burns   | monty@snpp.com | admin  | active  | Mr. Burns                           |
| Carl Carlson  | carl@snpp.com  | admin  | active  | Carl Carlson — competent supervisor |
| Homer Jay     | homer@snpp.com | member | active  | Homer J. Simpson                    |
| Lenny Leonard | lenny@snpp.com | member | active  | Lenny Leonard                       |
| Frank Grimes  | frank@snpp.com | member | pending | "Grimey" — the overachiever intern  |

## Groups

| Group               | Description                           | Members                   | Agents       |
| ------------------- | ------------------------------------- | ------------------------- | ------------ |
| Reactor Operations  | Core reactor team and shift workers   | Monty, Carl, Homer, Lenny | Frink, Tibor |
| Safety & Compliance | Safety protocols and NRC compliance   | Monty, Carl               | Frink        |
| Executive Office    | Executive team and strategic planning | Monty, Carl               | —            |

## Directories (for Frink — knowledge agent)

Mounted under `/data/` in docker-compose:

| Path                       | Label                     | Selected for Frink? |
| -------------------------- | ------------------------- | :-----------------: |
| `/data/reactor-operations` | Reactor Operations Manual |         ✅          |
| `/data/safety-protocols`   | Safety Protocols          |         ✅          |
| `/data/employee-handbook`  | Employee Handbook         |         ✅          |
| `/data/nrc-inspections`    | NRC Inspection Reports    |          ☐          |
| `/data/executive-memos`    | Executive Communications  |          ☐          |
| `/data/budget-reports`     | Budget & Procurement      |          ☐          |

## Agent Access (Frink)

- **Visibility:** Restricted
- **Allowed groups:** Reactor Operations, Safety & Compliance
- _(Not Executive Office — the execs don't need to poke around the reactor docs)_

## Audit Trail Events (seeded)

Diverse entries spanning ~14 days, covering:

- `auth.login` — various users
- `agent.created` — Frink, Tibor, Mindy
- `user.invited` — team members joining
- `agent.updated` — permission/personality changes
- `tool.executed` — Frink reading safety docs, Tibor running deploys
- `user.role_changed` — Carl promoted to admin
- `settings.updated` — provider configuration
- `group.created` — group setup

## Usage Data (seeded)

30 days of realistic token usage across all 4 agents and 4 users:

- **Models:** Smithers & Mindy use Haiku, Frink & Tibor use Sonnet
- **Volume:** 10-25 messages/weekday, 4-10 on weekends
- **Costs:** Estimated from model pricing ($0.80/$4 for Haiku, $3/$15 for Sonnet per 1M tokens)
- **Users:** Monty (40%), Carl (25%), Homer (20%), Lenny (15%) — weighted by activity

## Extending This Scenario

When adding new screenshots or features:

1. Keep names consistent with the table above
2. New users → pick another Simpsons character, use first name + plausible surname
3. New agents → pick a character whose personality matches the agent template
4. Keep it subtle: no cartoon imagery, no "D'oh!", no yellow skin
