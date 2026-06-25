from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import engine  # This imports the engine.py file we just finished!

app = FastAPI(title="Semantic Compliance API")

# Allow your React frontend to talk to this server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this to localhost:3000
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define the JSON structure we expect from React
class AuditRequest(BaseModel):
    source_file: str
    target_file: str

@app.get("/")
def health_check():
    return {"status": "Online", "message": "Compliance Engine is running."}

@app.get("/api/documents")
def list_documents():
    """
    Returns a distinct list of all corporate policies 
    currently indexed in the PostgreSQL vector database.
    """
    try:
        doc_list = engine.fetch_all_document_names()
        return {
            "status": "success",
            "total_documents": len(doc_list),
            "documents": doc_list
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    
@app.post("/api/compare")
def compare_documents(request: AuditRequest):
    try:
        # 1. We temporarily modify your run_audit function to return a list
        # instead of just printing to the terminal.
        results = engine.run_audit_json(request.source_file, request.target_file)
        
        if not results:
            return {"status": "success", "conflicts": []}
            
        return {
            "status": "success",
            "total_conflicts": len(results),
            "conflicts": results
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))