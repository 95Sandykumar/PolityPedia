---
id: 50-mock-editor-power-tools
status: todo
type: afk
depends_on: [49-subjects-and-topics]
---
# Mock editor: reorder, duplicate, move, bulk paste, preview as student, publish checklist

## Context
PolityPedia is a Next.js web app in `web/`. Conventions: `web/CLAUDE.md`, `web/AGENTS.md`, `web/DESIGN.md`. Design: `.planning/intake/2026-11-06-teacher-v1.1/design.md` sections 5 and 6. DB tests use PGlite. No migration in this ticket unless a function is strictly needed; if so, use **0049** and say why in the header.

Today: `/teacher/mocks/[setId]`, APIs under `/api/teacher/mock-sets/...` and `/api/teacher/questions`. `publish_mock_set()` refuses unchecked questions. Unique `(test_id, number)` index on questions. Answer-key changes after publish go through the key lock (`0030_exam_key_lock.sql`); keep that path.

## What to build
1. Reorder questions inside a test and tests inside a set (drag on desktop, up/down buttons everywhere). Renumbering is one transaction (RPC `reorder_questions(test_id, ids[])`) so the unique index never trips.
2. Duplicate a question, duplicate a whole test (new draft, unchecked), move a question to another test of the same set.
3. Bulk paste: a text box that parses this format (pure function `parseBulkQuestions`), shows a preview table with per-row errors, and saves only valid rows as unchecked drafts:
   ```
   1. Who wrote Leviathan?
   (A) Locke (B) Hobbes (C) Rousseau (D) Mill
   Ans: B
   Exp: Hobbes, 1651.
   Topic: Western political thought
   ```
   Accept `a)`/`(a)`/`A.` option styles, Hindi text, options on separate lines, missing Exp/Topic. Max 200 per paste.
4. Preview as student: opens the existing player in read-only practice mode for the draft (teacher only, nothing recorded).
5. Publish checklist panel: question count, unchecked count, missing answer, missing topic (warning only), duplicate stems (warning). Publish button stays disabled while any hard error exists.
6. Autosave draft edits (debounced 1.5 s, one request per pause, "Saved" indicator).
7. Live set: editing stem/options/explanation of a live question is allowed (typo fix, `edited` mark); changing `correct_idx` goes through the key-lock flow; removing a live question uses the archive path from ticket 45.

## Test that proves it
Parser: 12+ cases incl. Hindi, broken option count, missing answer, 201 rows. PGlite: reorder keeps numbers 1..n with no gaps; duplicate test copies questions unchecked; moving to another teacher's test refused. `npm test`, `npm run typecheck`, `npm run build` pass.

## Scope guard
No .docx import, no question bank, no AI writer (Upcoming). Do not edit package.json.
