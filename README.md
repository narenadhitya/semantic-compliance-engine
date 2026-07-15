# Semantic Compliance Engine

A full-stack, AI-powered compliance audit system that ingests corporate policy documents in any format, extracts text and images, builds a semantic knowledge graph of relationships, and surfaces confirmed logical contradictions using a dual-pass detection pipeline (vector similarity + structural diff) followed by two specialised LLM judges (Mistral AI). Auditors review every conflict through a dark-mode investigation panel with AI-generated reasoning, isolated text summaries, neon-highlighted conflict terms, and one-click resolution actions.

---

## What It Does

- **Multi-format ingestion** — accepts PDF, DOCX, PPTX, TXT, MD, HTML, and ODT files. Text and images are extracted from every format; images are sent to a local vision model (Ollama `llava-phi3`) and converted to natural-language captions that become first-class searchable content.
- **Image caching** — every image is SHA-256 hashed before captioning. Identical images in different documents are only captioned once; the cached description is reused deterministically, guarding against model non-determinism.
- **Deterministic chunking** — extracted text is split into 600-character overlapping chunks (60-char overlap) using `RecursiveCharacterTextSplitter` and embedded into 384-dimensional vectors by `sentence-transformers/all-MiniLM-L6-v2`, stored in PostgreSQL with a pgvector HNSW index.
- **Version tracking** — when a new version of a document is uploaded, the engine groups documents by a canonical base name (stripping version suffixes like `_v2`, `_final`, `_draft`) and automatically compares the new document against every prior version in the same family. No documents are ever archived or hidden.
- **Dual-pass conflict detection:**
  - **Vector pass** — cosine-distance comparisons via pgvector's `<=>` operator find semantically related but divergent chunk pairs (distance band `0.01–0.38`).
  - **Structural diff pass** — a line-by-line diff using Python's `difflib` finds exact insertions, deletions, and modifications between document versions, including image alias changes.
- **Dual LLM judges (Mistral AI):**
  - **Contradiction Judge** — evaluates vector-detected chunk pairs for logical contradictions (e.g., clashing retention periods, opposing metrics).
  - **Structural Judge** — evaluates diff hunks for compliance risk (e.g., deleted clauses, reworded thresholds). Image deletions are always treated as compliance risks.
  - Both judges run in batches of 6, validate responses with Pydantic, and delete false-positive rows automatically.
- **Knowledge graph** — all documents are nodes; confirmed conflict pairs are edges. Edges are coloured by status: red (active), amber (flagged), green (healthy).
- **Deep Search** — one-click full cross-document audit that compares a newly uploaded document against every other document in the database, not just the same family.
- **Triage Inbox** — aggregated view of all conflict pairs, filterable and searchable, showing conflict count, semantic tension score, and detection date.
- **Investigation Panel** — sliding drawer with the full conflict report: AI verdict, side-by-side isolated summaries with neon-highlighted terms, drift score, and dismiss/flag/resolve actions.
- **Retry mechanism** — any conflict rows left unenriched due to API errors can be re-processed via a single endpoint.

---

## Repository Layout

```
semantic-compliance-engine/
├── backend/
│   ├── main.py          # FastAPI app — all 14 API routes
│   ├── engine.py        # Core compliance engine: graph, vector detection,
│   │                    # structural diff, dual LLM judges, CRUD
│   ├── pipeline.py      # Upload pipeline: extract → chunk → embed → store
│   ├── ingestion.py     # Format-specific text + image extraction
│   ├── vision.py        # Ollama vision model integration + image caption cache
│   ├── database.py      # Schema setup, pgvector connection, chunk storage
│   ├── requirements.txt # Python dependencies
│   └── .env             # SUPABASE_URI, MISTRAL_API_KEY, LLM_JUDGE_MODEL
├── frontend/
│   ├── src/
│   │   ├── App.jsx      # Full SPA: graph view, triage inbox, inspection drawer
│   │   ├── App.css      # Design system: dark mode, glassmorphism, animations
│   │   └── config.js    # API_BASE_URL export
│   ├── index.html
│   └── package.json
└── test/                # Sample policy documents for populating the graph
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.11+ | |
| Node.js | 20+ | |
| PostgreSQL | 14+ | Must have the `pgvector` extension. Supabase works out of the box. |
| Ollama | Latest | Must be running locally on `http://localhost:11434`. |
| Mistral API key | — | For the LLM conflict judge. `mistral-small-latest` is the default model. |

