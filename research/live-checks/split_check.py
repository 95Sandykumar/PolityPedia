"""H3 / AS2: split one real paper with Haiku 5.5 and score it against truth.json.

Usage (from PolityPedia/):
    python research/live-checks/split_check.py research/papers/2018-07-ugcnet-polsci-p2

A question counts as right when its stem and all 4 options match the truth
(letters and digits only, similarity >= 0.85). Target: 80 of 100.
The paper is bilingual. Its Hindi text layer uses an old font and extracts as
garbage, so the check also counts how many Hindi stems come back in real
Devanagari (Unicode U+0900 to U+097F).
"""
import base64
import difflib
import json
import pathlib
import re
import sys

import anthropic

from _common import MODEL, load_key, save, token_cost

PROMPT = """This PDF is an Indian exam paper (UGC NET Political Science, Paper II).
It is bilingual: each English page is followed by the same questions in Hindi.
Split it into its multiple-choice questions.
For every question return:
- n: the question number
- stem: the full English question text, including any statements, lists or codes, without the options
- options: the 4 English answer options, in order, without the "(1)" style labels
- hindi_stem: the Hindi question text in Devanagari script, read from the page as you see it
Skip the cover page and instructions. Return every question exactly once."""

SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "stem": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "hindi_stem": {"type": "string"},
                },
                "required": ["n", "stem", "options", "hindi_stem"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["questions"],
    "additionalProperties": False,
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def is_devanagari(s: str) -> bool:
    letters = [c for c in s if not c.isspace()]
    return bool(letters) and sum(1 for c in letters if "ऀ" <= c <= "ॿ") / len(letters) > 0.5


def main() -> None:
    folder = pathlib.Path(sys.argv[1])
    truth = {q["n"]: q for q in json.loads((folder / "truth.json").read_text(encoding="utf-8"))}
    pdf_b64 = base64.standard_b64encode((folder / "paper.pdf").read_bytes()).decode()

    client = anthropic.Anthropic(api_key=load_key())
    with client.messages.stream(
        model=MODEL,
        max_tokens=64000,
        messages=[{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": PROMPT},
        ]}],
        extra_body={"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}},
    ) as stream:
        msg = stream.get_final_message()

    if msg.stop_reason != "end_turn":
        print(f"WARNING stop_reason={msg.stop_reason} (output may be cut short)")
    text = "".join(b.text for b in msg.content if b.type == "text")
    got = {q["n"]: q for q in json.loads(text)["questions"]}

    rows, right = [], 0
    for n, t in truth.items():
        g = got.get(n)
        if g is None:
            rows.append({"n": n, "ok": False, "why": "missing"})
            continue
        stem_sim = similar(g["stem"], t["stem"])
        opt_sims = [similar(a, b) for a, b in zip(g["options"], t["options"])] if len(g["options"]) == 4 else []
        ok = stem_sim >= 0.85 and len(opt_sims) == 4 and min(opt_sims) >= 0.85
        right += ok
        rows.append({"n": n, "ok": ok, "stem_sim": round(stem_sim, 3),
                     "opt_min": round(min(opt_sims), 3) if opt_sims else None,
                     "hindi_ok": is_devanagari(g["hindi_stem"]), "hindi_stem": g["hindi_stem"][:120]})

    hindi_ok = sum(1 for r in rows if r.get("hindi_ok"))
    u = msg.usage
    cost = token_cost(u.input_tokens, u.output_tokens)
    summary = {
        "check": "AS2 split accuracy", "model": MODEL, "paper": str(folder.name),
        "right": right, "total": len(truth), "extra_numbers": sorted(set(got) - set(truth)),
        "hindi_devanagari": hindi_ok, "input_tokens": u.input_tokens,
        "output_tokens": u.output_tokens, "usd": round(cost, 4), "stop_reason": msg.stop_reason,
    }
    path = save("split", {"summary": summary, "rows": rows})
    print(json.dumps(summary, indent=1))
    print(f"PASS (target 80)" if right >= 80 else "FAIL (target 80)", "| details:", path)


if __name__ == "__main__":
    main()
