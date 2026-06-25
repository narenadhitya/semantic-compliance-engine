import psycopg2
import difflib
import json
import os
from psycopg2.extras import RealDictCursor
import difflib
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

SUPABASE_URI = os.getenv("SUPABASE_URI")

TABLE_NAME = "corporate_policies"

if not SUPABASE_URI:
    raise ValueError("Architecture Error: SUPABASE_URI is missing. Check your .env file.")

def get_db_connection():
    return psycopg2.connect(SUPABASE_URI)

def fetch_all_document_names():
    """Retrieves a unique list of all ingested documents in the database."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        # We use DISTINCT so if a file has 50 chunks, its name only appears once
        cur.execute(f"SELECT DISTINCT document_name FROM {TABLE_NAME} ORDER BY document_name ASC;")
        
        # Unpack the list of tuples returned by psycopg2
        documents = [row[0] for row in cur.fetchall()]
        
        cur.close()
        conn.close()
        return documents
    except Exception as e:
        print(f"[-] Error fetching document registry: {e}")
        return []

def compute_graph_edges(new_document_name: str):
    """
    Runs automatically after a document is uploaded. 
    It scans the HNSW index for overlapping semantic topics and logs any conflicts.
    """
    print(f"\n[GRAPH ENGINE] Calculating semantic edges for '{new_document_name}'...")
    
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # 1. Fetch the chunks of the newly uploaded document
    cur.execute("SELECT chunk_text, embedding FROM corporate_policies WHERE document_name = %s;", (new_document_name,))
    new_chunks = cur.fetchall()
    
    # 2. Fetch the names of all OTHER documents currently in the database
    cur.execute("SELECT DISTINCT document_name FROM corporate_policies WHERE document_name != %s;", (new_document_name,))
    other_docs = [row['document_name'] for row in cur.fetchall()]
    
    for other_doc in other_docs:
        max_doc_similarity = 0
        doc_conflicts = []
        
        for chunk in new_chunks:
            # We explicitly format the vector for pgvector
            if isinstance(chunk['embedding'], str):
                vector_string = chunk['embedding']
            else:
                vector_string = '[' + ','.join(map(str, chunk['embedding'])) + ']'
            
            # Use the HNSW Index to find the absolute closest semantic match in the other document
            cur.execute(f"""
                SELECT chunk_text, (embedding <=> %s::vector) AS distance
                FROM {TABLE_NAME}
                WHERE document_name = %s 
                ORDER BY embedding <=> %s::vector
                LIMIT 1;
            """, (vector_string, other_doc, vector_string))
            
            match = cur.fetchone()
            if not match:
                continue
                
            distance = match['distance']
            similarity = 1 - distance
            
            # Track the strongest overall connection between these two documents
            if similarity > max_doc_similarity:
                max_doc_similarity = similarity
                
            # If the context matches (distance < 0.25) but the text is different (distance > 0.05) -> IT'S A CONFLICT
            if 0.05 <= distance <= 0.25:
                doc_conflicts.append({
                    "source_text": chunk['chunk_text'],
                    "target_text": match['chunk_text'],
                    "drift_score": distance
                })
        
        # 3. Graph Threshold Logic (Executive Decision: 0.82)
        # If these two documents share a strong semantic relationship, draw an Edge!
        if max_doc_similarity >= 0.82:
            print(f"[+] Edge Established: {new_document_name} <---> {other_doc} (Similarity: {max_doc_similarity:.2f})")
            
            # Save the Edge
            cur.execute("""
                INSERT INTO document_edges (source_doc, target_doc, max_similarity) 
                VALUES (%s, %s, %s) ON CONFLICT DO NOTHING;
            """, (new_document_name, other_doc, max_doc_similarity))
            
            # Save the specific red/green conflicts tied to this edge
            for conflict in doc_conflicts:
                cur.execute("""
                    INSERT INTO detected_conflicts (source_doc, target_doc, source_text, target_text, drift_score)
                    VALUES (%s, %s, %s, %s, %s);
                """, (new_document_name, other_doc, conflict['source_text'], conflict['target_text'], conflict['drift_score']))

    conn.commit()
    cur.close()
    conn.close()
    print("[GRAPH ENGINE] Pre-computation complete. Knowledge Graph updated.")

def fetch_graph_data():
    """Builds the JSON payload required by the React Force Graph library."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # 1. Get Nodes (Every unique document)
    cur.execute(f"SELECT DISTINCT document_name as id FROM {TABLE_NAME};")
    nodes = cur.fetchall()
    
    # 2. Get Edges (The calculated relationships)
    cur.execute("SELECT source_doc as source, target_doc as target, max_similarity FROM document_edges;")
    links = cur.fetchall()
    
    cur.close()
    conn.close()
    
    return {
        "nodes": nodes,
        "links": links
    }

def fetch_conflicts(doc1: str, doc2: str):
    """Fetches the pre-calculated red/green contradictions between two specific files."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    # We check both directions in case doc2 was uploaded before doc1
    cur.execute("""
        SELECT source_text, target_text, drift_score 
        FROM detected_conflicts 
        WHERE (source_doc = %s AND target_doc = %s)
           OR (source_doc = %s AND target_doc = %s)
        ORDER BY drift_score ASC;
    """, (doc1, doc2, doc2, doc1))
    
    conflicts = cur.fetchall()
    
    cur.close()
    conn.close()
    
    return conflicts