---

## Setup

### 1. Pull the Vision Model

```bash
ollama pull llava-phi3
ollama run llava-phi3   # keep it running in a separate terminal
```

### 2. Backend

Create `backend/.env`:

```env
SUPABASE_URI=postgresql://user:password@host:5432/database
MISTRAL_API_KEY=your_mistral_api_key_here
LLM_JUDGE_MODEL=mistral-small-latest   # optional, this is the default
```

Install dependencies and start the server:

```bash
cd backend
python -m venv venv
source venv/Scripts/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The database schema (tables, indexes, and idempotent column migrations) is created automatically on startup.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
# Opens on http://localhost:5173
```

If the API is not at `http://localhost:8000`, set `VITE_API_BASE_URL` in `frontend/.env`.

---

## How It Works

### Upload & Predecessor Delta Check

1. **Text extraction** (`ingestion.py`) — detects the file format and runs the appropriate parser. Embedded images are sent to `vision.get_image_caption` which:
   - SHA-256 hashes the raw image bytes.
   - Checks `image_captions_cache` — if already cached, returns the stored caption.
   - Otherwise, sends the image to the local `llava-phi3` model via Ollama and caches the result.
   - The caption is inserted into the text stream as `[IMAGE ALIAS: ...]`.

2. **Chunking & embedding** (`pipeline.py`) — the full text string is split into 600-char chunks (60-char overlap) and encoded into 384-dimensional vectors by `all-MiniLM-L6-v2`. All rows are stored in the `corporate_policies` table.

3. **Predecessor scan** — the engine strips version suffixes to find the base name, tags the new document's rows with it, and queries for all other documents sharing that base name. For each predecessor, it runs:
   - **Vector pass** — pgvector `<=>` cosine distance finds chunks in the conflict band (`0.01–0.38`).
   - **Structural diff pass** — a line-by-line diff finds all insertions, deletions, and modifications, including image alias changes.
   - Both conflict sets are merged and written to `detected_conflicts`.

4. **LLM enrichment** (`/api/analyze`) — called synchronously by the frontend after upload. Mistral processes all pending conflict rows in batches:
   - Vector conflicts are evaluated by the **Contradiction Judge**.
   - Structural conflicts are evaluated by the **Structural Judge**.
   - True conflicts receive `reasoning`, `isolated_summary_a/b`, and `highlight_terms_a/b`.
   - False positives are deleted from the database.

### Deep Search

After uploading, the UI offers a **Deep Semantic Audit** button. This runs `compute_graph_edges` which:
- Compares the new document against **every other document** in the database (not just the same family).
- Uses the vector pass only (faster — structural diff is reserved for known-version pairs).
- Creates edges and immediately runs LLM enrichment for all new edges.

### Conflict Status Lifecycle

```
detected (reasoning = NULL)
    │
    └─► LLM judge runs
           ├─► false positive  → row deleted
           └─► confirmed       → reasoning stored; status = 'active'
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                          dismiss       flag       (stays active)
                        status='dismissed'  status='flagged'
                                              │
                                              ▼
                                           resolve
                                        status='resolved'
```

---

## Database Schema

| Table | Key Columns | Purpose |
|---|---|---|
| `corporate_policies` | `document_name`, `chunk_text`, `embedding vector(384)`, `base_name` | All document chunks with their vector embeddings. HNSW index on `embedding`. |
| `document_edges` | `source_doc`, `target_doc`, `max_similarity` | One row per compared document pair. Unique on `(source_doc, target_doc)`. |
| `detected_conflicts` | `edge_id`, `source_text`, `target_text`, `drift_score`, `detection_method`, `status`, `reasoning`, `isolated_summary_a/b`, `highlight_terms_a/b`, `reviewed_at` | All conflict records — unenriched (`reasoning = NULL`) and enriched. |
| `image_captions_cache` | `image_hash` (PK), `caption`, `document_names TEXT[]` | SHA-256 keyed cache of Ollama-generated image captions. |

---

## API Reference

