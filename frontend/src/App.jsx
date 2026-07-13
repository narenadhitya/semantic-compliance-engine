import React, { useState, useEffect, useRef, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import { API_BASE_URL } from './config';
import './App.css';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Simulated pipeline stages shown while a freshly uploaded document
// is ingested, compared against the corpus, and analyzed by the judge.
const STAGES = [
  { key: 'ingesting', label: 'Ingesting document…', pct: 30 },
  { key: 'comparing', label: 'Comparing against corpus…', pct: 68 },
  { key: 'analyzing', label: 'Generating analysis…', pct: 92 },
];

// ─────────────────────────────────────────────────────────────────
// TOASTS
// ─────────────────────────────────────────────────────────────────
function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type} ${t.leaving ? 'leaving' : ''}`}>
          <div className="toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '!' : '⧖'}
          </div>
          <div>
            <div className="toast-text">{t.message}</div>
            {t.sub && <div className="toast-sub">{t.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SEGMENTED CONTROL — Graph view | List view
// ─────────────────────────────────────────────────────────────────
function ViewSwitcher({ viewMode, setViewMode }) {
  const options = [
    { key: 'inbox', label: '≡ List view' },
    { key: 'graph', label: '⎈ Graph view' },
  ];
  const activeIdx = options.findIndex((o) => o.key === viewMode);

  return (
    <div className="segmented">
      <div
        className="segmented-indicator"
        style={{ width: '50%', transform: `translateX(${activeIdx * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.key}
          className={`segmented-btn ${viewMode === o.key ? 'active' : ''}`}
          onClick={() => setViewMode(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// NEON HIGHLIGHT PARSER
// ─────────────────────────────────────────────────────────────────
function NeonText({ text, terms = [] }) {
  if (!text) return null;
  if (!terms || terms.length === 0) return <>{text}</>;

  const escaped = terms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            style={{
              color: 'var(--sev-red)',
              textShadow: '0 0 8px var(--sev-red-glow)',
              fontWeight: 600,
            }}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// CONFLICT CARD
// ─────────────────────────────────────────────────────────────────
function ConflictCard({ conflict, idx, sourceDoc, targetDoc, onDismiss, onFlag, onResolve }) {
  const [actionState, setActionState] = useState(conflict.status || 'active');
  const [loading, setLoading] = useState(null);

  const parseTerms = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
  };

  const termsA = parseTerms(conflict.highlight_terms_a);
  const termsB = parseTerms(conflict.highlight_terms_b);

  const drift = typeof conflict.drift_score === 'number' ? conflict.drift_score : null;
  const driftPct = drift !== null ? Math.round((1 - drift) * 100) : null;

  const handleDismiss = async () => {
    setLoading('dismiss');
    try {
      await axios.patch(`${API_BASE_URL}/api/conflicts/${conflict.id}/dismiss`);
      setActionState('dismissed');
      setTimeout(() => onDismiss(conflict.id), 600);
    } catch (e) {
      console.error('Dismiss failed:', e);
    } finally {
      setLoading(null);
    }
  };

  const handleFlag = async () => {
    setLoading('flag');
    try {
      await axios.patch(`${API_BASE_URL}/api/conflicts/${conflict.id}/flag`);
      setActionState('flagged');
      onFlag(conflict.id);
    } catch (e) {
      console.error('Flag failed:', e);
    } finally {
      setLoading(null);
    }
  };

  const handleResolve = async () => {
    setLoading('resolve');
    try {
      await axios.patch(`${API_BASE_URL}/api/conflicts/${conflict.id}/resolve`);
      setActionState('resolved');
      setTimeout(() => onResolve(conflict.id), 600);
    } catch (e) {
      console.error('Resolve failed:', e);
    } finally {
      setLoading(null);
    }
  };

  const isFlagged = actionState === 'flagged';
  const isDismissed = actionState === 'dismissed' || actionState === 'resolved';
  const isResolved = actionState === 'resolved';

  return (
    <div
      style={{
        border: `1px solid ${isFlagged ? 'rgba(201,154,74,0.45)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
        backdropFilter: 'blur(10px)',
        marginBottom: '16px',
        overflow: 'hidden',
        opacity: isDismissed ? 0.35 : 1,
        transform: isDismissed ? 'scale(0.97)' : 'scale(1)',
        transition: 'opacity 0.5s var(--ease), transform 0.5s var(--ease), border-color 0.3s var(--ease)',
        animationDelay: `${idx * 0.07}s`,
        animation: 'cardIn 0.35s var(--ease) forwards',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'rgba(0,0,0,0.15)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="mono" style={{
            fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.5px',
            color: 'var(--text-faint)',
          }}>#{idx + 1} Structural Contradiction</span>
          {isFlagged && (
            <span className="mono" style={{
              fontSize: '9px',
              background: 'var(--sev-amber-dim)', color: 'var(--sev-amber)',
              border: '1px solid rgba(201,154,74,0.35)', borderRadius: '10px',
              padding: '2px 8px', letterSpacing: '0.5px',
            }}>FLAGGED FOR REVISION</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {driftPct !== null && (
            <span className="mono" style={{
              fontSize: '10px',
              color: 'var(--sev-red)', background: 'var(--sev-red-dim)',
              border: '1px solid rgba(209,88,74,0.25)', borderRadius: '4px',
              padding: '2px 7px',
            }}>⚡ {driftPct}% tension</span>
          )}
          <span className="mono" style={{
            fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.5px',
            padding: '3px 8px', borderRadius: '12px', fontWeight: 500,
            background: 'var(--sev-red-dim)', color: 'var(--sev-red)',
            border: '1px solid rgba(209,88,74,0.35)',
          }}>High</span>
        </div>
      </div>

      {conflict.reasoning && (
        <div style={{
          margin: '14px 14px 0',
          padding: '12px 14px',
          background: 'var(--sev-red-dim)',
          border: '1px solid rgba(209,88,74,0.2)',
          borderLeft: '3px solid var(--sev-red)',
          borderRadius: '6px',
        }}>
          <div className="mono" style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '9px', textTransform: 'uppercase', letterSpacing: '1px',
            color: 'var(--sev-red)', marginBottom: '8px',
          }}>
            <span style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: 'var(--sev-red)', display: 'inline-block',
              boxShadow: '0 0 6px var(--sev-red-glow)',
            }}></span>
            AI Compliance Verdict
          </div>
          <div style={{ fontSize: '12px', lineHeight: '1.65', color: 'var(--text-muted)' }}>
            {conflict.reasoning}
          </div>
        </div>
      )}

      <div style={{ padding: '14px 14px 0' }}>
        <div className="mono" style={{
          fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.8px',
          color: 'var(--text-faint)', marginBottom: '10px',
        }}>Isolated Blast Radius</div>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          <div style={{
            flex: 1, background: 'rgba(0,0,0,0.18)', border: '1px solid var(--border)',
            borderRadius: '7px', padding: '12px',
          }}>
            <div className="mono" style={{
              fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px',
              color: 'var(--sev-green)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--sev-green)', display: 'inline-block' }}></span>
              {sourceDoc?.split('.')[0] ?? 'Source'}
            </div>
            <div style={{ fontSize: '12px', lineHeight: '1.6', color: 'var(--text-muted)' }}>
              <NeonText text={conflict.isolated_summary_a || conflict.source_text} terms={termsA} />
            </div>
          </div>

          <div style={{
            flex: 1, background: 'rgba(0,0,0,0.18)', border: '1px solid var(--border)',
            borderRadius: '7px', padding: '12px',
          }}>
            <div className="mono" style={{
              fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px',
              color: 'var(--sev-amber)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--sev-amber)', display: 'inline-block' }}></span>
              {targetDoc?.split('.')[0] ?? 'Target'}
            </div>
            <div style={{ fontSize: '12px', lineHeight: '1.6', color: 'var(--text-muted)' }}>
              <NeonText text={conflict.isolated_summary_b || conflict.target_text} terms={termsB} />
            </div>
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: '8px', padding: '12px 14px',
        borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)',
      }}>
        {!isFlagged && !isResolved ? (
          <>
            <button
              id={`btn-dismiss-${conflict.id}`}
              onClick={handleDismiss}
              disabled={loading !== null || isDismissed}
              className="btn"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {loading === 'dismiss' ? '···' : isDismissed ? '✓ Dismissed' : '✗ Dismiss · False Positive'}
            </button>
            <button
              id={`btn-flag-${conflict.id}`}
              onClick={handleFlag}
              disabled={loading !== null || isDismissed}
              className="btn danger"
              style={{ flex: 1, justifyContent: 'center', fontWeight: 600 }}
            >
              {loading === 'flag' ? '···' : '⚑ Flag for Revision'}
            </button>
          </>
        ) : (
          <button
            id={`btn-resolve-${conflict.id}`}
            onClick={handleResolve}
            disabled={loading !== null || isResolved}
            className={`btn ${isResolved ? 'success' : 'amber'}`}
            style={{ flex: 1, justifyContent: 'center', fontWeight: 600 }}
          >
            {loading === 'resolve' ? '···' : isResolved ? '✓ Review Complete' : '✓ Mark as Review Complete'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [triagePairs, setTriagePairs] = useState([]);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const [deepSearchPrompt, setDeepSearchPrompt] = useState(null);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  const [activeMenu, setActiveMenu] = useState(null);

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [drawerWidth, setDrawerWidth] = useState(460);

  // Default landing view is now the Triage Inbox
  const [viewMode, setViewMode] = useState('inbox');

  const handleSidebarMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent) => {
      const newWidth = Math.max(200, Math.min(600, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleDrawerMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = drawerWidth;

    const handleMouseMove = (moveEvent) => {
      const newWidth = Math.max(300, Math.min(800, startWidth - (moveEvent.clientX - startX)));
      setDrawerWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRows, setSelectedRows] = useState(new Set());

  // Documents currently moving through the ingest → compare → analyze pipeline
  const [pendingDocs, setPendingDocs] = useState([]);
  const [toasts, setToasts] = useState([]);

  const containerRef = useRef(null);
  const fileInputRef = useRef(null);

  const pushToast = useCallback((message, type = 'success', sub = null) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, type, sub, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 380);
    }, 4200);
  }, []);

  useEffect(() => {
    const handleClickOutside = () => setActiveMenu(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const loadWorkspace = async () => {
    try {
      const [docRes, graphRes, triageRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/documents`),
        axios.get(`${API_BASE_URL}/api/graph`),
        axios.get(`${API_BASE_URL}/api/triage/pairs`),
      ]);

      const nextGraph = graphRes.data?.data ?? graphRes.data ?? { nodes: [], links: [] };
      setDocuments(Array.isArray(docRes.data?.documents) ? docRes.data.documents : []);
      setGraphData({
        nodes: Array.isArray(nextGraph.nodes) ? nextGraph.nodes : [],
        links: Array.isArray(nextGraph.links) ? nextGraph.links : [],
      });
      setTriagePairs(Array.isArray(triageRes.data?.pairs) ? triageRes.data.pairs : []);
    } catch (error) {
      console.error('SYSTEM FAILURE: Unable to map database topology.', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    const timer = setTimeout(updateDimensions, 300);
    return () => {
      window.removeEventListener('resize', updateDimensions);
      clearTimeout(timer);
    };
  }, [drawerOpen, viewMode]);

  const setPendingStage = (name, stage) => {
    setPendingDocs((prev) => prev.map((d) => (d.name === name ? { ...d, stage } : d)));
  };

  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    let targetDocId = null;

    const names = files.map((f) => f.name);
    setPendingDocs((prev) => [
      ...prev,
      ...names.map((n) => ({ name: n, stage: 'ingesting' })),
    ]);

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        
        // Stage 1: Upload, Text Extraction, Vectorization, and Edge Comparison
        const res = await axios.post(`${API_BASE_URL}/api/upload`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        if (res.data.requires_deep_search) {
          targetDocId = res.data.document_id;
        }

        const edgeIds = res.data.edge_ids || [];
        if (edgeIds.length > 0) {
          setPendingStage(file.name, 'analyzing');
          await axios.post(`${API_BASE_URL}/api/analyze`, { edge_ids: edgeIds });
        }
      }

      await loadWorkspace();

      names.forEach((n) => pushToast(`${n} processed successfully`, 'success', 'Document processing complete'));
      if (targetDocId) setDeepSearchPrompt(targetDocId);
    } catch (error) {
      console.error('Upload pipeline failure:', error);
      names.forEach((n) => pushToast(`${n} failed to process`, 'error', 'Check the connection and retry'));
    } finally {
      setPendingDocs((prev) => prev.filter((d) => !names.includes(d.name)));
      setUploading(false);
      event.target.value = '';
    }
  };

  const executeDeepSearch = async () => {
    setIsDeepSearching(true);
    try {
      await axios.post(`${API_BASE_URL}/api/graph/deep-search`, { doc_id: deepSearchPrompt });
      setTimeout(() => {
        loadWorkspace();
        setDeepSearchPrompt(null);
        setIsDeepSearching(false);
      }, 3500);
    } catch (error) {
      console.error('Deep search failed to initiate.', error);
      setIsDeepSearching(false);
    }
  };

  const handleRebuildGraph = async () => {
    setUploading(true);
    try {
      await axios.post(`${API_BASE_URL}/api/graph/rebuild`);
      await loadWorkspace();
      pushToast('Index rebuilt', 'success');
    } catch (error) {
      console.error('Index rebuilding failure:', error);
      pushToast('Re-index failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const openInspectDrawer = async (sourceId, targetId) => {
    setSelectedEdge({ source: sourceId, target: targetId });
    setDrawerOpen(true);
    setConflicts([]);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/investigate`, {
        params: { source: sourceId, target: targetId },
      });
      setConflicts(Array.isArray(res.data?.conflicts) ? res.data.conflicts : []);
    } catch (error) {
      console.error('Failed to retrieve conflict vectors:', error);
    }
  };

  const handleLinkClick = (link) => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    openInspectDrawer(sourceId, targetId);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => {
      setSelectedEdge(null);
      loadWorkspace();
    }, 300);
  };

  const handleDeleteDocument = async (docName) => {
    setActiveMenu(null);
    try {
      await axios.delete(`${API_BASE_URL}/api/documents/${docName}`);
      if (selectedEdge && (selectedEdge.source === docName || selectedEdge.target === docName)) {
        closeDrawer();
      }
      await loadWorkspace();
      pushToast(`${docName} removed`, 'info');
    } catch (error) {
      console.error(`[SYSTEM ERROR] Failed to delete ${docName}:`, error);
      pushToast(`Failed to remove ${docName}`, 'error');
    }
  };

  const renderNode = (node, ctx, globalScale) => {
    const label = node.id;
    const fontSize = 11.5 / globalScale;
    const incidentLinks = graphData.links.filter(
      (l) =>
        (typeof l.source === 'object' ? l.source.id : l.source) === node.id ||
        (typeof l.target === 'object' ? l.target.id : l.target) === node.id
    );
    const hasActive = incidentLinks.some(l => l.edge_status === 'active');
    const hasFlagged = incidentLinks.some(l => l.edge_status === 'flagged');

    ctx.beginPath();
    ctx.arc(node.x, node.y, 6, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#1c2430';
    ctx.fill();
    ctx.lineWidth = 1.5 / globalScale;
    ctx.strokeStyle = hasActive ? '#d1584a' : (hasFlagged ? '#c99a4a' : '#4c9a6d');
    ctx.stroke();
    ctx.font = `${fontSize}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e9edf3';
    ctx.fillText(label, node.x, node.y + 12);
  };

  const filteredPairs = triagePairs.filter((pair) => {
    const s = searchQuery.toLowerCase();
    return pair.source_doc.toLowerCase().includes(s) || pair.target_doc.toLowerCase().includes(s);
  });

  const handleToggleRow = (idx) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(idx)) newSelected.delete(idx);
    else newSelected.add(idx);
    setSelectedRows(newSelected);
  };

  const handleToggleAll = () => {
    if (selectedRows.size === filteredPairs.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(filteredPairs.map((_, i) => i)));
  };

  return (
    <div className="shell">
      <ToastStack toasts={toasts} />

      {deepSearchPrompt && (
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 9999, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(4, 6, 10, 0.78)', backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
          }}
        >
          <div
            style={{
              background: 'rgba(19, 26, 35, 0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid var(--signal-border)', borderRadius: 'var(--radius-lg)', padding: '30px', maxWidth: '450px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 40px rgba(79,216,196,0.08)', textAlign: 'center',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '18px', color: 'var(--text)', marginBottom: '10px', fontWeight: 500 }}>
              Local Delta Audit Complete
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '25px', lineHeight: '1.6' }}>
              The engine has successfully checked <b style={{ color: 'var(--text)' }}>{deepSearchPrompt}</b> against its direct predecessors. <br /><br />
              Would you like to execute a Deep Semantic Audit across the entire knowledge base to detect hidden cross-document contradictions?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button onClick={() => setDeepSearchPrompt(null)} className="btn" disabled={isDeepSearching} style={{ flex: 1, justifyContent: 'center' }}>
                Skip Full Audit
              </button>
              <button onClick={executeDeepSearch} className="btn primary" disabled={isDeepSearching} style={{ flex: 1, justifyContent: 'center' }}>
                {isDeepSearching ? 'Auditing Database…' : 'Execute Deep Search'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="topbar">
        <div className="brand">
          <div className="brand-mark"></div>
          <div className="brand-name">Semantic Compliance Engine</div>
          <div className="brand-sub">Knowledge Audit</div>
        </div>
        <div className="topbar-actions">
          <div className="status-chip"><span className="status-dot"></span> System Live</div>
          <button className="btn">Export report</button>
          <button className="btn primary" onClick={handleRebuildGraph} disabled={uploading}>
            {uploading ? 'Processing…' : '↻ Re-index'}
          </button>
        </div>
      </div>

      <div className="body">
        <div className={`sidebar ${drawerOpen ? 'collapsed' : ''}`} id="sidebar" style={{ width: sidebarWidth, position: 'relative' }}>
          <div className="resize-handle" onMouseDown={handleSidebarMouseDown} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '4px', cursor: 'ew-resize', zIndex: 10, background: 'transparent' }} onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'} onMouseLeave={(e) => e.target.style.background = 'transparent'}></div>
          <div className="sidebar-inner" style={{ width: sidebarWidth }}>
            <div className="stats-row">
              <div className="stat"><div className="stat-num">{documents.length}</div><div className="stat-label">Documents</div></div>
              <div className="stat conflict"><div className="stat-num">{triagePairs.length}</div><div className="stat-label">Conflict Pairs</div></div>
              <div className="stat warning"><div className="stat-num">{graphData.links.filter((l) => l.edge_status === 'active' || l.edge_status === 'flagged').length}</div><div className="stat-label">Graph Edges</div></div>
            </div>

            <input ref={fileInputRef} type="file" multiple accept=".txt,.pdf,.docx" className="hidden" style={{ display: 'none' }} onChange={handleFileUpload} />
            <div className="upload-zone" onClick={() => fileInputRef.current?.click()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="1.6">
                <path d="M12 16V4M12 4l-4 4M12 4l4 4" /><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
              <div className="upload-zone-text">{uploading ? 'Ingesting data…' : 'Drop files or click to upload'}</div>
              <div className="upload-zone-sub">.pdf · .docx · .md · .txt</div>
            </div>

            <div className="sidebar-tabs">
              <div className="sidebar-tab active">All files</div>
              <div className="sidebar-tab">By severity</div>
            </div>

            <div className="file-list">
              <div className="file-group-label">Document Registry</div>

              {pendingDocs.map((doc) => {
                const stageInfo = STAGES.find((s) => s.key === doc.stage) || STAGES[0];
                return (
                  <div key={`pending-${doc.name}`} className="file-row processing" style={{ animation: 'rowIn 0.3s var(--ease)' }}>
                    <div className="processing-spinner"></div>
                    <div className="file-meta" style={{ flex: 1, minWidth: 0 }}>
                      <div className="file-name">{doc.name}</div>
                      <div key={doc.stage} className="processing-stage">{stageInfo.label}</div>
                      <div className="stage-track"><div className="stage-fill" style={{ width: `${stageInfo.pct}%` }}></div></div>
                    </div>
                  </div>
                );
              })}

              {documents.length === 0 && pendingDocs.length === 0 ? (
                <div style={{ padding: '10px 8px', fontSize: '11px', color: 'var(--text-faint)', fontStyle: 'italic' }}>No infrastructure mapped.</div>
              ) : (
                documents.map((doc, idx) => {
                  const docName = typeof doc === 'string' ? doc : doc.document_name;

                  return (
                    <div key={idx} className="file-row" style={{ position: 'relative' }}>
                      <span className="health-dot healthy"></span>
                      <span className="file-icon">▤</span>
                      <div className="file-meta" style={{ flex: 1, minWidth: 0 }}>
                        <div className="file-name">{docName}</div>
                        <div className="file-date mono">Indexed</div>
                      </div>

                      <div style={{ position: 'relative' }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveMenu(activeMenu === docName ? null : docName);
                          }}
                          className="btn ghost icon"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="1.5"></circle>
                            <circle cx="12" cy="5" r="1.5"></circle>
                            <circle cx="12" cy="19" r="1.5"></circle>
                          </svg>
                        </button>

                        {activeMenu === docName && (
                          <div
                            style={{
                              position: 'absolute', right: 0, top: '30px',
                              background: 'rgba(19,26,35,0.92)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                              border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', padding: '4px',
                              zIndex: 50, minWidth: '150px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                              animation: 'rowIn 0.15s var(--ease)',
                            }}
                          >
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveMenu(null);
                                setDeepSearchPrompt(docName);
                              }}
                              className="mono"
                              style={{
                                padding: '8px 10px', fontSize: '11px', color: 'var(--signal)', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px',
                                transition: 'background 0.15s var(--ease)', marginBottom: '2px',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--signal-dim)')}
                              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                              Run Deep Search
                            </div>

                            <div
                              onClick={(e) => { e.stopPropagation(); handleDeleteDocument(docName); }}
                              className="mono"
                              style={{
                                padding: '8px 10px', fontSize: '11px', color: 'var(--sev-red)', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px',
                                transition: 'background 0.15s var(--ease)',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--sev-red-dim)')}
                              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                              Destroy File
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="canvas-wrap" ref={containerRef} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10 }}>
            <ViewSwitcher viewMode={viewMode} setViewMode={setViewMode} />
          </div>

          <div className="canvas-toolbar-right">
            <button className="btn icon">⤢</button>
          </div>

          {loading ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="mono" style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading Vectors…</div>
            </div>
          ) : viewMode === 'graph' ? (
            <>
              <ForceGraph2D
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeRelSize={6}
                linkColor={(link) => link.edge_status === 'active' ? 'rgba(209, 88, 74, 0.85)' : link.edge_status === 'flagged' ? 'rgba(201, 154, 74, 0.85)' : 'rgba(76, 154, 109, 0.5)'}
                linkWidth={(link) => (link.edge_status === 'active' || link.edge_status === 'flagged' ? 2.5 : 1.5)}
                onLinkClick={handleLinkClick}
                nodeCanvasObject={renderNode}
                backgroundColor="transparent"
              />
              <div className="legend">
                <div className="legend-title">Edge legend</div>
                <div className="legend-row"><span className="legend-line" style={{ background: 'var(--sev-green)' }}></span> Aligned / high similarity</div>
                <div className="legend-row"><span className="legend-line" style={{ background: 'var(--sev-amber)' }}></span> Overlap, under review</div>
                <div className="legend-row"><span className="legend-line" style={{ background: 'var(--sev-red)' }}></span> Contradiction detected</div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingTop: '60px', overflow: 'hidden' }}>
              <div style={{ padding: '0 20px 15px 20px', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <div className="sidebar-search" style={{ margin: 0, flex: 1, maxWidth: '400px' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
                  <input
                    type="text"
                    placeholder="Filter by document name…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}></div>
                <div className="mono" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                  {filteredPairs.length} conflict pair{filteredPairs.length !== 1 ? 's' : ''}
                </div>
                {selectedRows.size > 0 && (
                  <button className="btn danger sm">Bulk Dismiss ({selectedRows.size})</button>
                )}
              </div>

              <div className="mono" style={{ display: 'flex', padding: '10px 20px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.015)', fontSize: '10.5px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                <div style={{ width: '36px' }}>
                  <input type="checkbox" onChange={handleToggleAll} checked={selectedRows.size === filteredPairs.length && filteredPairs.length > 0} />
                </div>
                <div style={{ width: '90px' }}>Severity</div>
                <div style={{ flex: 1 }}>Document Conflict Pair</div>
                <div style={{ width: '90px' }}>Conflicts</div>
                <div style={{ width: '130px' }}>Last Detected</div>
                <div style={{ width: '100px', textAlign: 'right' }}>Action</div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scrollbar">
                {filteredPairs.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-faint)', fontSize: '13px' }}>
                    <div style={{ fontSize: '28px', marginBottom: '12px', opacity: 0.2 }}>⊘</div>
                    {triagePairs.length === 0
                      ? 'No confirmed conflict pairs yet. Upload documents and run a deep search.'
                      : 'No pairs match your filter.'}
                  </div>
                ) : (
                  filteredPairs.map((pair, idx) => {
                    const isSelected = selectedRows.has(idx);
                    const detectedAt = pair.latest_at
                      ? new Date(pair.latest_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : '—';
                    const tensionPct = pair.min_drift !== null ? Math.round((1 - pair.min_drift) * 100) : null;

                    return (
                      <div
                        key={`${pair.source_doc}-${pair.target_doc}`}
                        style={{
                          display: 'flex', alignItems: 'center', padding: '13px 20px',
                          borderBottom: '1px solid var(--border)',
                          background: isSelected ? 'var(--sev-red-dim)' : 'transparent',
                          transition: 'background 0.18s var(--ease)',
                          animation: 'rowIn 0.3s var(--ease)',
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--surface-2)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isSelected ? 'var(--sev-red-dim)' : 'transparent'; }}
                      >
                        <div style={{ width: '36px' }}>
                          <input type="checkbox" checked={isSelected} onChange={() => handleToggleRow(idx)} />
                        </div>

                        <div className="mono" style={{ width: '90px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ color: 'var(--sev-red)', fontSize: '14px' }}>●</span>
                          <span style={{ color: 'var(--sev-red)', fontSize: '11px' }}>High</span>
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={pair.source_doc}>
                              {pair.source_doc}
                            </span>
                            <span style={{ color: 'var(--sev-red)', fontSize: '12px', flexShrink: 0 }}>⟷</span>
                            <span style={{ fontSize: '12px', color: 'var(--sev-amber)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={pair.target_doc}>
                              {pair.target_doc}
                            </span>
                          </div>
                          {tensionPct !== null && (
                            <div className="mono" style={{ fontSize: '10px', color: 'var(--sev-red)', marginTop: '3px' }}>
                              ⚡ {tensionPct}% semantic tension
                            </div>
                          )}
                        </div>

                        <div style={{ width: '90px' }}>
                          <span className="mono" style={{
                            fontSize: '11px',
                            background: 'var(--sev-red-dim)', color: 'var(--sev-red)',
                            border: '1px solid rgba(209,88,74,0.3)', borderRadius: '4px',
                            padding: '2px 8px',
                          }}>
                            {pair.conflict_count} found
                          </span>
                        </div>

                        <div className="mono" style={{ width: '130px', fontSize: '11px', color: 'var(--text-muted)' }}>
                          {detectedAt}
                        </div>

                        <div style={{ width: '100px', textAlign: 'right' }}>
                          <button
                            id={`inbox-inspect-${idx}`}
                            onClick={() => openInspectDrawer(pair.source_doc, pair.target_doc)}
                            className="btn danger sm"
                          >
                            Inspect →
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`drawer ${drawerOpen ? 'open' : ''}`} id="drawer" style={{ ...(drawerOpen ? { width: drawerWidth } : {}), position: 'relative' }}>
          <div className="resize-handle" onMouseDown={handleDrawerMouseDown} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', cursor: 'ew-resize', zIndex: 10, background: 'transparent' }} onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'} onMouseLeave={(e) => e.target.style.background = 'transparent'}></div>
          {selectedEdge && (
            <div className="drawer-inner" style={{ width: drawerWidth }}>
              <div style={{
                padding: '18px 20px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(0,0,0,0.2)',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{
                    fontSize: '9px', letterSpacing: '1px', textTransform: 'uppercase',
                    color: 'var(--sev-red)', marginBottom: '10px',
                    display: 'flex', alignItems: 'center', gap: '6px',
                  }}>
                    <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: 'var(--sev-red)', boxShadow: '0 0 6px var(--sev-red-glow)' }}></span>
                    Conflict Investigation
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span className="mono" style={{
                      fontSize: '11.5px', color: 'var(--text)', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 8px',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px',
                    }} title={selectedEdge.source}>{selectedEdge.source}</span>
                    <span style={{ color: 'var(--sev-red)', fontSize: '14px', flexShrink: 0 }}>⟷</span>
                    <span className="mono" style={{
                      fontSize: '11.5px', color: 'var(--sev-amber)', background: 'var(--surface-2)',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 8px',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px',
                    }} title={selectedEdge.target}>{selectedEdge.target}</span>
                  </div>
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--text-faint)', marginTop: '8px' }}>
                    {conflicts.filter(c => (c.status || 'active') === 'active').length} active · {conflicts.length} total
                  </div>
                </div>
                <button className="drawer-close" onClick={closeDrawer} style={{ flexShrink: 0, marginLeft: '8px' }}>×</button>
              </div>

              <div className="drawer-body custom-scrollbar">
                {conflicts.length === 0 ? (
                  <div className="mono" style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', marginTop: '60px' }}>
                    <div style={{ fontSize: '24px', marginBottom: '12px', opacity: 0.3 }}>⧖</div>
                    Awaiting server telemetry…
                  </div>
                ) : (
                  conflicts
                    .slice()
                    .sort((a, b) => {
                      const priority = { active: 1, flagged: 2, resolved: 3, dismissed: 3 };
                      return (priority[a.status || 'active'] || 1) - (priority[b.status || 'active'] || 1);
                    })
                    .map((conflict, idx) => (
                      <ConflictCard
                        key={conflict.id ?? idx}
                        conflict={conflict}
                        idx={idx}
                        sourceDoc={selectedEdge.source}
                        targetDoc={selectedEdge.target}
                        onDismiss={(id) => setConflicts((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'dismissed' } : c)))}
                        onFlag={(id) => setConflicts((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'flagged' } : c)))}
                        onResolve={(id) => setConflicts((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'resolved' } : c)))}
                      />
                    ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}