import psycopg2
import difflib
import json
import os
from itertools import combinations
from psycopg2.extras import RealDictCursor
import difflib
from dotenv import load_dotenv

from database import get_connection, setup_database

env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

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


def _clear_graph_tables(cur):
    cur.execute(f"TRUNCATE TABLE {EDGE_TABLE}, {CONFLICT_TABLE};")


def _fetch_chunks_for_document(cur, document_name: str):
    cur.execute(
        f"SELECT chunk_text, embedding FROM {TABLE_NAME} WHERE document_name = %s;",
        (document_name,)
    )
    return cur.fetchall()


def _analyze_document_pair(cur, doc_a: str, doc_b: str):
    chunks_a = _fetch_chunks_for_document(cur, doc_a)
    chunks_b = _fetch_chunks_for_document(cur, doc_b)

    if not chunks_a or not chunks_b:
        return 0, []

    max_doc_similarity = 0
    doc_conflicts = []

    for chunk in chunks_a:
        if isinstance(chunk['embedding'], str):
            vector_string = chunk['embedding']
        else:
            vector_string = '[' + ','.join(map(str, chunk['embedding'])) + ']'

        cur.execute(f"""
            SELECT document_name, chunk_text, (embedding <=> %s::vector) AS distance
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


def rebuild_graph_edges():
    """Rebuilds all semantic edges and conflicts across every document pair."""
    print("\n[GRAPH ENGINE] Rebuilding full semantic graph from all documents...")
    setup_database()

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    try:
        cur.execute(f"SELECT DISTINCT document_name FROM {TABLE_NAME} ORDER BY document_name ASC;")
        documents = [row['document_name'] for row in cur.fetchall()]

        _clear_graph_tables(cur)

        for doc_a, doc_b in combinations(documents, 2):
            source_doc, target_doc = _canonical_pair(doc_a, doc_b)
            max_similarity, doc_conflicts = _analyze_document_pair(cur, source_doc, target_doc)

            if max_similarity >= EDGE_THRESHOLD or len(doc_conflicts) > 0:
                print(f"[+] Edge Established: {source_doc} <---> {target_doc} (Similarity: {max_similarity:.2f}) | Conflicts: {len(doc_conflicts)}")
                cur.execute(f"""
                    INSERT INTO {EDGE_TABLE} (source_doc, target_doc, max_similarity)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (source_doc, target_doc)
                    DO UPDATE SET max_similarity = EXCLUDED.max_similarity;
                """, (source_doc, target_doc, max_similarity))

                for conflict in doc_conflicts:
                    cur.execute(f"""
                        INSERT INTO {CONFLICT_TABLE} (source_doc, target_doc, source_text, target_text, drift_score)
                        VALUES (%s, %s, %s, %s, %s);
                    """, (source_doc, target_doc, conflict['source_text'], conflict['target_text'], conflict['drift_score']))

        conn.commit()
        print("[GRAPH ENGINE] Full graph rebuild complete.")

    finally:
        cur.close()
        conn.close()

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
    print(f"\n[GRAPH ENGINE] Rebuilding semantic edges after upload of '{new_document_name}'...")
    rebuild_graph_edges()

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