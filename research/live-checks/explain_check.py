"""H3 / AS3 + X7: make 1 real AI explanation and measure its cost.

Usage (from PolityPedia/):
    python research/live-checks/explain_check.py research/papers/2018-07-ugcnet-polsci-p2

Uses question 100 of the 2018 paper. Its answer is certain: "Neo-Colonialism:
The Last Stage of Imperialism" is by Kwame Nkrumah, not Julius Nyerere, so (4)
is the mismatched pair. X7: tries web_search_20260209 first and falls back to
web_search_20250305 if Haiku 5.5 rejects it. Design estimate: $0.022 per new
explanation with 2 searches.
"""
import json
import pathlib
import sys

import anthropic

from _common import MODEL, load_key, save, token_cost

ESTIMATE_USD = 0.022
QUESTION_N = 100
CORRECT = 4
TOOL_VERSIONS = ["web_search_20260209", "web_search_20250305"]

PROMPT = """You are a Political Science teacher for UGC NET students in India.
A student answered this question wrong. Explain the right answer in simple English,
in 120 to 180 words. Say why the right option is right and why the student's pick
is wrong. Check facts with web search when you are not sure. End with one line:
"Remember:" and a short memory tip.

Exam: UGC NET Political Science, Paper II
Question: {stem}
(1) {o1}
(2) {o2}
(3) {o3}
(4) {o4}
Right answer: ({correct})
Student picked: (2)"""


def run(client: anthropic.Anthropic, prompt: str, tool_type: str):
    messages = [{"role": "user", "content": prompt}]
    tools = [{"type": tool_type, "name": "web_search", "max_uses": 2}]
    totals = {"input_tokens": 0, "output_tokens": 0, "searches": 0}
    for _ in range(3):  # bounded: resume a paused server-tool turn at most twice
        with client.messages.stream(model=MODEL, max_tokens=4000, messages=messages, tools=tools,
                                    extra_body={"output_config": {"effort": "low"}}) as stream:
            msg = stream.get_final_message()
        totals["input_tokens"] += msg.usage.input_tokens
        totals["output_tokens"] += msg.usage.output_tokens
        stu = getattr(msg.usage, "server_tool_use", None)
        totals["searches"] += getattr(stu, "web_search_requests", 0) or 0
        if msg.stop_reason != "pause_turn":
            break
        messages.append({"role": "assistant", "content": msg.content})
    text = "".join(b.text for b in msg.content if b.type == "text")
    return text, totals, msg.stop_reason


def main() -> None:
    folder = pathlib.Path(sys.argv[1])
    q = next(x for x in json.loads((folder / "truth.json").read_text(encoding="utf-8")) if x["n"] == QUESTION_N)
    o = q["options"]
    prompt = PROMPT.format(stem=q["stem"], o1=o[0], o2=o[1], o3=o[2], o4=o[3], correct=CORRECT)

    client = anthropic.Anthropic(api_key=load_key())
    accepted, rejected = None, {}
    for version in TOOL_VERSIONS:
        try:
            text, totals, stop = run(client, prompt, version)
            accepted = version
            break
        except anthropic.BadRequestError as e:
            rejected[version] = str(e)[:300]
    if accepted is None:
        raise SystemExit(f"Both web search versions rejected: {rejected}")

    usd = token_cost(totals["input_tokens"], totals["output_tokens"], totals["searches"])
    summary = {
        "check": "AS3 cost of 1 explanation + X7 web search version", "model": MODEL,
        "question": QUESTION_N, "web_search_version_accepted": accepted, "rejected": rejected,
        **totals, "usd": round(usd, 4), "estimate_usd": ESTIMATE_USD,
        "vs_estimate": f"{usd / ESTIMATE_USD:.0%}", "stop_reason": stop,
    }
    path = save("explain", {"summary": summary, "explanation": text})
    print(json.dumps(summary, indent=1))
    print("\n--- explanation ---\n" + text)
    print("\ndetails:", path)


if __name__ == "__main__":
    main()
