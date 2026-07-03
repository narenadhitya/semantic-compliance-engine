from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import os
import shutil

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
async def upload_document(file: UploadFile = File(...)):
    """PHASE 1: Ingestion and Local Delta Check"""
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
            engine.compare_versions(file.filename, old_version)
            return {
                "status": "delta_checked", 
                "message": f"Delta check against {old_version} complete.", 
                "requires_deep_search": True,
                "document_id": file.filename
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

@app.post("/api/graph/deep-search/{doc_id}")
async def trigger_deep_search(doc_id: str, background_tasks: BackgroundTasks):
    """PHASE 2: Background Deep Search Execution"""
    background_tasks.add_task(engine.compute_graph_edges, doc_id)
    return {"status": "accepted", "message": f"Deep search initiated in the background for {doc_id}."}

@app.get("/api/documents")
def list_documents():
    try:
        docs = engine.fetch_all_document_names()
        return {"status": "success", "total": len(docs), "documents": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/graph")
def get_knowledge_graph():
    try:
        graph_data = engine.fetch_graph_data()
        return {"status": "success", "data": graph_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/investigate")
def investigate_edge(source: str, target: str):
    try:
        conflicts = engine.fetch_conflicts(source, target)
        return {"status": "success", "source": source, "target": target, "conflicts": conflicts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))