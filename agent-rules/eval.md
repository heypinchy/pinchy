# Eval Dataset

Read this before committing eval data under `packages/web/eval/` or changing `model-resolver/blocklist.ts`. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

## No Unread Catastrophic Eval Cell

The Eval-v1 dataset (`packages/web/eval/data`) is committed evidence, and evidence nobody reads protects nobody. The 2026-07-11 sweep measured `minimax-m3` at 0/12 on the line-items scenario — the only one that needs nested-array tool arguments. Four days later a production agent failed to book invoices on that model, for that defect (#766). The number was in the repo the whole time; nothing wired it to `model-resolver/blocklist.ts`.

`packages/web/eval/__tests__/scorecard-triage-guard.test.ts` is the wire. It runs in vitest against the checked-in dataset (~2s, no docker stack, no API keys — `pnpm -C packages/web eval:models` needs both, and CI runs only `eval:selftest`), so it gates every PR, including the one that commits a fresh sweep. It judges the **published** numbers, via `buildPublishedScenarios()` from `eval/export-scorecard.ts` — not the stored `data/<scenario>.json` scorecards, which three re-graded scenarios have since diverged from.

It flags a cell where a **capable** model passed **zero** of at least 8 valid runs — capable meaning a median pass rate ≥ 0.5 across the _other_ capability scenarios. That anchor is load-bearing: a weak model's zero is not information (weak models even _pass_ some failure scenarios by incapacity, see `eval/data/README.md`), and flagging them would bury the signal. Every flagged cell needs a committed verdict in `packages/web/eval/triage-ledger.ts`:

- **`blocked`** — `blocklist.ts` names the model, and the guard asserts the rule really exists for the capabilities the entry claims.
- **`accepted`** — you looked and concluded it is not blocklist material, with the reason written down.

Both drift directions fail: a flagged cell with no entry, and an entry whose cell no longer flags (a verdict must not outlive its evidence).

**A flag is a reason to look, never a reason to block.** The eval grades outcomes — it re-reads Odoo state after a run and never inspects a tool-call payload — so it can ground a suspicion, not a cause. Do not turn the threshold into a blocklist generator: of the four cells flagged today only one is a tool defect; the others are a judgement defect (`gemma4:31b` duplicates blindly) and honesty defects (`false-success`). Those are handled by ranking and by the methodology, not by a denylist. The blocklist stays evidence-based: what it does not name is allowed.
