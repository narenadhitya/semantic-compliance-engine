import psycopg2
import difflib
import json
import os
import re
import time
from itertools import combinations
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

from pydantic import BaseModel, Field
from typing import List
from mistralai.client import Mistral

from database import get_connection, setup_database

env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

# LLM judge -- Mistral API (JSON mode + Pydantic validation, since Mistral's
# JSON mode guarantees valid JSON but not an exact schema match).
mistral_client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))
LLM_JUDGE_MODEL = os.getenv("LLM_JUDGE_MODEL", "mistral-small-latest")

SUPABASE_URI = os.getenv("SUPABASE_URI")

TABLE_NAME = "corporate_policies"
EDGE_TABLE = "document_edges"
CONFLICT_TABLE = "detected_conflicts"
EDGE_THRESHOLD = 0.65
CONFLICT_DISTANCE_MIN = 0.01
CONFLICT_DISTANCE_MAX = 0.38

if not SUPABASE_URI:
    raise ValueError("Architecture Error: SUPABASE_URI is missing. Check your .env file.")


def get_db_connection():
    return psycopg2.connect(SUPABASE_URI)


def _canonical_pair(doc_a: str, doc_b: str):
    return tuple(sorted((doc_a, doc_b)))


def get_base_name(filename: str):
    """Strips extensions and versioning tags to group document histories robustly."""
    name, _ = os.path.splitext(filename)
    base = re.sub(r'([_\-\s]*(v\d+.*|\(\d+\)|final|draft|copy|new).*)$', '', name, flags=re.IGNORECASE).strip()
    return base if base else name


def register_and_get_predecessors(cur, new_doc_name: str):
    """
    Tags the newly-uploaded document with its base_name (for grouping) and
    returns ALL prior documents that share that base name -- no archival, no
    is_active toggling. Every version stays permanently visible.
    """
    base_name = get_base_name(new_doc_name)

    cur.execute(f"""
        UPDATE {TABLE_NAME} SET base_name = %s
        WHERE document_name = %s;
    """, (base_name, new_doc_name))

    cur.execute(f"""
        SELECT DISTINCT document_name FROM {TABLE_NAME}
        WHERE base_name = %s AND document_name != %s;
    """, (base_name, new_doc_name))

    return [row['document_name'] for row in cur.fetchall()]


def _fetch_chunks_for_document(cur, document_name: str):
    cur.execute(f"SELECT chunk_text, embedding FROM {TABLE_NAME} WHERE document_name = %s;", (document_name,))
    return cur.fetchall()


def fetch_full_text_for_document(cur, document_name: str) -> str:
    """
    Reconstructs the full raw text of a document by stitching chunks together
    without the overlap duplication.
    """
    cur.execute(
        f"SELECT chunk_text FROM {TABLE_NAME} WHERE document_name = %s ORDER BY id ASC;",
        (document_name,)
    )
    rows = cur.fetchall()
    if not rows:
        return ""

    OVERLAP = 60

    result = rows[0]['chunk_text']
    for row in rows[1:]:
        chunk = row['chunk_text']
        tail = result[-OVERLAP:] if len(result) >= OVERLAP else result
        overlap_len = 0
        for length in range(min(len(tail), len(chunk)), 0, -1):
            if tail.endswith(chunk[:length]):
                overlap_len = length
                break
        result += chunk[overlap_len:]

    return result


_MIN_DIFF_CHARS = 20


def _extract_changed_words(text_old: str, text_new: str) -> dict:
    """
    Runs a word-level diff between two text blocks and returns the sets of
    words that were removed and added.  Used to annotate 'modified' hunks so
    the LLM judge can immediately spot which specific words changed rather than
    having to compare two large blocks of near-identical text.
    """
    words_old = text_old.split()
    words_new = text_new.split()
    matcher = difflib.SequenceMatcher(None, words_old, words_new, autojunk=False)
    removed_words, added_words = [], []
    for op, a0, a1, b0, b1 in matcher.get_opcodes():
        if op != "equal":
            removed_words.extend(words_old[a0:a1])
            added_words.extend(words_new[b0:b1])
    return {
        "removed_words": removed_words,
        "added_words":   added_words,
    }


