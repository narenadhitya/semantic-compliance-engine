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

    # Stamp the new doc with its base_name so it can be grouped later.
    cur.execute(f"""
        UPDATE {TABLE_NAME} SET base_name = %s
        WHERE document_name = %s;
    """, (base_name, new_doc_name))

    # Return every prior doc that shares the same lineage.
    cur.execute(f"""
        SELECT DISTINCT document_name FROM {TABLE_NAME}
        WHERE base_name = %s AND document_name != %s;
    """, (base_name, new_doc_name))

    return [row['document_name'] for row in cur.fetchall()]


def _fetch_chunks_for_document(cur, document_name: str):
    cur.execute(f"SELECT chunk_text, embedding FROM {TABLE_NAME} WHERE document_name = %s;", (document_name,))
    return cur.fetchall()


# ---------------------------------------------------------------------------
# PHASE A: PURE VECTOR-DISTANCE DETECTION (fast, no LLM calls)
# ---------------------------------------------------------------------------
def _analyze_document_pair(cur, doc_a: str, doc_b: str):
    """
    Pure vector-distance candidate detection. For every chunk in doc_a, pulls
    the top-5 nearest chunks in doc_b and flags any pair whose distance falls
    inside the conflict band as a RAW CANDIDATE conflict (no LLM judgment yet).
    This function intentionally stays cheap so it can run inline/synchronously
    during upload without blocking the request.
    """
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
    """
    Upserts the edge row and inserts each raw candidate conflict, storing the
    original chunk text (source_text/target_text) so the LLM judge can be run
    on it later (or re-run, since it's persisted). reasoning/summary/highlight
    fields are left NULL until enrich_conflicts() runs.
    """
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
        cur.execute(f"""
            INSERT INTO {CONFLICT_TABLE} (edge_id, source_doc, target_doc, source_text, target_text, drift_score)
            VALUES (%s, %s, %s, %s, %s, %s);
        """, (edge_id, source_doc, target_doc, c['source_text'], c['target_text'], c['drift_score']))

    return edge_id


def compare_versions(doc_a: str, doc_b: str):
    """
    Phase 1: Local Delta Check (vector-only, fast). Compares the new version
    against its predecessor and stores raw candidate conflicts. Returns the
    edge_id so the caller (e.g. the upload endpoint) can schedule LLM
    enrichment as a background task without blocking the HTTP response.
    """
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    edge_id = None
    try:
        source_doc, target_doc = _canonical_pair(doc_a, doc_b)
        max_sim, conflicts = _analyze_document_pair(cur, source_doc, target_doc)

        if max_sim >= EDGE_THRESHOLD or len(conflicts) > 0:
            edge_id = _insert_edge_and_conflicts(cur, source_doc, target_doc, max_sim, conflicts)

        conn.commit()
    finally:
        cur.close()
        conn.close()
    return edge_id


def compute_graph_edges(new_document_name: str):
    """
    Phase 2: Deep Search. Vector-only detection against ALL other active
    documents, then an LLM enrichment pass over every edge found. This whole
    function is already invoked via FastAPI BackgroundTasks, so it's safe to
    run the (slower) enrichment step inline here.
    """
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


# ---------------------------------------------------------------------------
# PHASE B: LLM JUDGE ENRICHMENT (runs after detection, ideally backgrounded)
# ---------------------------------------------------------------------------
def get_pending_edge_ids():
    """
    Returns edge_ids that have at least one conflict row still stuck pending
    (reasoning IS NULL) -- i.e. detected by the vector pass but never
    successfully judged, usually because a prior enrichment run hit an API
    error (quota, network, etc.). Used to retry enrichment later.
    """
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
    """Re-runs enrich_conflicts for every edge that still has un-judged candidates."""
    edge_ids = get_pending_edge_ids()
    print(f"[LLM JUDGE] Retrying enrichment for {len(edge_ids)} edge(s) with pending conflicts.")
    for edge_id in edge_ids:
        enrich_conflicts(edge_id)
    return edge_ids


def enrich_conflicts(edge_id: int):
    """
    Runs the Mistral LLM Judge over every un-enriched raw candidate for a
    given edge, BATCHED (BATCH_SIZE pairs per call) to conserve requests.
    Genuine contradictions get upgraded in place with reasoning/summary/
    highlight terms. False positives (vector-similar but not actually
    contradictory) are deleted, so the triage view only ever surfaces
    judge-confirmed conflicts. If a batch call fails outright (e.g. rate
    limit or invalid response exhausted after retries), every row in that
    batch is left pending for a later retry via retry_pending_enrichment(),
    rather than being discarded. Designed to be called from a BackgroundTask
    so it never blocks the upload/deep-search response.
    """
    if not edge_id:
        return

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute(f"""
            SELECT id, source_text, target_text FROM {CONFLICT_TABLE}
            WHERE edge_id = %s AND reasoning IS NULL;
        """, (edge_id,))
        pending = cur.fetchall()
        print(f"[LLM JUDGE] Enriching {len(pending)} pending candidate(s) for edge {edge_id} in batches of {BATCH_SIZE}...")

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
                    # Model dropped this pair from its response -- leave pending, don't guess.
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
                    # Judge genuinely reviewed it and confirmed no contradiction -- discard.
                    cur.execute(f"DELETE FROM {CONFLICT_TABLE} WHERE id = %s;", (row['id'],))

            conn.commit()
            time.sleep(MISTRAL_CALL_DELAY_SECONDS)

        print(f"[LLM JUDGE] Enrichment complete for edge {edge_id}.")
    except Exception as e:
        print(f"[LLM JUDGE CRITICAL ERROR] Enrichment failed for edge {edge_id}: {e}")
    finally:
        cur.close()
        conn.close()


