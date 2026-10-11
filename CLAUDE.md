# Orchestration

You are the lead for this repo. Workflow for every task:

1. If `graphify-out/graph.json` exists: use `graphify query "<question>"` to
   get an overview before blindly searching the repo.
2. Read the relevant concept/requirement and the current state of the repo.
3. Create a short plan (tasks), show it to the user, and wait for their OK.
4. Delegate implementation tasks to the appropriate subagents from
   `.claude/agents/` (max 3 in parallel, batched into a single message with
   multiple tool calls). Give each subagent the relevant file paths and the
   concept excerpt — subagents start without your context.
5. After every implementation: have the reviewer subagent look it over, send
   issues back to the respective dev.
6. After code changes: run `graphify . --update` (not a full rebuild) to
   keep the graph current.
7. **Update `README.md`.** Any new/changed route, table, or config variable
   gets reflected in the README's "API reference"/"Data model"/
   "Configuration" tables in the same change that adds it — the README is
   the technical overview of this repo and must never drift from the code.
8. **Tick off the Feature List.** Every feature, fix or behaviour change you
   deliver — however small — must be recorded in the vault's
   `20_Products/MyVerein/Roadmaps/Feature List - MyVerein.md` (repo
   `lpj-its-vault`): add a row or flip ⬜ → ✅ with platform and date, move
   leftovers to "Weiterhin offen", and tick the matching task package in the
   wave's `20_Products/MyVerein/PRDs/Implementation Plan - MyVerein Wave N.md`.
   Do this as part of the same piece of work (a paired vault commit on a
   branch of the same name). A feature is not done until it is ticked off. If
   the vault is not available in the session, say so explicitly in the summary
   and list the exact Feature List entries that still need to be made.
9. **All-in-one sanity check.** Before you summarize, think again about
   whether what you built actually makes sense for MyVerein as an
   **all-in-one club manager (everything digital except billing)**: Does it
   remove a media break (Excel, WhatsApp, paper) or introduce a new one? Does
   it work for every role involved (Mitglied, Vorstand, Abteilungsleitung,
   Erziehungsberechtigte, members without an account)? Are rights
   deny-by-default and the UI gated by `permissions`? Is the experience
   coherent between website and app, and understandable for non-technical
   volunteers (≤ 3 taps for core tasks, designed empty/loading/error states)?
   Report gaps honestly in the summary and record them in the plan's
   "Beitrag zum All-in-One-Ziel" section and the Feature List's
   "Weiterhin offen".
10. Summarize what was built at the end. Do NOT merge anything automatically.

## Available subagents in this repo

- `api-dev` — builds Hono routes, Drizzle schema/migrations, Better Auth
  server config, middleware.
- `backend-reviewer` — reviews backend code for quality, security, and
  adherence to the concept. Read-only, no code changes.

## Graphify

This repo uses graphify for codebase context. If `graphify-out/graph.json`
exists, use `graphify query "<question>"` to get an overview before blindly
searching the repo. To build or rebuild it, use the `/graphify` skill
(`/graphify .`) — not the standalone `graphify` CLI directly. The CLI's
default semantic-extraction backend (Gemini) needs its own API key and can
break in environments without one; the `/graphify` skill instead runs
semantic extraction through Claude itself, no separate key required.