def run_structural_diff(text_a: str, text_b: str) -> list:
    """
    Compares two full-text strings line-by-line using difflib.SequenceMatcher.
    Catches exact insertions, deletions, and modifications.

    Each delta dict contains:
        removed      – text from the OLD document (text_a)
        added        – text from the NEW document (text_b)
        change_type  – "modified" | "deleted" | "inserted"
        changed_words – {removed_words, added_words} for "modified" hunks;
                        lets the LLM judge immediately identify the exact
                        changed words inside a large near-identical block.

    IMAGE ALIAS tokens always bypass the length filter so image deletions/
    insertions are never silently dropped.
    """
    lines_a = text_a.splitlines()
    lines_b = text_b.splitlines()

    matcher = difflib.SequenceMatcher(None, lines_a, lines_b, autojunk=False)
    deltas = []
    image_alias_marker = "[IMAGE ALIAS"

    for opcode, a0, a1, b0, b1 in matcher.get_opcodes():
        if opcode == "equal":
            continue

        removed_text = "\n".join(lines_a[a0:a1]).strip()
        added_text   = "\n".join(lines_b[b0:b1]).strip()

        # IMAGE ALIAS hunks are always kept regardless of length
        contains_image = (image_alias_marker in removed_text) or (image_alias_marker in added_text)

        if not contains_image and len(removed_text) < _MIN_DIFF_CHARS and len(added_text) < _MIN_DIFF_CHARS:
            continue

        if opcode == "replace":
            change_type = "modified"
        elif opcode == "delete":
            change_type = "deleted"
        elif opcode == "insert":
            change_type = "inserted"
        else:
            continue

        delta = {
            "removed":      removed_text,
            "added":        added_text,
            "change_type":  change_type,
            "changed_words": {},
        }

        # For modified hunks, annotate with word-level changes so the LLM
        # can pinpoint exactly what was altered without wading through a large
        # block of near-identical text.
        if change_type == "modified":
            delta["changed_words"] = _extract_changed_words(removed_text, added_text)

        deltas.append(delta)

    # Precision isolation pass: extract IMAGE ALIAS tokens absorbed inside
    # 'modified' hunks (e.g. text AND image changed in the same paragraph).
    extra_deltas = []
    for delta in deltas:
        if delta["change_type"] != "modified":
            continue
        aliases_removed = [
            line.strip() for line in delta["removed"].splitlines()
            if image_alias_marker in line
        ]
        aliases_added = [
            line.strip() for line in delta["added"].splitlines()
            if image_alias_marker in line
        ]
        # Image deleted in new version
        for alias_line in aliases_removed:
            if alias_line not in aliases_added:
                extra_deltas.append({
                    "removed":      alias_line,
                    "added":        "",
                    "change_type":  "deleted",
                    "changed_words": {},
                })
        # Image inserted in new version
        for alias_line in aliases_added:
            if alias_line not in aliases_removed:
                extra_deltas.append({
                    "removed":      "",
                    "added":        alias_line,
                    "change_type":  "inserted",
                    "changed_words": {},
                })

    deltas.extend(extra_deltas)
    return deltas


def _analyze_document_pair(cur, doc_a: str, doc_b: str):
    chunks_a = _fetch_chunks_for_document(cur, doc_a)
    chunks_b = _fetch_chunks_for_document(cur, doc_b)

    if not chunks_a or not chunks_b:
        return 0, []

    max_doc_similarity = 0
    doc_conflicts = []

    for chunk in chunks_a:
        vector_string = chunk['embedding'] if isinstance(chunk['embedding'], str) else '[' + ','.join(map(str, chunk['embedding'])) + ']'

        cur.execute(f"""
            SELECT chunk_text, (embedding <=> %s::vector) AS distance
            FROM {TABLE_NAME}
            WHERE document_name = %s
            ORDER BY embedding <=> %s::vector
            LIMIT 5;
        """, (vector_string, doc_b, vector_string))

        matches = cur.fetchall()
        for match in matches:
            distance = match['distance']
            similarity = 1 - distance
            if similarity > max_doc_similarity:
                max_doc_similarity = similarity

            if CONFLICT_DISTANCE_MIN <= distance <= CONFLICT_DISTANCE_MAX:
                doc_conflicts.append({
                    "source_text": chunk['chunk_text'],
                    "target_text": match['chunk_text'],
                    "drift_score": distance
                })

    return max_doc_similarity, doc_conflicts


