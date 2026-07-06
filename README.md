# Semantic Compliance Engine

Semantic Compliance Engine is a full-stack knowledge audit tool for comparing policy and governance documents, building a semantic graph, and surfacing likely conflicts between related files. The backend ingests documents into PostgreSQL with pgvector, computes similarities and conflict candidates, and exposes the graph through a FastAPI API. The frontend visualizes the resulting document network in a Vite + React interface.

## What It Does

- Upload documents and chunk them into vector embeddings.
- Store document chunks and graph edges in PostgreSQL.
- Compare a new document against its predecessor for a local delta check.
- Run a deeper semantic comparison across the active document set.
- Render the document graph and inspect conflict pairs in the browser.

## Repository Layout

- `backend/` FastAPI service, ingestion pipeline, database setup, and graph logic.
- `frontend/` React + Vite app for graph exploration and document review.
- `test/` Sample policy and compliance source documents.

## Prerequisites

- Python 3.11 or newer.
- Node.js 20 or newer.
- A PostgreSQL database with the `vector` extension available.
- A backend `.env` file containing `SUPABASE_URI`.

## Setup

### 1. Configure the backend

Create `backend/.env` if it does not already exist:

```env
SUPABASE_URI=postgresql://user:password@host:5432/database
```

Install backend dependencies:

```bash
cd backend
pip install -r requirements.txt
```

Start the API server:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Configure the frontend

Install frontend dependencies:

```bash
cd frontend
npm install
```

If the API is not running on `http://127.0.0.1:8000`, set `VITE_API_BASE_URL` in a frontend `.env` file:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
```

Start the UI:

```bash
npm run dev
```

## How It Works

1. Uploading a document sends it to `POST /api/upload`.
2. The backend vectorizes the file, stores chunks, and updates document versioning.
3. The graph view loads documents from `GET /api/documents` and edges from `GET /api/graph`.
4. Clicking an edge calls `GET /api/investigate?source=...&target=...` to retrieve conflict text.
5. Deep semantic comparison is initiated through `POST /api/graph/deep-search`.

## API Endpoints

- `GET /` health check.
- `POST /api/upload` upload and index a document.
- `POST /api/graph/deep-search` start a background deep search for a document.
- `GET /api/documents` list stored document names.
- `GET /api/graph` return the graph payload.
- `GET /api/investigate` inspect conflicts for a source/target document pair.

## Notes

- The backend initializes the schema on startup.
- The graph only displays active documents and active edges.
- The frontend currently includes a re-index button wired to a `/api/graph/rebuild` request, but that route is not implemented in the backend yet.

## Sample Content

The `test/` directory contains example documents you can upload to populate the graph and exercise the comparison flow.
