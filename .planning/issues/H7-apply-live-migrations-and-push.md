---
id: H7-apply-live-migrations-and-push
status: todo
type: human
depends_on: []
---
# Apply live migrations, then push (Boss)

## Definition of done
The live Supabase project has migrations 0040 and 0041, local main is pushed to GitHub, and one mock list on https://politypedia.vercel.app shows the demo mock set. Each later student migration (0049 to 0054) goes live in the same order as its code.

## What Boss does
1. Have the reviewer agent check each merged Ralph night first.
2. Ask Claude to apply 0040 and 0041 with the pgrun apply script. Apply BEFORE any push.
3. Push `main`. Vercel builds it.
4. Open the live mock list and the papers list. They must not be empty.
5. Repeat for each new student migration when its ticket is merged.

## Test that proves it
The REST read of `mock_sets` with `archived_at` returns HTTP 200 on the live project. `list_migrations` shows 0041.

## Notes
Found by the student walk on 2026-11-08: live DB lacked 0041 while the code read `archived_at`. Never push the code first.