def _insert_edge_and_conflicts(cur, source_doc, target_doc, max_sim, conflicts):
    cur.execute(f"""
        INSERT INTO {EDGE_TABLE} (source_doc, target_doc, max_similarity)
        VALUES (%s, %s, %s)
        ON CONFLICT (source_doc, target_doc)
        DO UPDATE SET max_similarity = EXCLUDED.max_similarity
        RETURNING id;
    """, (source_doc, target_doc, max_sim))
    edge_row = cur.fetchone()
    edge_id = edge_row['id'] if edge_row else None

    for c in conflicts:
        detection_method = c.get("detection_method", "vector")
        cur.execute(f"""
            INSERT INTO {CONFLICT_TABLE}
                (edge_id, source_doc, target_doc, source_text, target_text, drift_score, detection_method)
            VALUES (%s, %s, %s, %s, %s, %s, %s);
        """, (
            edge_id,
            source_doc,
            target_doc,
            c['source_text'],
            c['target_text'],
            c['drift_score'],
            detection_method,
        ))

    return edge_id


def compare_versions(doc_a: str, doc_b: str):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    edge_id = None
    try:
        source_doc, target_doc = _canonical_pair(doc_a, doc_b)

        max_sim, vector_conflicts = _analyze_document_pair(cur, source_doc, target_doc)

        text_old = fetch_full_text_for_document(cur, doc_b)
        text_new = fetch_full_text_for_document(cur, doc_a)
        structural_deltas = run_structural_diff(text_old, text_new)

        print(f"[DELTA CHECK] Vector candidates: {len(vector_conflicts)} | Structural deltas: {len(structural_deltas)}")

        structural_conflicts = []
        for delta in structural_deltas:
            structural_conflicts.append({
                "source_text": delta["removed"] or f"[{delta['change_type'].upper()}] (no prior content)",
                "target_text": delta["added"] or f"[{delta['change_type'].upper()}] Content removed in new version",
                "drift_score": 0.0,
                "detection_method": "structural",
                "change_type": delta["change_type"],
            })

        for c in vector_conflicts:
            c["detection_method"] = "vector"
            c.setdefault("change_type", "modified")

        all_conflicts = vector_conflicts + structural_conflicts

        if max_sim >= EDGE_THRESHOLD or len(all_conflicts) > 0:
            edge_id = _insert_edge_and_conflicts(cur, source_doc, target_doc, max_sim, all_conflicts)

        conn.commit()
    finally:
        cur.close()
        conn.close()
    return edge_id


def compute_graph_edges(new_document_name: str):
    print(f"\n[GRAPH ENGINE] Executing Deep Search for '{new_document_name}'...")
    edge_ids_found = []
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        cur.execute(f"SELECT DISTINCT document_name FROM {TABLE_NAME} WHERE document_name != %s;", (new_document_name,))
        other_docs = [row['document_name'] for row in cur.fetchall()]

        print(f"[GRAPH ENGINE] Deep search will evaluate {len(other_docs)} other active documents.")

        for target_doc in other_docs:
            print(f" -> Comparing '{new_document_name}' against '{target_doc}'")
            source_doc, target = _canonical_pair(new_document_name, target_doc)
            max_sim, doc_conflicts = _analyze_document_pair(cur, source_doc, target)

            if max_sim >= EDGE_THRESHOLD or len(doc_conflicts) > 0:
                print(f"    [+] Edge Found! Similarity: {max_sim:.2f} | Candidate conflicts: {len(doc_conflicts)}")
                edge_id = _insert_edge_and_conflicts(cur, source_doc, target, max_sim, doc_conflicts)
                if edge_id and doc_conflicts:
                    edge_ids_found.append(edge_id)

        conn.commit()
        cur.close()
        conn.close()
        print(f"[GRAPH ENGINE] Deep Search complete. {len(edge_ids_found)} edge(s) queued for LLM enrichment.")

        for edge_id in edge_ids_found:
            enrich_conflicts(edge_id)

        print("[GRAPH ENGINE] Enrichment pass complete.")
    except Exception as e:
        print(f"\n[GRAPH ENGINE CRITICAL ERROR] Deep search failed: {e}")


def get_pending_edge_ids():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(f"""
        SELECT DISTINCT edge_id FROM {CONFLICT_TABLE}
        WHERE reasoning IS NULL AND edge_id IS NOT NULL;
    """)
    edge_ids = [row['edge_id'] for row in cur.fetchall()]
    cur.close()
    conn.close()
    return edge_ids


def retry_pending_enrichment():
    """
    Re-runs BOTH judges for every edge that still has un-judged candidates --
    enrich_conflicts (vector-detected rows) and enrich_structural_deltas
    (structural rows). Each function only ever touches its own
    detection_method, so calling both is always safe/idempotent.
    """
    edge_ids = get_pending_edge_ids()
    print(f"[LLM JUDGE] Retrying enrichment for {len(edge_ids)} edge(s) with pending conflicts.")
    for edge_id in edge_ids:
        enrich_conflicts(edge_id)
        enrich_structural_deltas(edge_id)
    return edge_ids


