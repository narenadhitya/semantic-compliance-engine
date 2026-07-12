import os

import numpy as np
import psycopg2
from dotenv import load_dotenv
from pgvector.psycopg2 import register_vector

env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path=env_path, override=True)

SUPABASE_URI = os.getenv("SUPABASE_URI")

if not SUPABASE_URI:
    raise ValueError("Architecture Error: SUPABASE_URI is missing. Check your .env file.")


def get_connection():
    "Establishes a secure connection to PostgreSQL and registers pgvector."
    conn = psycopg2.connect(SUPABASE_URI)
    register_vector(conn)
    return conn


def setup_database():
    "Creates the structural tables and HNSW index used by the semantic graph."
    try:
        conn = get_connection()
        cur = conn.cursor()

        print("[DB] Ensuring pgvector extension is available...")
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")

        print("[DB] Initializing semantic graph tables...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS corporate_policies (
                id SERIAL PRIMARY KEY,
                document_name VARCHAR(255) NOT NULL,
                chunk_text TEXT NOT NULL,
                embedding vector(384) NOT NULL
            );
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS document_edges (
                id SERIAL PRIMARY KEY,
                source_doc VARCHAR(255) NOT NULL,
                target_doc VARCHAR(255) NOT NULL,
                max_similarity DOUBLE PRECISION NOT NULL,
                UNIQUE (source_doc, target_doc)
            );
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS detected_conflicts (
                id SERIAL PRIMARY KEY,
                source_doc VARCHAR(255) NOT NULL,
                target_doc VARCHAR(255) NOT NULL,
                source_text TEXT NOT NULL,
                target_text TEXT NOT NULL,
                drift_score DOUBLE PRECISION NOT NULL
            );
        """)

        cur.execute("""
            CREATE TABLE IF NOT EXISTS image_captions_cache (
                image_hash TEXT PRIMARY KEY,
                caption TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        cur.execute("CREATE INDEX IF NOT EXISTS corporate_policies_document_name_idx ON corporate_policies (document_name);")
        cur.execute("CREATE INDEX IF NOT EXISTS document_edges_source_target_idx ON document_edges (source_doc, target_doc);")
        cur.execute("CREATE INDEX IF NOT EXISTS detected_conflicts_source_target_idx ON detected_conflicts (source_doc, target_doc);")

        cur.execute("""
            CREATE INDEX IF NOT EXISTS corporate_policies_embedding_hnsw_idx
            ON corporate_policies USING hnsw (embedding vector_cosine_ops);
        """)

        conn.commit()
        print("[DB] Semantic graph schema is ready.")

    except Exception as e:
        print(f"Database Initialization error: {e}")
    finally:
        if 'cur' in locals():
            cur.close()
        if 'conn' in locals():
            conn.close()


def store_vectors_in_db(document_name: str, chunks: list, embeddings: np.ndarray):
    "Loops through the generated chunks and mathematically stores them in PostgreSQL."
    try:
        conn = get_connection()
        cur = conn.cursor()

        print(f"[DB] Committing {len(chunks)} contextual chunks to permanent memory...")
        for i in range(len(chunks)):
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
        if 'cur' in locals():
            cur.close()
        if 'conn' in locals():
            conn.close()