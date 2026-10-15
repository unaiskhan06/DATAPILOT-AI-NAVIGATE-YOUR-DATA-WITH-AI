"""
llm_agent.py
Agent Mode brain for DataPilot AI.

Turns a free-form user instruction (e.g. "remove all null rows and drop the id column")
into a structured list of operations that data_ops.apply_operation understands.

Uses ANY OpenAI-compatible LLM endpoint, configured via environment variables
(loaded from a local .env file):

  OPENAI_BASE_URL  - e.g. http://localhost:11434/v1 for a local Ollama server
  OPENAI_MODEL     - e.g. llama3.1
  OPENAI_API_KEY   - optional; NOT required for local providers like Ollama

By default it targets a **free, unlimited, local** model served by Ollama, so no
API key and no internet connection are needed. Keys, when used, are NEVER hardcoded.
"""
from __future__ import annotations

import json
import os
import re

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None


# The catalogue of operations the model is allowed to emit.
OPERATION_SPEC = """
Available operations (name -> params):
- remove_null_rows { "columns": [optional list] }
- remove_null_columns { "threshold": optional float 0-1 }
- remove_duplicates { "columns": [optional list] }
- fill_missing { "columns": [optional list], "method": "mean|median|mode|ffill|bfill|value", "value": optional }
- drop_columns { "columns": [list] }
- rename_column { "old": str, "new": str }
- change_type { "column": str, "to": "int|float|str|datetime" }
- strip_whitespace { "columns": [optional list] }
- to_lowercase { "columns": [optional list] }
- filter_rows { "column": str, "operator": "==|!=|>|>=|<|<=|contains", "value": any }
- sort { "column": str, "ascending": bool }
- replace_values { "column": optional str, "find": any, "replace": any }
- delete_row { "row": int }
- add_row { "values": { col: value } }
- edit_cell { "row": int, "column": str, "value": any }
"""

SYSTEM_PROMPT = """You are DataPilot AI's data-cleaning agent.
Convert the user's instruction into a JSON object describing pandas operations to apply
to their tabular dataset. Only use the operations listed. Use EXACT column names given.

Respond with ONLY valid JSON in this shape:
{
  "operations": [ { "name": "<op>", "params": { ... } }, ... ],
  "explanation": "one short sentence describing what you will do"
}
If the request cannot be mapped to any operation, return an empty operations list and
explain why in the explanation field.
"""


# Default to a local Ollama server: free, unlimited, no API key, works offline.
DEFAULT_BASE_URL = "http://localhost:11434/v1"
DEFAULT_MODEL = "llama3.1"


def _get_client() -> tuple:
    if OpenAI is None:
        return None, None
    base_url = os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL)
    model = os.getenv("OPENAI_MODEL", DEFAULT_MODEL)
    # Local providers (Ollama, LM Studio, ...) ignore the key, but the SDK
    # requires a non-empty string, so fall back to a harmless placeholder.
    api_key = os.getenv("OPENAI_API_KEY") or "ollama"
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=90.0, max_retries=0)
    return client, model


def is_available() -> bool:
    """Available if the SDK is installed and we have an endpoint (a local base
    URL always counts, even without an API key)."""
    if OpenAI is None:
        return False
    return bool(os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL) or os.getenv("OPENAI_API_KEY"))