def enrich_conflicts(edge_id: int):
    """
    Runs the Mistral LLM Judge over every un-enriched VECTOR-detected
    candidate for a given edge. Scoped to detection_method='vector' so it
    never claims/deletes structural rows before enrich_structural_deltas gets
    a chance to see them -- this scoping is the fix for the bug where image
    deletions were being swept up and discarded by the generic contradiction
    judge before the deletion-aware judge could run.
    """
    if not edge_id:
        return

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute(f"""
            SELECT id, source_text, target_text FROM {CONFLICT_TABLE}
            WHERE edge_id = %s AND reasoning IS NULL AND detection_method = 'vector';
        """, (edge_id,))
        pending = cur.fetchall()
        print(f"[LLM JUDGE] Enriching {len(pending)} pending vector candidate(s) for edge {edge_id} in batches of {BATCH_SIZE}...")

        for batch_start in range(0, len(pending), BATCH_SIZE):
            batch = pending[batch_start:batch_start + BATCH_SIZE]
            pairs = [{"source_text": row['source_text'], "target_text": row['target_text']} for row in batch]

            result = check_logical_contradictions_batch(pairs)

            if result.get("judge_error", False):
                print(f"[LLM JUDGE] Batch failed for rows {[r['id'] for r in batch]} -- left pending for retry.")
                time.sleep(MISTRAL_CALL_DELAY_SECONDS)
                continue

            verdict_map = {v.get("pair_index"): v for v in result.get("verdicts", [])}

            for i, row in enumerate(batch):
                verdict = verdict_map.get(i)
                if verdict is None:
                    print(f"[LLM JUDGE] No verdict returned for row {row['id']} (pair_index {i}) -- left pending.")
                    continue

                if verdict.get("is_contradiction", False):
                    cur.execute(f"""
                        UPDATE {CONFLICT_TABLE}
                        SET reasoning = %s,
                            isolated_summary_a = %s,
                            isolated_summary_b = %s,
                            highlight_terms_a = %s,
                            highlight_terms_b = %s
                        WHERE id = %s;
                    """, (
                        verdict.get("reasoning", ""),
                        verdict.get("isolated_summary_a", ""),
                        verdict.get("isolated_summary_b", ""),
                        json.dumps(verdict.get("highlight_terms_a", [])),
                        json.dumps(verdict.get("highlight_terms_b", [])),
                        row['id']
                    ))
                else:
                    cur.execute(f"DELETE FROM {CONFLICT_TABLE} WHERE id = %s;", (row['id'],))

            conn.commit()
            time.sleep(MISTRAL_CALL_DELAY_SECONDS)

        print(f"[LLM JUDGE] Enrichment complete for edge {edge_id}.")
    except Exception as e:
        print(f"[LLM JUDGE CRITICAL ERROR] Enrichment failed for edge {edge_id}: {e}")
    finally:
        cur.close()
        conn.close()


