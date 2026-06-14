import os
import psycopg2
from pgvector import register_vector
import numpy as np
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URI = os.getenv("SUPABASE_URI")

if not SUPABASE_URI:
    raise ValueError("Architecture Error: SUPABASE_URI is missing. Check your .env file.")

def get_connection():
    "Establishes a secure connection to PostgreSQL and registers pgvector."
    conn = psycopg2.connect(SUPABASE_URI)
    register_vector(conn)
    return conn

def setup_database():
    "Creates the structural table to hold your documents and AI embeddings."
    try:
        conn = get_connection()
        cur = conn.cursor()

        print("[DB] Initializing Vector Table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS corporate_policies (
                id SERIAL PRIMARY KEY,
                document_name VARCHAR(255) NOT NULL,
                chunk_text TEXT NOT NULL,
                embedding vector(384) NOT NULL
            );
        """)
        conn.commit()
        print("[DB] Table 'corporate_policies' is ready.")
    
    except Exception as e:
        print(f"Database Initialization error: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()

def store_vectors_in_db(document_name: str, chunks: list, embeddings: np.ndarray):
    "Loops through the generated chunks and mathematically stores them in PostgreSQL."
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        print(f"[DB] Committing {len(chunks)} contextual chunks to permanent memory...")
        for i in range(len(chunks)):
            # Convert NumPy array to a standard Python list for PostgreSQL insertion
            vector_list = embeddings[i].tolist()
            
            cur.execute("""
                INSERT INTO corporate_policies (document_name, chunk_text, embedding)
                VALUES (%s, %s, %s)
            """, (document_name, chunks[i], vector_list))
            
        conn.commit()
        print("[+] Success: All document vectors permanently stored in PostgreSQL!")
        
    except Exception as e:
        print(f"Database Insertion Error: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()