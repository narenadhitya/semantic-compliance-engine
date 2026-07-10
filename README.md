# Semantic Compliance Engine

A full-stack knowledge audit system that ingests corporate policy documents, builds a semantic graph of relationships between them, and surfaces confirmed logical contradictions using a vector-distance detection pipeline followed by an LLM judge. Auditors review conflicts through a dark-mode investigation panel with AI-generated reasoning, isolated text summaries, neon-highlighted conflict terms, and one-click resolution actions.

---

## What It Does

- **Ingest** documents (PDF, DOCX, TXT) and chunk them into 384-dimensional sentence embeddings stored in PostgreSQL with pgvector.
- **Version tracking** — when a new version of a document is uploaded, the engine automatically detects all prior versions of the same document family and runs a delta comparison against each one. No documents are ever archived or hidden.
- **Semantic graph** — cosine-distance comparisons build a graph of `document_edges`. Edges where vector distance falls inside the conflict band are flagged as candidate contradictions.
- **LLM enrichment** — candidate pairs are evaluated in batches by a Mistral judge that returns structured verdicts: reasoning, isolated summaries, highlight terms, and a true/false contradiction verdict. False positives are deleted; confirmed conflicts are stored with full metadata.
- **Triage Inbox** — all confirmed conflict pairs are surfaced in a searchable inbox with conflict count, semantic tension score, and detection date.
- **Investigation Panel** — a sliding drawer showing the full conflict report for any pair: AI verdict banner, side-by-side isolated summaries with neon-highlighted contradicting terms, drift score, and dismiss/flag resolution buttons.

---

## Repository Layout

```
semantic-compliance-engine/
├── backend/
│   ├── main.py          # FastAPI application and all API routes
│   ├── engine.py        # Graph logic, vector detection, LLM enrichment, DB queries
│   ├── database.py      # Schema setup and connection helpers
│   ├── ingestion.py     # Document chunking utilities
│   ├── sandbox.py       # Ingest-chunk-vectorize pipeline entry point
│   ├── requirements.txt
│   └── .env             # SUPABASE_URI and MISTRAL_API_KEY (not committed)
├── frontend/
│   ├── src/
│   │   ├── App.jsx      # Main application: graph view, triage inbox, investigation drawer
│   │   ├── App.css      # Design system and component styles
│   │   └── config.js    # API base URL configuration
│   ├── index.html
│   └── package.json
└── test/                # Sample policy documents for populating the graph
```

---

## Prerequisites

- Python 3.11 or newer
- Node.js 20 or newer
- A PostgreSQL database with the `vector` extension enabled (Supabase works out of the box)
- A Mistral API key for the LLM enrichment judge

---

## Setup

### 1. Backend

Create `backend/.env`:

```env
SUPABASE_URI=postgresql://user:password@host:5432/database
MISTRAL_API_KEY=your_mistral_api_key_here
LLM_JUDGE_MODEL=mistral-small-latest   # optional, defaults to mistral-small-latest
```

Install dependencies and start the server:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The database schema (tables, HNSW index, and any idempotent column migrations) is created automatically on startup.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