def enrich_structural_deltas(edge_id: int):
    if not edge_id:
        return

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute(f"""
            SELECT id, source_text, target_text, detection_method
            FROM {CONFLICT_TABLE}
            WHERE edge_id = %s
              AND reasoning IS NULL
              AND detection_method = 'structural';
        """, (edge_id,))
        pending = cur.fetchall()

        if not pending:
            print(f"[STRUCTURAL JUDGE] No pending structural deltas for edge {edge_id}.")
            return

        print(f"[STRUCTURAL JUDGE] Enriching {len(pending)} structural delta(s) for edge {edge_id} in batches of {BATCH_SIZE}...")

        for batch_start in range(0, len(pending), BATCH_SIZE):
            batch = pending[batch_start:batch_start + BATCH_SIZE]

            pairs = []
            for row in batch:
                src = row['source_text']
                tgt = row['target_text']
                if "[DELETED]" in tgt or "[DELETED] Content removed" in tgt:
                    change_type = "deleted"
                elif "[INSERTED]" in src or "(no prior content)" in src:
                    change_type = "inserted"
                else:
                    change_type = "modified"

                # Re-run word-level diff on the stored texts so the LLM prompt
                # can call out the exact changed words for 'modified' hunks.
                changed_words = {}
                if change_type == "modified":
                    changed_words = _extract_changed_words(src, tgt)

                pairs.append({
                    "source_text":   src,
                    "target_text":   tgt,
                    "change_type":   change_type,
                    "changed_words": changed_words,
                })

            result = _check_structural_changes_batch(pairs)

            if result.get("judge_error", False):
                print(f"[STRUCTURAL JUDGE] Batch failed for rows {[r['id'] for r in batch]} -- left pending for retry.")
                time.sleep(MISTRAL_CALL_DELAY_SECONDS)
                continue

            verdict_map = {v.get("pair_index"): v for v in result.get("verdicts", [])}

            for i, row in enumerate(batch):
                verdict = verdict_map.get(i)
                if verdict is None:
                    print(f"[STRUCTURAL JUDGE] No verdict for row {row['id']} (pair_index {i}) -- left pending.")
                    continue

                if verdict.get("is_compliance_risk", False):
                    cur.execute(f"""
                        UPDATE {CONFLICT_TABLE}
                        SET reasoning = %s,
                            isolated_summary_a = %s,
                            isolated_summary_b = %s,
                            highlight_terms_a = %s,
                            highlight_terms_b = %s
                        WHERE id = %s;
                    """, (
                        verdict.get("reasoning", ""),
                        verdict.get("isolated_summary_a", ""),
                        verdict.get("isolated_summary_b", ""),
                        json.dumps(verdict.get("highlight_terms_a", [])),
                        json.dumps(verdict.get("highlight_terms_b", [])),
                        row['id']
                    ))
                else:
                    cur.execute(f"DELETE FROM {CONFLICT_TABLE} WHERE id = %s;", (row['id'],))

            conn.commit()
            time.sleep(MISTRAL_CALL_DELAY_SECONDS)

        print(f"[STRUCTURAL JUDGE] Enrichment complete for edge {edge_id}.")
    except Exception as e:
        print(f"[STRUCTURAL JUDGE CRITICAL ERROR] Enrichment failed for edge {edge_id}: {e}")
    finally:
        cur.close()
        conn.close()


class BatchAuditItem(BaseModel):
    pair_index: int = Field(description="The index (starting at 0) of the segment pair this verdict corresponds to, matching the 'Pair N' label given in the prompt.")
    is_contradiction: bool = Field(description="True if the text segments structurally contradict, clash in metrics, or impose opposing mandates. False if they align or discuss different topics.")
    reasoning: str = Field(description="Detailed compliance explanation of what the conflict is, why it occurs, and the institutional risk involved.")
    highlight_terms_a: List[str] = Field(description="Specific precise words or phrases (like metrics, numbers, keywords) inside Segment A causing the conflict that the frontend should highlight.")
    highlight_terms_b: List[str] = Field(description="Specific precise words or phrases (like metrics, numbers, keywords) inside Segment B causing the conflict that the frontend should highlight.")
    isolated_summary_a: str = Field(description="The extracted 2-3 critical lines from Segment A that explicitly frame the conflict, bypassing unnecessary fluff text.")
    isolated_summary_b: str = Field(description="The extracted 2-3 critical lines from Segment B that explicitly frame the conflict, bypassing unnecessary fluff text.")


class BatchAuditReportSchema(BaseModel):
    verdicts: List[BatchAuditItem] = Field(description="Exactly one verdict per input pair, covering every pair given, in any order (matched back by pair_index).")


BATCH_SIZE = 6
MISTRAL_CALL_DELAY_SECONDS = 1.5


