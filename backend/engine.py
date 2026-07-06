import psycopg2
import difflib
import json
import os
import re
from itertools import combinations
from psycopg2.extras import RealDictCursor
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

def get_base_name(filename: str):
    """Strips extensions and versioning tags to group document histories robustly."""
    # 1. Strip the extension completely (e.g., .pdf, .docx)
    name, _ = os.path.splitext(filename)
    
    # 2. Match _v1, -v2.1, (1), _final, _draft, v3.0, etc.
    base = re.sub(r'([_\-\s]*(v\d+.*|\(\d+\)|final|draft|copy|new).*)$', '', name, flags=re.IGNORECASE).strip()
    
    # 3. Fallback just in case the regex stripped the entire name
    return base if base else name

def handle_versioning(cur, new_doc_name: str):
    """Deprecates old versions of a document and sets the new one to active."""
    base_name = get_base_name(new_doc_name)

    # Find the currently active document with the same base name
    cur.execute(f"""
        SELECT DISTINCT document_name FROM {TABLE_NAME}
        WHERE base_name = %s AND document_name != %s AND is_active = TRUE;
    """, (base_name, new_doc_name))
    old_versions = cur.fetchall()

    # Deprecate old versions
    cur.execute(f"""
        UPDATE {TABLE_NAME} SET is_active = FALSE
        WHERE base_name = %s AND document_name != %s;
    """, (base_name, new_doc_name))

    # Set the new document as active
    cur.execute(f"""
        UPDATE {TABLE_NAME} SET base_name = %s, is_active = TRUE
        WHERE document_name = %s;
    """, (base_name, new_doc_name))

    if old_versions:
        return old_versions[0]['document_name']
    return None

def _fetch_chunks_for_document(cur, document_name: str):
    cur.execute(f"SELECT chunk_text, embedding FROM {TABLE_NAME} WHERE document_name = %s;", (document_name,))
    return cur.fetchall()

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

