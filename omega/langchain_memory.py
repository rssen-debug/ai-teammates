"""Optional LangChain text splitting for Buddy's existing memory retrieval.

Only in-process local text processing. No API calls, embeddings, model routing,
changes to permissions, or LangChain agent takeover. If the optional package
is absent, Buddy continues with a deterministic paragraph/character fallback.
"""
from __future__ import annotations

import re


def _terms(text: str) -> set[str]:
    return {word for word in re.findall(r"[\wåäö]+", str(text).casefold())
            if len(word) >= 3}


def _chunks(text: str, chunk_size: int = 450) -> list[str]:
    text = str(text or "").strip()
    if not text:
        return []
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size, chunk_overlap=60,
            separators=["\n\n", "\n", ". ", " ", ""])
        parts = splitter.split_text(text)
        if parts:
            return [str(p) for p in parts[:80]]
    except (ImportError, ValueError):
        pass
    # Preserve behavior when LangChain is not installed; do not block Buddy.
    paragraphs = re.split(r"\n\s*\n", text)
    output = []
    for para in paragraphs:
        while para:
            output.append(para[:chunk_size].strip())
            para = para[chunk_size - 60:] if len(para) > chunk_size else ""
            if len(output) >= 80:
                return output
    return [p for p in output if p]


def relevant_excerpt(content: str, goal: str, limit: int = 300) -> str:
    """Find the most relevant local excerpt of one already-ranked memory.

    The input is data, never system instructions. Keep source status/provenance
    in Buddy's existing prompt wrapper; this helper returns only a string.
    """
    chunks = _chunks(content)
    if not chunks:
        return ""
    terms = _terms(goal)
    scored = []
    for i, chunk in enumerate(chunks):
        found = _terms(chunk)
        score = sum(2 if term in found else 0 for term in terms)
        scored.append((score, -i, chunk))
    best = max(scored)[2]
    return best[:max(80, min(600, int(limit)))]


def format_memory_context(memories: list[dict], goal: str, max_items: int = 4) -> str:
    """Render *retrieved* memories; this never searches unrelated private data."""
    lines = []
    for record in memories[:max_items]:
        kind = str(record.get("kind", "unknown"))[:25]
        status = str(record.get("status", "unverified"))[:25]
        title = str(record.get("title", ""))[:120]
        excerpt = relevant_excerpt(record.get("content", ""), goal, 300)
        lines.append(f"- [{kind}/{status}] {title}: {excerpt}")
    return "\n".join(lines)
