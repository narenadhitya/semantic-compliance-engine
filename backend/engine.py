import psycopg2
import difflib
import json
from psycopg2.extras import RealDictCursor

# --- CONFIGURATION ---
# Update these to match your local PostgreSQL credentials
DB_NAME = "compliance_db"
DB_USER = "postgres"
DB_PASS = "your_password"
DB_HOST = "localhost"
DB_PORT = "5432"

TABLE_NAME = "document_chunks" # Update if your Phase 2 table has a different name

def get_db_connection():
    return psycopg2.connect(
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASS,
        host=DB_HOST,
        port=DB_PORT
    )

def fetch_document_chunks(filename: str):
    """Fetches all chunks and their vectors for a specific document."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # Assuming columns: id, filename, chunk_text, embedding
    cur.execute(f"""
        SELECT id, chunk_text, embedding 
        FROM {TABLE_NAME} 
        WHERE filename = %s
        ORDER BY id ASC;
    """, (filename,))
    
    chunks = cur.fetchall()
    cur.close()
    conn.close()
    return chunks

def find_nearest_semantic_match(target_filename: str, query_embedding: list):
    """Uses pgvector cosine distance (<=>) to find the closest chunk in the target document."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # Convert the Python list to a pgvector compatible string format: '[0.1, 0.2, ...]'
    vector_string = '[' + ','.join(map(str, query_embedding)) + ']'
    
    cur.execute(f"""
        SELECT chunk_text, (embedding <=> %s::vector) AS cosine_distance
        FROM {TABLE_NAME}
        WHERE filename = %s
        ORDER BY embedding <=> %s::vector
        LIMIT 1;
    """, (vector_string, target_filename, vector_string))
    
    match = cur.fetchone()
    cur.close()
    conn.close()
    return match

def run_audit(doc1_name: str, doc2_name: str):
    print(f"\n{'='*60}")
    print(f"AUDIT INITIALIZED: {doc1_name} vs {doc2_name}")
    print(f"{'='*60}\n")

    doc1_chunks = fetch_document_chunks(doc1_name)
    if not doc1_chunks:
        print(f"[-] Error: No data found for {doc1_name} in the database.")
        return

    conflict_report = []

    for chunk in doc1_chunks:
        doc1_text = chunk['chunk_text']
        doc1_vector = chunk['embedding']

        # 1. Vector Math: Find the closest semantic match
        match = find_nearest_semantic_match(doc2_name, doc1_vector)
        
        if not match:
            continue
            
        doc2_text = match['chunk_text']
        distance = match['cosine_distance']

        # 2. Structural Math: Calculate exact character differences
        matcher = difflib.SequenceMatcher(None, doc1_text, doc2_text)
        structural_ratio = matcher.ratio() # Returns 0.0 to 1.0

        # 3. Threshold Evaluation
        # Distance < 0.05 is usually functionally identical in SentenceTransformers
        if distance < 0.05:
            status = "HEALTHY"
        elif distance > 0.30:
            status = "DELETED / MISSING"
        else:
            status = "CONFLICT (SEMANTIC DRIFT)"
            
            # Save the conflict for the final printout
            conflict_report.append({
                "doc1_text": doc1_text,
                "doc2_text": doc2_text,
                "distance": distance,
                "structural_match": f"{structural_ratio * 100:.1f}%"
            })

    # --- Print the CLI Report ---
    if not conflict_report:
        print("[+] Audit Complete. 0 Conflicts Detected. Documents are semantically aligned.")
    else:
        print(f"[!] Audit Complete. {len(conflict_report)} Conflicts Detected.\n")
        
        for idx, conflict in enumerate(conflict_report, 1):
            print(f"--- CONFLICT {idx} ---")
            print(f"Status:          SEMANTIC DRIFT")
            print(f"Vector Distance: {conflict['distance']:.4f} (Closer to 0 is identical)")
            print(f"Difflib Match:   {conflict['structural_match']} (Literal character overlap)\n")
            
            print("ORIGINAL (Doc 1):")
            print(f"\"{conflict['doc1_text']}\"\n")
            
            print("ALTERED (Doc 2):")
            print(f"\"{conflict['doc2_text']}\"\n")
            print("-" * 60 + "\n")

if __name__ == "__main__":
    # Replace these with the actual filenames you stored in your database during Phase 1/2
    source_document = "v1_policy.docx"
    target_document = "v2_policy.docx"
    
    run_audit(source_document, target_document)