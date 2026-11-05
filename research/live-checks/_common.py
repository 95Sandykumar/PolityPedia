"""Shared helpers for the H3 live checks. No secret is ever printed."""
import json
import os
import pathlib
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]  # PolityPedia/
RESULTS = pathlib.Path(__file__).resolve().parent / "results"
MODEL = "claude-haiku-5-5"
# Haiku 5.5 list price, from the claude-api skill (python/claude-api/README.md).
USD_PER_M_IN = 0.10
USD_PER_M_OUT = 0.50
USD_PER_SEARCH = 0.01  # $10 per 1,000 web searches


def load_key() -> str:
    """ANTHROPIC_API_KEY from the environment, else PolityPedia/.env.local, else web/.env.local."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    for f in (ROOT / ".env.local", ROOT / "web" / ".env.local"):
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("No ANTHROPIC_API_KEY. Put it in PolityPedia/.env.local (gitignored).")


def token_cost(input_tokens: int, output_tokens: int, searches: int = 0) -> float:
    return (input_tokens * USD_PER_M_IN + output_tokens * USD_PER_M_OUT) / 1e6 + searches * USD_PER_SEARCH


def save(name: str, data: dict) -> pathlib.Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return path
