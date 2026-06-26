from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import os
import shutil

# Import your internal pipeline modules
import engine 
from database import setup_database
from sandbox import ingest_chunk_vectorize 

app = FastAPI(title="Semantic Compliance Engine API")


@app.on_event("startup")
def initialize_schema():
    setup_database()

# --- SECURITY PERIMETER OVERRIDE (CORS) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost",
        "http://127.0.0.1"
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Temporary storage for incoming files before ingestion
UPLOAD_DIR = "uploaded_temp"
os.makedirs(UPLOAD_DIR, exist_ok=True)


@app.get("/")
def health_check():
    return {"status": "Online", "message": "Knowledge Graph Engine is running."}


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    """
    1. Receives the file from React.
    2. Runs PyTorch vectorization.
    3. Silently pre-computes Knowledge Graph edges and conflicts.
    """
    try:
        file_path = os.path.join(UPLOAD_DIR, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # 1. Extract text, chunk, and embed vectors
        print(f"\n[API] Ingesting new document: {file.filename}")
        ingest_chunk_vectorize(file_path)
        
        # 2. Trigger HNSW Pre-Computation for the Knowledge Graph
        engine.compute_graph_edges(file.filename)
        
        # Cleanup
        os.remove(file_path)
        
        return {"status": "success", "message": "Document ingested and Graph updated."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/documents")
def list_documents():
    """Returns a distinct list of all corporate policies."""
    try:
        doc_list = engine.fetch_all_document_names()
        return {"status": "success", "total": len(doc_list), "documents": doc_list}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/graph")
def get_knowledge_graph():
    """
    Returns the Nodes (documents) and Edges (semantic relationships)
    formatted perfectly for the React Force Graph physics engine.
    """
    try:
        graph_data = engine.fetch_graph_data()
        return {"status": "success", "data": graph_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/graph/rebuild")
def rebuild_knowledge_graph():
    """Recomputes every edge and conflict from the stored document chunks."""
    try:
        engine.rebuild_graph_edges()
        return {"status": "success", "message": "Knowledge graph rebuilt from all documents."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/investigate")
def investigate_edge(source: str, target: str):
    """
    Instantly returns pre-computed contradictions between two documents
    when a user clicks a connecting line on the Knowledge Graph.
    """
    try:
        conflicts = engine.fetch_conflicts(source, target)
        return {
            "status": "success",
            "source": source,
            "target": target,
            "total_conflicts": len(conflicts),
            "conflicts": conflicts
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))