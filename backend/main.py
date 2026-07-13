from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import os
import shutil
from pydantic import BaseModel
import engine
from database import setup_database
from sandbox import ingest_chunk_vectorize
from engine import dismiss_conflict, flag_conflict, resolve_conflict, fetch_triage_pairs, enrich_structural_deltas

app = FastAPI(title="Semantic Compliance Engine API")


@app.on_event("startup")
def initialize_schema():
    setup_database()
    # Ensure the status, reviewed_at, and detection_method columns exist (idempotent migrations)
    try:
        conn = engine.get_db_connection()
        cur = conn.cursor()
        cur.execute("ALTER TABLE detected_conflicts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';")
        cur.execute("ALTER TABLE detected_conflicts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;")
        cur.execute("ALTER TABLE detected_conflicts ADD COLUMN IF NOT EXISTS detection_method VARCHAR(20) DEFAULT 'vector';")
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"[STARTUP] Migration warning: {e}")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1", "http://localhost:3000", "http://localhost:5173"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploaded_temp"
os.makedirs(UPLOAD_DIR, exist_ok=True)


@app.get("/")
def health_check():
    return {"status": "Online", "message": "Knowledge Graph Engine is running."}


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...), background_tasks: BackgroundTasks = None):
    """
    Ingestion + Predecessor Delta Check.
    1. Vectorises the uploaded file.
    2. Registers its base_name and finds ALL prior versions of the same document
       family WITHOUT archiving any of them.
    3. Runs a synchronous vector-distance pass against every predecessor so
       candidate conflicts land in the DB immediately.
    4. Schedules LLM enrichment for each predecessor edge as a background task
       so the HTTP response is never blocked on the LLM.
    """
    try:
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # 1. Vectorize
        ingest_chunk_vectorize(file_path)
        os.remove(file_path)

        # 2. Register base_name, collect ALL predecessors (no archival)
        conn = engine.get_db_connection()
        cur = conn.cursor(cursor_factory=engine.RealDictCursor)
        predecessors = engine.register_and_get_predecessors(cur, file.filename)
        conn.commit()
        cur.close()
        conn.close()

        # 3. Compare against every predecessor (vector pass is fast, structural diff runs here too)
        edge_ids = []
        for predecessor in predecessors:
            edge_id = engine.compare_versions(file.filename, predecessor)
            if edge_id:
                edge_ids.append(edge_id)

        return {
            "status": "delta_checked" if predecessors else "new_document",
            "message": (
                f"Delta check against {len(predecessors)} predecessor(s) complete."
                if predecessors else "New document indexed."
            ),
            "requires_deep_search": True,
            "document_id": file.filename,
            "predecessor_count": len(predecessors),
            "edge_ids": edge_ids
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class DeepSearchRequest(BaseModel):
    doc_id: str


class AnalyzeRequest(BaseModel):
    edge_ids: list[int]


@app.post("/api/analyze")
async def analyze_edges(request: AnalyzeRequest):
    """
    Synchronous LLM enrichment phase.
    The frontend calls this after upload so it can show a real "Analyzing..." state
    while waiting for the LLM judge to process all detected edge conflicts.
    """
    try:
        for edge_id in request.edge_ids:
            engine.enrich_conflicts(edge_id)
            engine.enrich_structural_deltas(edge_id)
        return {"status": "success", "message": "Analysis complete."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/graph/deep-search")
async def trigger_deep_search(request: DeepSearchRequest, background_tasks: BackgroundTasks):
    """
    PHASE 2: Background Deep Search Execution.
    engine.compute_graph_edges already handles vector detection AND the LLM
    enrichment pass internally (both are safe to run in the background here).
    """
    background_tasks.add_task(engine.compute_graph_edges, request.doc_id)
    return {"status": "accepted", "message": f"Deep search initiated in the background for {request.doc_id}."}


@app.get("/api/documents")
def list_documents():
    try:
        docs = engine.fetch_all_document_names()
        return {"status": "success", "total": len(docs), "documents": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/graph")
def get_knowledge_graph():
    """Graph view: only the latest (active) documents and edges between them."""
    try:
        graph_data = engine.fetch_graph_data()
        return {"status": "success", "data": graph_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/triage")
def get_triage_inbox():
    """Inbox Triage view: ALL confirmed conflicts across ALL documents."""
    try:
        conflicts = engine.fetch_all_conflicts()
        return {"status": "success", "total": len(conflicts), "conflicts": conflicts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/triage/pairs")
def get_triage_pairs():
    """
    Aggregated document-pair view for the Triage Inbox UI.
    Returns one row per unique (source_doc, target_doc) pair with
    conflict_count, min_drift, and latest_at so the frontend can
    render the inbox without duplicating pairs.
    """
    try:
        pairs = fetch_triage_pairs()
        return {"status": "success", "total": len(pairs), "pairs": pairs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/investigate/{edge_id}")
def investigate_conflict(edge_id: int):
    """Pulls the pre-calculated, judge-enriched conflict report instantly for a given edge."""
    try:
        conflicts = engine.fetch_conflicts_by_edge(edge_id)
        return {"status": "success", "edge_id": edge_id, "conflicts": conflicts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/investigate")
def investigate_conflict_by_docs(source: str, target: str):
    """
    Same instant pre-calculated report, but keyed by document name pair instead
    of edge_id -- matches the frontend's actual call pattern
    (/api/investigate?source=...&target=...).
    """
    try:
        conflicts = engine.fetch_conflicts(source, target)
        return {"status": "success", "source": source, "target": target, "conflicts": conflicts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/enrich/retry-pending")
async def retry_pending_enrichment(background_tasks: BackgroundTasks):
    """
    Re-runs the LLM judge over any conflict rows that were detected by vector
    distance but never got a verdict (e.g. because a previous run hit a
    Gemini quota/network error). Use this after fixing an API key/quota issue.
    """
    background_tasks.add_task(engine.retry_pending_enrichment)
    return {"status": "accepted", "message": "Retrying enrichment for all pending conflicts in the background."}


@app.delete("/api/documents/{doc_name}")
def delete_document_endpoint(doc_name: str):
    """API Route to destroy a document and rebuild the active workspace."""
    try:
        engine.delete_document(doc_name)
        return {"status": "success", "message": f"Document {doc_name} destroyed."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/conflicts/{conflict_id}/dismiss")
def dismiss_conflict_endpoint(conflict_id: int):
    """Marks a detected conflict as a human-reviewed false positive."""
    try:
        dismiss_conflict(conflict_id)
        return {"status": "success", "message": f"Conflict {conflict_id} dismissed as false positive."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/conflicts/{conflict_id}/flag")
def flag_conflict_endpoint(conflict_id: int):
    """Escalates a conflict to the compliance team for document revision."""
    try:
        flag_conflict(conflict_id)
        return {"status": "success", "message": f"Conflict {conflict_id} flagged for revision."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/conflicts/{conflict_id}/resolve")
def resolve_conflict_endpoint(conflict_id: int):
    """Marks a flagged conflict as resolved after review."""
    try:
        resolve_conflict(conflict_id)
        return {"status": "success", "message": f"Conflict {conflict_id} resolved."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))