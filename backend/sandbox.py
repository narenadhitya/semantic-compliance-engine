from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer

text_splitter = RecursiveCharacterTextSplitter(chunk_size=250, chunk_overlap=20)

sample_text = """
Core office hours begin strictly at 9 AM for all personnel. 
Flexible arrivals are permitted until 10 AM on remote alternating days.
In modern production systems at companies like Sopra Steria,
 you use a pattern called De-coupled Storage and Metadata Indexing. 
 You store the heavy asset in S3, and you store the map and math of 
 that asset inside PostgreSQL
 Yes, you still absolutely need PostgreSQL. This 
 is one of the most common points of confusion when starting out with system 
 architecture. To understand why you need both, you have to understand that 
 Amazon S3 
 and PostgreSQL are built to do two completely different, non-overlapping jobs.
"""

chunks = text_splitter.split_text(sample_text)
print(f"Generated {len(chunks)} text chunks.")

model = SentenceTransformer('all-MiniLM-L6-v2')

embeddings = model.encode(chunks)
print(f"Vector Matrix Shape: {embeddings.shape}")
print(embeddings)