def check_logical_contradictions_batch(pairs: List[dict], max_retries: int = 3) -> dict:
    segments_block = "\n\n".join(
        f'--- Pair {i} ---\nSegment A: "{p["source_text"]}"\nSegment B: "{p["target_text"]}"'
        for i, p in enumerate(pairs)
    )

    prompt = f"""
    You are an unyielding corporate compliance auditor inspecting policy documentation updates.
    Below are {len(pairs)} independent pairs of policy segments. Evaluate EACH pair separately --
    a contradiction in one pair must not influence your verdict on any other pair.

    {segments_block}

    For EACH pair above (identified by its "Pair N" label):
    1. Determine if Segment A and Segment B logically contradict or breach each other (e.g., clashing retention periods, opposing operational metrics, or conflicting permissions).
    2. Extract the exact short key phrases/metrics from each segment that anchor the mismatch.
    3. Isolate the 2-3 core sentences from each segment that show the actual conflict area.
    4. Provide a professional compliance summary of the contradiction.

    Respond with ONLY a single JSON object (no other text, no markdown fences) with exactly this shape:
    {{
      "verdicts": [
        {{
          "pair_index": <integer, matching the Pair N above>,
          "is_contradiction": <true or false>,
          "reasoning": "<detailed compliance explanation>",
          "highlight_terms_a": ["<term>", "..."],
          "highlight_terms_b": ["<term>", "..."],
          "isolated_summary_a": "<2-3 critical lines from Segment A>",
          "isolated_summary_b": "<2-3 critical lines from Segment B>"
        }}
      ]
    }}
    Include exactly one verdict object per pair given above.
    """

    for attempt in range(max_retries):
        try:
            response = mistral_client.chat.complete(
                model=LLM_JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0.1
            )

            content = response.choices[0].message.content
            parsed = BatchAuditReportSchema.model_validate_json(content)
            return {"judge_error": False, "verdicts": [v.model_dump() for v in parsed.verdicts]}

        except Exception as e:
            error_str = str(e)
            is_rate_limit = "429" in error_str or "rate" in error_str.lower()

            if is_rate_limit and attempt < max_retries - 1:
                wait = 5 * (attempt + 1)
                print(f"[-] Rate limited on batch (attempt {attempt + 1}/{max_retries}), retrying in {wait}s...")
                time.sleep(wait)
                continue
            elif attempt < max_retries - 1:
                print(f"[-] Batch response invalid (attempt {attempt + 1}/{max_retries}): {error_str}")
                time.sleep(2)
                continue

            print(f"[-] Batch evaluation failure: {e}")
            return {"judge_error": True, "judge_error_message": error_str, "verdicts": []}


class StructuralDeltaItem(BaseModel):
    pair_index: int = Field(description="The index (starting at 0) of the change pair this verdict corresponds to.")
    is_compliance_risk: bool = Field(description="True if this structural change represents a meaningful compliance risk or policy regression. False if it is benign (e.g. formatting, typo fix).")
    reasoning: str = Field(description="Detailed compliance explanation: what was changed, why it matters, and the institutional risk if the change is unreviewed.")
    highlight_terms_a: List[str] = Field(description="Key phrases or values from the OLD content (Segment A) that anchor the compliance concern.")
    highlight_terms_b: List[str] = Field(description="Key phrases or values from the NEW content (Segment B) that anchor the compliance concern. Empty for pure deletions.")
    isolated_summary_a: str = Field(description="The 1-3 critical lines from the OLD content that best represent the compliance-relevant portion.")
    isolated_summary_b: str = Field(description="The 1-3 critical lines from the NEW content showing what replaced it. Use '[Content deleted]' for pure deletions.")


class StructuralDeltaReportSchema(BaseModel):
    verdicts: List[StructuralDeltaItem] = Field(description="Exactly one verdict per input change, in any order, matched back by pair_index.")


