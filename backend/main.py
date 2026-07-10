from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import os
import shutil
from pydantic import BaseModel
import engine
from database import setup_database
from sandbox import ingest_chunk_vectorize

app = FastAPI(title="Semantic Compliance Engine API")


@app.on_event("startup")
def initialize_schema():
    setup_database()


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
    PHASE 1: Ingestion and Local Delta Check.
    Vector-only detection runs synchronously (it's fast). If it finds any
    candidate conflicts against the previous version, the LLM enrichment pass
    is scheduled as a background task so the upload response doesn't wait on
    Gemini -- by the time the frontend calls /api/investigate, it's usually
    already enriched.
    """
    try:
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # 1. Vectorize
        ingest_chunk_vectorize(file_path)
        os.remove(file_path)

        # 2. Database Version Routing
        conn = engine.get_db_connection()
        cur = conn.cursor(cursor_factory=engine.RealDictCursor)
        old_version = engine.handle_versioning(cur, file.filename)
        conn.commit()
        cur.close()
        conn.close()

        # 3. Determine if Delta exists
        if old_version:
            edge_id = engine.compare_versions(file.filename, old_version)
            if edge_id:
                background_tasks.add_task(engine.enrich_conflicts, edge_id)

            return {
                "status": "delta_checked",
                "message": f"Delta check against {old_version} complete.",
                "requires_deep_search": True,
                "document_id": file.filename,
                "edge_id": edge_id
            }
        else:
            return {
                "status": "new_document",
                "message": "New document indexed.",
                "requires_deep_search": True,
                "document_id": file.filename
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class DeepSearchRequest(BaseModel):
    doc_id: str


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
    """Inbox Triage view: ALL confirmed conflicts across ALL documents, active or deprecated."""
    try:
        conflicts = engine.fetch_all_conflicts()
        return {"status": "success", "total": len(conflicts), "conflicts": conflicts}
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