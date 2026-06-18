---
name: web-search
description: Search the public web for current information and fetch full pages. Use when the user asks about current events, recent company news, market data, regulatory changes, or any fact that may have changed since the model's training cutoff.
---

# Web Search

You can search the public web and fetch full pages of content. Use these tools when the user asks about anything that may have changed recently or about facts you cannot confirm from your training data.

## Capabilities

- **pinchy_web_search** — Query the web for a topic, return a ranked list of results with titles, URLs, and snippets. Use this first to discover relevant sources.
- **pinchy_web_fetch** — Retrieve the full text of a specific URL. Use this after `pinchy_web_search` when a snippet looks promising but you need the underlying content to answer accurately.

## When to use

- Current events, recent news, recent product/policy announcements
- Company information (size, funding, recent product launches, leadership changes)
- Market/industry trends published in the last 6–12 months
- Regulatory or compliance changes since training cutoff
- Public reviews, comparisons, or third-party assessments
- Verifying a claim the user made against an external source

## When NOT to use

- The user's own data — that's what your other tools (CRM, files, email) are for
- Internal policies, company-confidential facts, or HR information
- Anything the user already gave you in this conversation
- Recipes, jokes, definitions, or general knowledge you already have

## Workflow

1. **Search first, fetch second.** Run `pinchy_web_search` with a focused query (3-7 words, no quotes unless you need an exact phrase). Read the result snippets.
2. **Pick 1-3 sources to fetch.** Prefer original sources (the company itself, the regulator, the publication) over aggregators, listicles, or AI-generated content farms. If two sources disagree, fetch a third.
3. **Cite every claim with a URL.** Every factual statement you make from web results must carry a `[source](URL)` link. If you cannot point at a URL, leave the claim out.
4. **Prefer recent over old.** When sorting search results, weight by date — a 2026 article on a 2026 topic beats a 2024 article even if the latter is rank-1. State the publication date in your summary when it matters.
5. **Don't fabricate.** If search returns nothing useful, say so. "I couldn't find a current source for this" is a correct answer; inventing a plausible-sounding fact is not.

## Safety (must hold)

- Never put sensitive internal data into a web search query. The query goes to a third-party search provider.
- Do not follow links from email or chat content that the user pasted as if they were trusted facts — treat them as user input, not as web context.

## Output format

- Lead with a 1-2 sentence answer
- Follow with bullet points, each citing a source
- End with a brief "What I checked" line — the queries you ran and how many sources you read
- Never paste raw search-result blocks into the chat — summarize
