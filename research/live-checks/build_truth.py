"""Build ground truth (English questions + 4 options) from the extracted paper text.

Usage: python build_truth.py <paper_text.txt> <out.json>
A line counts as Hindi garble when more than 20% of its letters are non-ASCII.
"""
import json
import re
import sys

src, out = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().splitlines()


def is_garble(s: str) -> bool:
    letters = [c for c in s if not c.isspace()]
    if not letters:
        return False
    return sum(1 for c in letters if ord(c) > 127) / len(letters) > 0.2


# Skip the cover pages: start at the "Note : This paper contains" line.
start = next(i for i, l in enumerate(lines) if l.startswith("Note : This paper contains"))
body = [l for l in lines[start + 1:] if not is_garble(l)]

questions = {}
expected = 1
cur = None
for line in body:
    # The printed paper drops the period on some numbers (Q55 reads "55 The ...").
    m = re.match(r"^(\d{1,3})\.\s+(.*)$", line) or re.match(r"^(\d{1,3})\s+([A-Z].*)$", line)
    if m and int(m.group(1)) == expected:
        cur = expected
        questions[cur] = [m.group(2)]
        expected += 1
        continue
    if cur is not None:
        # Drop running headers and page footers.
        if re.search(r"J-00218|Paper-II|P\.T\.O\.", line):
            continue
        questions[cur].append(line)

result = []
for n in sorted(questions):
    text = " ".join(questions[n])
    text = re.sub(r"\s+", " ", text).strip()
    # End-of-booklet footer lands on the last question.
    text = re.sub(r"\s*-\s*o O o\s*-.*$", "", text)
    parts = re.split(r"\((\d)\)\s*", text)
    # parts = [stem, '1', opt1, '2', opt2, ...]; options are the LAST (1)..(4) run.
    opts = {}
    stem = parts[0]
    for i in range(1, len(parts) - 1, 2):
        opts.setdefault(parts[i], []).append(parts[i + 1].strip())
    options = [opts[k][-1] if k in opts else None for k in "1234"]
    result.append({"n": n, "stem": stem.strip(), "options": options,
                   "has_4_options": all(options)})

json.dump(result, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
ok = sum(1 for q in result if q["has_4_options"])
print(f"questions found: {len(result)}  with 4 options: {ok}")
for q in result:
    if not q["has_4_options"]:
        print("CHECK", q["n"], q["stem"][:80], q["options"])