If the API is not on `http://127.0.0.1:8000`, create `frontend/.env`:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
```

---

## How It Works

### Upload & Predecessor Delta Check

Uploading a document triggers a two-phase process:

1. **Vectorisation** — the file is chunked and each chunk is embedded using `sentence-transformers` and stored in `corporate_policies`.
2. **Predecessor scan** — the engine finds all prior documents with the same base name (e.g. `Employee_Handbook_v1.pdf` and `Employee_Handbook_v2.pdf` share the base `Employee_Handbook`). A synchronous vector-distance pass runs against every predecessor, writing candidate conflict rows to `detected_conflicts`.
3. **LLM enrichment** — for each predecessor edge found, `enrich_conflicts` is scheduled as a FastAPI background task. The Mistral judge evaluates candidates in batches of 6, writes reasoning/summaries/highlight terms for confirmed contradictions, and deletes false positives.

### Deep Search

After uploading, the UI offers a **Deep Semantic Audit** that compares the new document against every other document in the database (not just the same family). This runs fully in the background via `compute_graph_edges`.

### Conflict Detection Band

A chunk pair is flagged as a candidate when its cosine distance falls between `CONFLICT_DISTANCE_MIN = 0.01` and `CONFLICT_DISTANCE_MAX = 0.38`. This band captures chunks that are semantically related (close enough to be about the same topic) but divergent enough to suggest contradiction.

---

## Database Schema

| Table | Purpose |
|---|---|
| `corporate_policies` | Document chunks with 384-d embeddings, `base_name` for family grouping |
| `document_edges` | One row per compared document pair with `max_similarity` |
| `detected_conflicts` | Candidate and confirmed conflict rows: `reasoning`, `isolated_summary_a/b`, `highlight_terms_a/b`, `drift_score`, `status`, `reviewed_at` |

---

## API Reference

### Documents

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/api/upload` | Ingest a document; runs predecessor delta check and schedules LLM enrichment |
| `GET` | `/api/documents` | List all indexed document names |
| `DELETE` | `/api/documents/{doc_name}` | Delete a document and all its edges and conflicts |

### Graph

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/graph` | Full graph payload — all document nodes and edges |
| `POST` | `/api/graph/deep-search` | Background deep semantic comparison for a given document |

### Triage & Investigation

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/triage` | All confirmed conflict rows across all documents |
| `GET` | `/api/triage/pairs` | Aggregated view: one row per `(source_doc, target_doc)` pair with conflict count, min drift, and latest detection date |
| `GET` | `/api/investigate` | Full conflict report for a pair: `?source=...&target=...` |
| `GET` | `/api/investigate/{edge_id}` | Full conflict report keyed by edge ID |

### Resolution Actions

| Method | Path | Description |
|---|---|---|
| `PATCH` | `/api/conflicts/{id}/dismiss` | Mark a conflict as a human-reviewed false positive |
| `PATCH` | `/api/conflicts/{id}/flag` | Escalate a conflict to the compliance team for document revision |

### Enrichment

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/enrich/retry-pending` | Re-run the LLM judge over any conflict rows left unenriched (e.g. after a rate-limit error) |

---

## Frontend Views

### Topology Graph

Force-directed graph of all documents and their semantic edges. Red edges indicate confirmed contradictions. Click any edge to open the Investigation Panel.

### Triage Inbox

Searchable table of all confirmed conflict pairs. Each row shows:
- Severity badge
- Source and target document names with semantic tension percentage
- Conflict count
- Detection date
- `[Inspect →]` button to open the Investigation Panel

### Investigation Panel (Sliding Drawer)

Opens when clicking a conflict edge or an inbox row. Contains:

1. **Clash Header** — both document names displayed as chips with a `⟷` separator
2. **AI Verdict Banner** — the Mistral judge's reasoning string, bordered in red
3. **Isolated Blast Radius** — side-by-side cards showing `isolated_summary_a` and `isolated_summary_b` (the 2–3 sentences that frame the actual conflict)
4. **Neon Highlights** — conflicting terms identified by the judge are highlighted with `color: #ef4444; text-shadow: 0 0 8px rgba(239,68,68,0.6)` using a dynamic regex parser
5. **Resolution Actions** — **Dismiss (False Positive)** removes the conflict from the active queue and logs the human override; **Flag for Revision** escalates it to the compliance team

---

## Sample Documents

The `test/` directory contains example policy documents. Upload them through the UI or via `curl`:

```bash
curl -X POST http://127.0.0.1:8000/api/upload \
  -F "file=@test/Employee_Handbook_2024.pdf"
```

After uploading two or more related documents, click **Execute Deep Search** in the UI to trigger the full cross-document audit.