class BatchAuditItem(BaseModel):
    pair_index: int = Field(
        description="The index (starting at 0) of the segment pair this verdict corresponds to, matching the 'Pair N' label given in the prompt."
    )
    is_contradiction: bool = Field(
        description="True if the text segments structurally contradict, clash in metrics, or impose opposing mandates. False if they align or discuss different topics."
    )
    reasoning: str = Field(
        description="Detailed compliance explanation of what the conflict is, why it occurs, and the institutional risk involved."
    )
    highlight_terms_a: List[str] = Field(
        description="Specific precise words or phrases (like metrics, numbers, keywords) inside Segment A causing the conflict that the frontend should highlight."
    )
    highlight_terms_b: List[str] = Field(
        description="Specific precise words or phrases (like metrics, numbers, keywords) inside Segment B causing the conflict that the frontend should highlight."
    )
    isolated_summary_a: str = Field(
        description="The extracted 2-3 critical lines from Segment A that explicitly frame the conflict, bypassing unnecessary fluff text."
    )
    isolated_summary_b: str = Field(
        description="The extracted 2-3 critical lines from Segment B that explicitly frame the conflict, bypassing unnecessary fluff text."
    )


class BatchAuditReportSchema(BaseModel):
    verdicts: List[BatchAuditItem] = Field(
        description="Exactly one verdict per input pair, covering every pair given, in any order (matched back by pair_index)."
    )


BATCH_SIZE = 6
MISTRAL_CALL_DELAY_SECONDS = 1.5


def check_logical_contradictions_batch(pairs: List[dict], max_retries: int = 3) -> dict:
    """
    Evaluates MULTIPLE independent segment pairs in a single Mistral call.
    pairs: list of {"source_text": ..., "target_text": ...}
    Returns {"judge_error": bool, "verdicts": [...]} -- verdicts carry a
    pair_index matching each pair's position in the input list.

    Mistral's response_format={"type": "json_object"} guarantees syntactically
    valid JSON but NOT an exact schema match, so the expected shape is spelled
    out explicitly in the prompt and the response is validated against
    BatchAuditReportSchema afterward -- a validation failure is treated the
    same as any other judge_error (retryable, then left pending).
    """
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
                # Likely a schema validation failure on a malformed response -- retry once.
                print(f"[-] Batch response invalid (attempt {attempt + 1}/{max_retries}): {error_str}")
                time.sleep(2)
                continue

            print(f"[-] Batch evaluation failure: {e}")
            return {"judge_error": True, "judge_error_message": error_str, "verdicts": []}


def rebuild_graph_edges():
    # Existing legacy full rebuild logic remains untouched here if ever needed manually.
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
    """Graph view: ALL documents and ALL edges between them (no archival filter)."""
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
               COUNT(c.id) FILTER (WHERE c.reasoning IS NOT NULL) AS confirmed_conflict_count
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

    return {"nodes": nodes, "links": links}


def fetch_conflicts(doc1: str, doc2: str):
    """Confirmed (judge-enriched) conflicts between a specific pair of documents."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT id, edge_id, source_text, target_text,
               reasoning, isolated_summary_a, isolated_summary_b,
               highlight_terms_a, highlight_terms_b, drift_score, created_at
        FROM {CONFLICT_TABLE}
        WHERE ((source_doc = %s AND target_doc = %s) OR (source_doc = %s AND target_doc = %s))
          AND reasoning IS NOT NULL
        ORDER BY drift_score ASC;
    """, (doc1, doc2, doc2, doc1))

    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts


def fetch_all_conflicts():
    """Inbox Triage view: ALL confirmed conflicts across ALL documents."""
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
    """
    Returns one aggregated row per unique (source_doc, target_doc) pair that
    has at least one judge-confirmed conflict. Used by the Triage Inbox view
    so it shows document pairs (not individual conflict rows).
    """
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT
            source_doc,
            target_doc,
            COUNT(*) AS conflict_count,
            MIN(drift_score) AS min_drift,
            MAX(created_at) AS latest_at
        FROM {CONFLICT_TABLE}
        WHERE reasoning IS NOT NULL
        GROUP BY source_doc, target_doc
        ORDER BY latest_at DESC;
    """)

    pairs = cur.fetchall()
    cur.close()
    conn.close()
    return pairs




def fetch_conflicts_by_edge(edge_id: int):
    """Used by /api/investigate/{edge_id} for the instant pre-calculated report."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(f"""
        SELECT id, edge_id, source_doc, target_doc,
               source_text, target_text,
               reasoning, isolated_summary_a, isolated_summary_b,
               highlight_terms_a, highlight_terms_b, drift_score, created_at
        FROM {CONFLICT_TABLE}
        WHERE edge_id = %s
        ORDER BY drift_score ASC;
    """, (edge_id,))

    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts


def dismiss_conflict(conflict_id: int):
    """Marks a conflict as a human-reviewed false positive and logs the override."""
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
    """Escalates a conflict to the compliance team for document revision."""
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


def delete_document(document_name: str):
    """
    Surgically removes a document and all of its associated semantic
    relationships (edges and conflicts) from the database.
    """
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