def _extract_json(raw: str) -> dict:
    """Parse JSON from a model response, tolerating code fences / extra text
    that smaller local models sometimes add."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        pass
    # Strip ```json ... ``` fences.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except Exception:
            pass
    # Fall back to the first balanced-looking {...} block.
    brace = re.search(r"\{.*\}", raw, re.DOTALL)
    if brace:
        try:
            return json.loads(brace.group(0))
        except Exception:
            pass
    return {}


def interpret(prompt: str, columns: list[str], sample_profile: dict | None = None) -> dict:
    """
    Ask the LLM to translate `prompt` into operations.
    Returns { "operations": [...], "explanation": str, "error": optional str }.
    """
    client, model = _get_client()
    if client is None:
        return {
            "operations": [],
            "explanation": "",
            "error": (
                "The OpenAI SDK is not installed. Run 'pip install -r requirements.txt'."
            ),
        }

    context = {
        "columns": columns,
        "profile": sample_profile or {},
    }
    user_msg = (
        f"{OPERATION_SPEC}\n\n"
        f"Dataset context:\n{json.dumps(context, default=str)[:4000]}\n\n"
        f"User instruction: {prompt}"
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]
    try:
        try:
            # Preferred: enforce JSON output (supported by Ollama + most providers).
            completion = client.chat.completions.create(
                model=model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=messages,
            )
        except Exception:
            # Some models/endpoints reject response_format — retry without it.
            completion = client.chat.completions.create(
                model=model,
                temperature=0,
                messages=messages,
            )
        raw = completion.choices[0].message.content
        parsed = _extract_json(raw)
        ops = parsed.get("operations", [])
        if not isinstance(ops, list):
            ops = []
        return {
            "operations": ops,
            "explanation": parsed.get("explanation", ""),
        }
    except Exception as exc:  # pragma: no cover
        hint = ""
        if "Connection" in str(exc) or "connect" in str(exc).lower():
            hint = (
                " — Is Ollama running? Start it and pull a model: "
                "'ollama pull llama3.1'. See README for setup."
            )
        return {
            "operations": [],
            "explanation": "",
            "error": f"AI request failed: {exc}{hint}",
        }


STORY_SYSTEM_PROMPT = """You are DataPilot AI's data storyteller.
Given a dataset profile and a list of detected insights (anomalies, outliers, trends),
write a short, plain-English narrative report (3-6 short paragraphs, no markdown headers)
explaining what the data means to a non-technical reader: what the dataset contains,
notable patterns, risks/anomalies, and one or two actionable recommendations.
Be concrete — reference actual column names and numbers given in the context. Do not
invent facts beyond what's provided."""


def _template_story(profile: dict, insights: list[dict]) -> str:
    """Deterministic fallback narrative used when no LLM endpoint is available."""
    cols = profile.get("columns", [])
    n_rows = profile.get("total_rows", 0)
    n_cols = profile.get("total_cols", 0)
    numeric = [c["name"] for c in cols if c.get("kind") == "numeric"]
    categorical = [c["name"] for c in cols if c.get("kind") == "categorical"]

    parts = [
        f"This dataset contains {n_rows} rows and {n_cols} columns. "
        f"It has {len(numeric)} numeric field(s) and {len(categorical)} categorical field(s)."
    ]
    if profile.get("total_missing"):
        parts.append(
            f"There are {profile['total_missing']} missing values and "
            f"{profile.get('duplicate_rows', 0)} duplicate rows across the dataset — "
            "worth cleaning before deeper analysis."
        )
    if insights:
        top = insights[:4]
        bullet = "; ".join(i["title"] for i in top)
        parts.append(f"Key findings from automated scanning: {bullet}.")
        crit = [i for i in insights if i.get("severity") == "critical"]
        if crit:
            parts.append(
                "Some findings are marked critical and should be prioritised: "
                + "; ".join(i["description"] for i in crit[:2])
            )
    parts.append(
        "Overall, review the flagged columns above, resolve missing/duplicate data, "
        "and use the recommended dashboard charts to explore relationships further."
    )
    return "\n\n".join(parts)


def generate_story(profile: dict, insights: list[dict]) -> dict:
    """Generate a plain-English narrative report from a dataset profile + insights.
    Falls back to a deterministic template if no LLM is configured/reachable."""
    client, model = _get_client()
    if client is None:
        return {"story": _template_story(profile, insights), "source": "template"}

    context = {
        "profile": {
            "total_rows": profile.get("total_rows"),
            "total_cols": profile.get("total_cols"),
            "total_missing": profile.get("total_missing"),
            "duplicate_rows": profile.get("duplicate_rows"),
            "columns": profile.get("columns", [])[:25],
        },
        "insights": insights,
    }
    messages = [
        {"role": "system", "content": STORY_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(context, default=str)[:6000]},
    ]
    try:
        completion = client.chat.completions.create(model=model, temperature=0.4, messages=messages)
        raw = (completion.choices[0].message.content or "").strip()
        if not raw:
            return {"story": _template_story(profile, insights), "source": "template"}
        return {"story": raw, "source": "ai"}
    except Exception:
        return {"story": _template_story(profile, insights), "source": "template"}
