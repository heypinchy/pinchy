---
name: document-comparison
description: Evaluate several documents against a shared set of criteria — proposals against requirements, contracts against each other, policies against a standard, candidates against a role. Use whenever the answer is a comparison, a ranking, a scoring, or a gap analysis. Covers fixing the criteria before reading, keeping the evaluation symmetric, separating "not stated" from "no", and presenting the result so a reader can check it.
---

# Comparing documents against criteria

Comparison work fails in a characteristic way: the criteria drift while you read. The first document sets the vocabulary, later documents get judged on whatever it happened to mention, and a vendor who simply wrote more looks better than one who wrote less. This skill exists to keep the evaluation symmetric.

## When to use

- Comparing several documents to each other (proposals, quotes, contracts, candidate profiles)
- Checking one or more documents against an external standard (a regulation, a policy, a job description, a requirements list)
- Any ask phrased as "which is better", "rank these", "where are the gaps", "does this meet X"

## When NOT to use

- A question about a single document with no yardstick — that's ordinary reading, not comparison
- A recommendation the user has not asked for. Compare when asked to compare; recommend when asked to recommend

## Workflow

1. **Fix the criteria before you read.** Write down the list of criteria first — from the user's stated requirements, the standard being applied, or the role being filled. If the user gave none, derive a list from the documents' shared subject matter and **state it explicitly at the top of your answer** so they can correct it. Criteria chosen after reading are criteria fitted to a winner.
2. **Extract the same fields from every document.** Go criterion by criterion, document by document. Never stop early because one document already looks like the answer.
3. **Record "not stated" as its own value.** A document that is silent on a criterion has not declined it and has not agreed to it. Absence of a commitment is a finding in its own right — often the most important one — and it must never be rendered as a "no", as a zero, or as a blank cell the reader will read as either.
4. **Cite where each value came from.** Every cell in your comparison traces to a document and a location inside it (section, clause, article, page label — whatever the document itself provides). A comparison nobody can check is an opinion in a table.
5. **Compare like with like.** Normalize before you rank: different currencies, different terms (monthly vs annual), different scopes (with or without support, with or without VAT), different units. State every normalization you performed. An unstated normalization is indistinguishable from an error.
6. **Score only against stated criteria, and show the scale.** If you rank or score, say what the scale is and what each level means, and apply it identically to every document. Do not invent a weighting the user never gave; if weighting matters, ask or present the ranking under the unweighted criteria.
7. **Flag vague and non-committal language.** "Industry-standard", "best effort", "as required", "typically", "up to" — record what was actually promised, not the impression the wording leaves.

## Safety (must hold)

- Never fill a gap by inference. If a document doesn't state a price, a date, a certification, or a qualification, the value is "not stated" — not the value a comparable document had, and not what is customary.
- Judge the document, not the author. Evaluate the stated content against the criteria; do not weigh presentation quality, writing style, or personal characteristics.
- Keep the criteria visible. If you drop or add one mid-analysis, say so; silently changing the yardstick invalidates every earlier row.

## Output format

- Lead with the comparison table: one row per criterion, one column per document. Criteria down the side keeps rows comparable when a document is added later.
- Use a consistent marker set and define it once — for example: the stated value, `—` for **not stated**, and `?` for **could not be read**. Never let those three collapse into one symbol.
- Follow the table with the differences that actually matter, in prose: where the documents genuinely diverge, and what a decision would turn on.
- Give a recommendation only when asked, and make its basis explicit: which criteria drove it, and what would change it.
- End with what you could not evaluate — criteria no document addressed, documents you could not read. Role-specific formatting and domain-specific criteria belong in the agent's own persona instructions, not in this shared skill.
