---
id: 76-topic-filter
status: blocked
type: afk
depends_on: [68-free-test-card-and-mock-list-cleanup, 49-subjects-and-topics]
---
# Practise by topic

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, look and feel `web/DESIGN.md`. Evidence: walk persona-1 gap 9, persona-2 gap 5. Teacher ticket 49 adds the subjects and topics tables (migration 0045). This ticket reads them and adds no migration. DB tests use PGlite. Do not apply migrations to the live database. Strings in EN and HI.

## Definition of done
The mock list and Practice show a topic filter fed by the real subjects and topics, listing only topics that have questions in live, non-archived sets the student can read. Choosing a topic starts a topic practice sitting through the existing topic path in practice mode. No dead dropdown: with no topics, the filter is hidden.

## Vertical slice
- service: topic list reader with question counts
- UI: filter on the mock list and Practice hub, start action

## Test that proves it
PGlite: topics from draft or archived sets are excluded; counts are right; the sitting uses only that topic's questions. Component tests. `npm test`, `npm run typecheck`, `npm run build` pass.

## Design constraints
Reuse the topics read rules from 0045. A page view must not write: the sitting starts on a Start tap.

## Notes / scope guard
No weak-topic logic (ticket 77).

<!-- ralph 2026-11-09T18:51:51.038Z: upstream 56-result-page blocked -->