def compare_versions(doc_a: str, doc_b: str):
    """Phase 1: Local Delta Check. Only compares the new version against its predecessor."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        source_doc, target_doc = _canonical_pair(doc_a, doc_b)
        max_sim, conflicts = _analyze_document_pair(cur, source_doc, target_doc)
        
        if max_sim >= EDGE_THRESHOLD or len(conflicts) > 0:
            cur.execute(f"""
                INSERT INTO {EDGE_TABLE} (source_doc, target_doc, max_similarity)
                VALUES (%s, %s, %s)
                ON CONFLICT (source_doc, target_doc)
                DO UPDATE SET max_similarity = EXCLUDED.max_similarity;
            """, (source_doc, target_doc, max_sim))
            
            for c in conflicts:
                cur.execute(f"""
                    INSERT INTO {CONFLICT_TABLE} (source_doc, target_doc, source_text, target_text, drift_score)
                    VALUES (%s, %s, %s, %s, %s);
                """, (source_doc, target_doc, c['source_text'], c['target_text'], c['drift_score']))
        conn.commit()
    finally:
        cur.close()
        conn.close()

def compute_graph_edges(new_document_name: str):
    """Phase 2: Deep Search. Compares against ALL OTHER ACTIVE documents."""
    print(f"\n[GRAPH ENGINE] Executing Deep Search for '{new_document_name}'...")
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute(f"SELECT DISTINCT document_name FROM {TABLE_NAME} WHERE is_active = TRUE AND document_name != %s;", (new_document_name,))
        other_docs = [row['document_name'] for row in cur.fetchall()]
        
        print(f"[GRAPH ENGINE] Deep search will evaluate {len(other_docs)} other active documents.")

        for target_doc in other_docs:
            print(f" -> Comparing '{new_document_name}' against '{target_doc}'")
            source_doc, target = _canonical_pair(new_document_name, target_doc)
            max_sim, doc_conflicts = _analyze_document_pair(cur, source_doc, target)

            if max_sim >= EDGE_THRESHOLD or len(doc_conflicts) > 0:
                print(f"    [+] Edge Found! Similarity: {max_sim:.2f} | Conflicts: {len(doc_conflicts)}")
                cur.execute(f"""
                    INSERT INTO {EDGE_TABLE} (source_doc, target_doc, max_similarity)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (source_doc, target_doc)
                    DO UPDATE SET max_similarity = EXCLUDED.max_similarity;
                """, (source_doc, target, max_sim))
                
                for c in doc_conflicts:
                    cur.execute(f"""
                        INSERT INTO {CONFLICT_TABLE} (source_doc, target_doc, source_text, target_text, drift_score)
                        VALUES (%s, %s, %s, %s, %s);
                    """, (source_doc, target, c['source_text'], c['target_text'], c['drift_score']))
        
        conn.commit()
        print("[GRAPH ENGINE] Deep Search complete.")
    except Exception as e:
        print(f"\n[GRAPH ENGINE CRITICAL ERROR] Deep search failed: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()

def rebuild_graph_edges():
    # Existing legacy full rebuild logic remains untouched here if ever needed manually.
    pass 

def fetch_all_document_names():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    cur.execute(f"""
        SELECT DISTINCT document_name, base_name, is_active 
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
    
    # DICTATE: Only pull ACTIVE nodes to the canvas to prevent spiderweb clutter
    cur.execute(f"SELECT DISTINCT document_name as id FROM {TABLE_NAME} WHERE is_active = TRUE;")
    nodes = cur.fetchall()
    active_docs = [n['id'] for n in nodes]
    
    if not active_docs:
        return {"nodes": [], "links": []}

    format_strings = ','.join(['%s'] * len(active_docs))
    # DICTATE: Only pull edges connecting two ACTIVE nodes
    cur.execute(f"""
        SELECT source_doc as source, target_doc as target, max_similarity 
        FROM {EDGE_TABLE}
        WHERE source_doc IN ({format_strings}) AND target_doc IN ({format_strings});
    """, tuple(active_docs) * 2)
    links = cur.fetchall()
    
    cur.close()
    conn.close()
    
    # Mapping has_conflict manually based on threshold logic for React graph colors
    for link in links:
        link['has_conflict'] = True if link['max_similarity'] > 0 else False # Simplified conflict mapping for canvas physics
        
    return {"nodes": nodes, "links": links}

def fetch_conflicts(doc1: str, doc2: str):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(f"""
        SELECT source_text, target_text, drift_score 
        FROM {CONFLICT_TABLE} 
        WHERE (source_doc = %s AND target_doc = %s) OR (source_doc = %s AND target_doc = %s)
        ORDER BY drift_score ASC;
    """, (doc1, doc2, doc2, doc1))
    conflicts = cur.fetchall()
    cur.close()
    conn.close()
    return conflicts

def delete_document(document_name: str):
    """
    Surgically removes a document and all of its associated semantic 
    relationships (edges and conflicts) from the database.
    """
    print(f"\n[GRAPH ENGINE] Initiating deletion protocol for '{document_name}'...")
    conn = get_db_connection()
    cur = conn.cursor()
    
    try:
        # 1. Sever all graph edges connected to this document
        cur.execute(f"""
            DELETE FROM {EDGE_TABLE} 
            WHERE source_doc = %s OR target_doc = %s;
        """, (document_name, document_name))
        
        # 2. Purge all calculated conflicts involving this document
        cur.execute(f"""
            DELETE FROM {CONFLICT_TABLE} 
            WHERE source_doc = %s OR target_doc = %s;
        """, (document_name, document_name))
        
        # 3. Destroy the actual vectorized chunks
        cur.execute(f"""
            DELETE FROM {TABLE_NAME} 
            WHERE document_name = %s;
        """, (document_name,))
        
        conn.commit()
        print(f"[GRAPH ENGINE] Deletion complete. {document_name} eradicated.")
    finally:
        cur.close()
        conn.close()