### Documents

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check — returns `{"status": "Online"}`. |
| `POST` | `/api/upload` | Ingest a document, run predecessor delta check. Returns `edge_ids` and `requires_deep_search`. |
| `GET` | `/api/documents` | List all indexed document names and their base names. |
| `DELETE` | `/api/documents/{doc_name}` | Permanently remove a document, all its chunks, edges, conflicts, and orphaned image cache entries. |

### Graph

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/graph` | Full graph payload — nodes (documents) and edges (conflict relationships) with status counts. |
| `POST` | `/api/graph/deep-search` | Full cross-document audit for a given `doc_id`. Runs synchronously and returns edge IDs. |

### Analysis

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/analyze` | Runs both LLM judges on a list of `edge_ids`. Called by the frontend after upload. |
| `POST` | `/api/enrich/retry-pending` | Re-runs both judges on all conflict rows where `reasoning IS NULL`. Use after fixing an API key or quota issue. |

### Triage & Investigation

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/triage` | All enriched conflict rows across the workspace. |
| `GET` | `/api/triage/pairs` | Aggregated view: one row per `(source_doc, target_doc)` pair with `conflict_count`, `min_drift`, `latest_at`. |
| `GET` | `/api/investigate?source=&target=` | Full enriched conflict report for a document pair (used by UI). |
| `GET` | `/api/investigate/{edge_id}` | Full enriched conflict report keyed by edge ID. |

### Resolution

| Method | Path | Description |
|---|---|---|
| `PATCH` | `/api/conflicts/{id}/dismiss` | Mark as human-reviewed false positive (`status = 'dismissed'`). |
| `PATCH` | `/api/conflicts/{id}/flag` | Escalate for document revision (`status = 'flagged'`). |
| `PATCH` | `/api/conflicts/{id}/resolve` | Mark as resolved after revision (`status = 'resolved'`). |

---

## Frontend Views

### Topology Graph (Graph View)
Force-directed graph rendered with `react-force-graph-2d`. Each document is a node; each conflict edge is coloured by status:
- 🔴 **Red** — active (unreviewed) conflicts.
- 🟡 **Amber** — flagged for revision.
- 🟢 **Green** — all conflicts dismissed or resolved.

Click any edge to open the Investigation Panel.

### Triage Inbox (List View)
Default landing view. Searchable list of all confirmed conflict pairs. Each row shows:
- Source and target document names.
- Semantic tension percentage (derived from `drift_score`).
- Conflict count badge.
- Detection date.
- `[Inspect →]` button to open the Investigation Panel.

### Investigation Panel (Sliding Drawer)
Opens from either the graph or the triage inbox. Contains one `ConflictCard` per conflict:

1. **Header** — conflict index, detection method, drift score as "% tension", severity badge.
2. **AI Compliance Verdict** — the Mistral judge's `reasoning` text in a red-bordered panel.
3. **Isolated Blast Radius** — two side-by-side cards showing `isolated_summary_a` and `isolated_summary_b` (the 2–3 most critical sentences from each document that frame the conflict). Conflicting terms are neon-highlighted in red using a dynamic regex parser (`NeonText` component).
4. **Resolution Actions:**
   - **Dismiss · False Positive** — greys out the card and sets `status = 'dismissed'`.
   - **Flag for Revision** — turns the card amber and sets `status = 'flagged'`.
   - **Mark as Review Complete** (shown after flagging) — sets `status = 'resolved'`.

---

## Key Configuration Constants

| Constant | Value | Meaning |
|---|---|---|
| `EDGE_THRESHOLD` | `0.65` | Minimum cosine similarity for two documents to be connected in the graph. |
| `CONFLICT_DISTANCE_MIN` | `0.01` | Chunks closer than this are near-identical, not a conflict. |
| `CONFLICT_DISTANCE_MAX` | `0.38` | Chunks further apart than this are unrelated topics, not a conflict. |
| `chunk_size` | `600` | Maximum characters per text chunk. |
| `chunk_overlap` | `60` | Overlap characters between adjacent chunks. |
| `BATCH_SIZE` | `6` | Conflict pairs per Mistral API call. |

---

## Sample Documents

The `test/` directory contains example policy documents. Upload via the UI or `curl`:

```bash
curl -X POST http://127.0.0.1:8000/api/upload \
  -F "file=@test/Employee_Handbook_2024.pdf"
```

After uploading two or more related documents, click **Execute Deep Semantic Audit** in the UI to trigger the full cross-document analysis.