def _check_structural_changes_batch(pairs: List[dict], max_retries: int = 3) -> dict:
    change_blocks = []
    for i, p in enumerate(pairs):
        ctype = p.get("change_type", "modified").upper()
        old_text = p["source_text"] or "(none)"
        new_text = p["target_text"] or "(none)"
        changed_words = p.get("changed_words", {})

        block = (
            f'--- Change {i} [{ctype}] ---\n'
            f'OLD (predecessor): "{old_text}"\n'
            f'NEW (updated doc): "{new_text}"'
        )

        # For modified hunks, append a pinpoint word-diff summary so the LLM
        # immediately knows which words changed without having to compare two
        # large near-identical blocks itself.  This is what surfaces changes
        # like "West"→"East" or "22.5"→"26.5" that would otherwise be dismissed.
        if ctype == "MODIFIED" and changed_words.get("removed_words") or changed_words.get("added_words"):
            removed_w = ' '.join(changed_words.get("removed_words", []))
            added_w   = ' '.join(changed_words.get("added_words", []))
            block += f'\nPRECISE CHANGES: [{removed_w}] → [{added_w}]'

        change_blocks.append(block)

    segments_block = "\n\n".join(change_blocks)

    prompt = f"""
You are a strict corporate compliance auditor reviewing an audit trail of direct structural changes
made between two versions of the same policy document.

The changes below were detected by a line-by-line diff — they represent ACTUAL EDITS, not semantic
similarity. Each entry is labelled with its change type:
  [MODIFIED] — text was reworded or altered
  [DELETED]  — content was removed entirely from the new version (including figures, images, or sections)
  [INSERTED] — new content was added that did not exist before

IMPORTANT — IMAGE ALIAS tokens:
Tokens like [IMAGE ALIAS: Embedded PDF Visual Asset/Scan] or [IMAGE ALIAS: Embedde Word Diagram/Graphic Layout]
represent REAL embedded visual content (charts, diagrams, figures) that existed in the document.
If such a token appears in OLD content but NOT in NEW content, a real visual asset was DELETED.
This is always a compliance concern: visual content may include required disclosures, process diagrams,
certifications, or regulatory figures. ALWAYS mark image deletions as is_compliance_risk=true.

{segments_block}

For EACH change above (identified by its "Change N" label):
1. Determine if this structural change introduces a compliance risk:
   - For [MODIFIED]: did the meaning, metrics, obligations, or thresholds change?
   - For [DELETED]: does removing this content create a gap, remove a safeguard, or drop a required disclosure?
     If the deleted content contains [IMAGE ALIAS], it is ALWAYS a compliance risk.
   - For [INSERTED]: does the new content conflict with existing policy or introduce an unreviewed obligation?
2. ONLY mark is_compliance_risk=false for genuinely trivial changes: whitespace-only edits, punctuation
   fixes, or formatting corrections where the MEANING is completely unchanged. Deletions should default
   to is_compliance_risk=true unless you are certain the content is purely cosmetic.
3. Extract the critical phrases that anchor the concern from each side.
4. Write a professional compliance assessment.

Respond with ONLY a single JSON object (no other text, no markdown fences) with exactly this shape:
{{
  "verdicts": [
    {{
      "pair_index": <integer matching Change N above>,
      "is_compliance_risk": <true or false>,
      "reasoning": "<detailed compliance assessment>",
      "highlight_terms_a": ["<term>", "..."],
      "highlight_terms_b": ["<term>", "..."],
      "isolated_summary_a": "<1-3 key lines from OLD content>",
      "isolated_summary_b": "<1-3 key lines from NEW content, or '[Content deleted]'>"
    }}
  ]
}}
Include exactly one verdict object per change given above.
"""

    for attempt in range(max_retries):
        try:
            response = mistral_client.chat.complete(
                model=LLM_JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0.1
            )
            content = response.choices[0].message.content
            parsed = StructuralDeltaReportSchema.model_validate_json(content)
            return {"judge_error": False, "verdicts": [v.model_dump() for v in parsed.verdicts]}
        except Exception as e:
            error_str = str(e)
            is_rate_limit = "429" in error_str or "rate" in error_str.lower()
            if is_rate_limit and attempt < max_retries - 1:
                wait = 5 * (attempt + 1)
                print(f"[-] Structural judge rate limited (attempt {attempt + 1}/{max_retries}), retrying in {wait}s...")
                time.sleep(wait)
                continue
            elif attempt < max_retries - 1:
                print(f"[-] Structural judge response invalid (attempt {attempt + 1}/{max_retries}): {error_str}")
                time.sleep(2)
                continue
            print(f"[-] Structural judge batch failure: {e}")
            return {"judge_error": True, "judge_error_message": error_str, "verdicts": []}


def rebuild_graph_edges():
    pass


def fetch_all_document_names():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT DISTINCT document_name, base_name
        FROM {TABLE_NAME}
        ORDER BY base_name ASC, document_name DESC;
    """)

    documents = cur.fetchall()
    cur.close()
    conn.close()
    return documents


def fetch_graph_data():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"SELECT DISTINCT document_name as id FROM {TABLE_NAME};")
    nodes = cur.fetchall()
    all_docs = [n['id'] for n in nodes]

    if not all_docs:
        cur.close()
        conn.close()
        return {"nodes": [], "links": []}

    format_strings = ','.join(['%s'] * len(all_docs))
    cur.execute(f"""
        SELECT e.source_doc as source, e.target_doc as target, e.max_similarity,
               COUNT(c.id) FILTER (WHERE c.reasoning IS NOT NULL) AS confirmed_conflict_count,
               COUNT(c.id) FILTER (WHERE c.reasoning IS NOT NULL AND COALESCE(c.status, 'active') = 'active') AS active_count,
               COUNT(c.id) FILTER (WHERE c.reasoning IS NOT NULL AND COALESCE(c.status, 'active') = 'flagged') AS flagged_count
        FROM {EDGE_TABLE} e
        LEFT JOIN {CONFLICT_TABLE} c ON c.edge_id = e.id
        WHERE e.source_doc IN ({format_strings}) AND e.target_doc IN ({format_strings})
        GROUP BY e.id, e.source_doc, e.target_doc, e.max_similarity;
    """, tuple(all_docs) * 2)
    links = cur.fetchall()

    cur.close()
    conn.close()

    for link in links:
        link['has_conflict'] = link['confirmed_conflict_count'] > 0
        if link['active_count'] > 0:
            link['edge_status'] = 'active'
        elif link['flagged_count'] > 0:
            link['edge_status'] = 'flagged'
        else:
            link['edge_status'] = 'healthy'

    return {"nodes": nodes, "links": links}


def fetch_conflicts(doc1: str, doc2: str):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT id, edge_id, source_text, target_text,
               reasoning, isolated_summary_a, isolated_summary_b,
               highlight_terms_a, highlight_terms_b, drift_score, created_at,
               COALESCE(status, 'active') AS status
        FROM {CONFLICT_TABLE}
        WHERE ((source_doc = %s AND target_doc = %s) OR (source_doc = %s AND target_doc = %s))
          AND reasoning IS NOT NULL
        ORDER BY
            CASE COALESCE(status, 'active')
                WHEN 'active'    THEN 1
                WHEN 'flagged'   THEN 2
                WHEN 'dismissed' THEN 3
                ELSE 4
            END ASC,
            drift_score ASC;
    """, (doc1, doc2, doc2, doc1))

    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts


