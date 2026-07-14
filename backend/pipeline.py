from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import os

from ingestion import extract_text_factory
from database import setup_database, store_vectors_in_db

def ingest_chunk_vectorize(file_path: str):

    print(f"\n--- Initializing Pipeline for: {file_path} ---")

    # 1. Ingestion Layer
    try:
        raw_text = extract_text_factory(file_path)
        print(f"[+] Successfully extracted and normalized text (Length: {len(raw_text)} chars).")
    except Exception as e:
        print(f"[-] Ingestion Failed: {e}")
        return
    
    # 2. Chunking Layer
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=600, chunk_overlap=60)
    chunks = text_splitter.split_text(raw_text)
    print(f"[+] Deterministic chunking complete. Generated {len(chunks)} contextual text chunks.")

    # 3. Vector Embedding Layer
    if chunks:
        print("[+] Loading local SentenceTransformer model (all-MiniLM-L6-v2)...")

        model = SentenceTransformer('all-MiniLM-L6-v2')

        embeddings = model.encode(chunks)
        print("\n--- Pipeline Execution Complete ---")
        print(f"Vector Matrix Shape: {embeddings.shape} (Chunks, Dimensions)")

        # Display the first chunk and a snippet of its corresponding vector
        print(f"\nSample Chunk [0]:\n\"{chunks[0]}\"")
        print(f"Sample Vector [0] Preview: {embeddings[0][:5]} ...")

        # Extract just the file name (e.g., 'policy.pdf' instead of 'C:/folder/policy.pdf')
        document_filename = os.path.basename(file_path)
        
        # Ensure the table exists, then save the data
        setup_database()
        store_vectors_in_db(document_filename, chunks, embeddings)