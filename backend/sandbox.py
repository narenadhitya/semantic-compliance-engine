from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer
import os
import argparse

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

if __name__ == "__main__":
    # 1. Initialize the Argument Parser
    parser = argparse.ArgumentParser(
        description="Run the Semantic Compliance Ingestion Pipeline on a specific document."
    )
    
    # 2. Define the expected argument (the file path)
    parser.add_argument(
        "filepath", 
        type=str, 
        help="The relative or absolute path to the document you want to process."
    )
    
    # 3. Parse the command-line input
    args = parser.parse_args()
    target_document = args.filepath

    # 4. Validate the path exists before running the heavy AI models
    if not os.path.exists(target_document):
        print(f"\nArchitecture Error: Could not locate the file at path: '{target_document}'")
        print("Please ensure the path is correct and the file extension is included.")
    else:
        # 5. Run the pipeline dynamically
        ingest_chunk_vectorize(target_document)