def fetch_all_conflicts():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT id, edge_id, source_doc, target_doc,
               source_text, target_text,
               reasoning, isolated_summary_a, isolated_summary_b,
               highlight_terms_a, highlight_terms_b, drift_score, created_at, status
        FROM {CONFLICT_TABLE}
        WHERE reasoning IS NOT NULL
        ORDER BY created_at DESC;
    """)

    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts


def fetch_triage_pairs():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT
            source_doc,
            target_doc,
            COUNT(*) FILTER (WHERE COALESCE(status, 'active') IN ('active', 'flagged')) AS conflict_count,
            MIN(drift_score) AS min_drift,
            MAX(created_at) AS latest_at
        FROM {CONFLICT_TABLE}
        WHERE reasoning IS NOT NULL
        GROUP BY source_doc, target_doc
        HAVING COUNT(*) FILTER (WHERE COALESCE(status, 'active') IN ('active', 'flagged')) > 0
        ORDER BY latest_at DESC;
    """)

    pairs = cur.fetchall()
    cur.close()
    conn.close()
    return pairs


def fetch_conflicts_by_edge(edge_id: int):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT id, edge_id, source_doc, target_doc,
               source_text, target_text,
               reasoning, isolated_summary_a, isolated_summary_b,
               highlight_terms_a, highlight_terms_b, drift_score, created_at,
               COALESCE(status, 'active') AS status
        FROM {CONFLICT_TABLE}
        WHERE edge_id = %s
          AND reasoning IS NOT NULL
        ORDER BY
            CASE COALESCE(status, 'active')
                WHEN 'active'    THEN 1
                WHEN 'flagged'   THEN 2
                WHEN 'dismissed' THEN 3
                ELSE 4
            END ASC,
            drift_score ASC;
    """, (edge_id,))

    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts


def dismiss_conflict(conflict_id: int):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(f"""
            UPDATE {CONFLICT_TABLE}
            SET status = 'dismissed', reviewed_at = NOW()
            WHERE id = %s;
        """, (conflict_id,))
        conn.commit()
    finally:
        cur.close()
        conn.close()


def flag_conflict(conflict_id: int):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(f"""
            UPDATE {CONFLICT_TABLE}
            SET status = 'flagged', reviewed_at = NOW()
            WHERE id = %s;
        """, (conflict_id,))
        conn.commit()
    finally:
        cur.close()
        conn.close()


def resolve_conflict(conflict_id: int):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(f"""
            UPDATE {CONFLICT_TABLE}
            SET status = 'resolved', reviewed_at = NOW()
            WHERE id = %s;
        """, (conflict_id,))
        conn.commit()
    finally:
        cur.close()
        conn.close()


def delete_document(document_name: str):
    print(f"\n[GRAPH ENGINE] Initiating deletion protocol for '{document_name}'...")
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute(f"""
            DELETE FROM {EDGE_TABLE}
            WHERE source_doc = %s OR target_doc = %s;
        """, (document_name, document_name))

        cur.execute(f"""
            DELETE FROM {CONFLICT_TABLE}
            WHERE source_doc = %s OR target_doc = %s;
        """, (document_name, document_name))

        cur.execute(f"""
            DELETE FROM {TABLE_NAME}
            WHERE document_name = %s;
        """, (document_name,))

        conn.commit()
        print(f"[GRAPH ENGINE] Deletion complete. {document_name} eradicated.")
    finally:
        cur.close()
        conn.close()