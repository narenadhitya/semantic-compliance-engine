import React, { useState, useEffect, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import { API_BASE_URL } from './config';
import './App.css';

// ─────────────────────────────────────────────────────────────────
// NEON HIGHLIGHT PARSER
// Takes plain text + an array of terms to highlight, returns
// an array of React elements with matching spans glowing red.
// ─────────────────────────────────────────────────────────────────
function NeonText({ text, terms = [] }) {
  if (!text) return null;
  if (!terms || terms.length === 0) return <>{text}</>;

  const escaped = terms
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);
  // Every odd-index element after split with a capture group IS a match
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            style={{
              color: '#ef4444',
              textShadow: '0 0 8px rgba(239, 68, 68, 0.6)',
              fontWeight: 'bold',
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
// CONFLICT CARD  — the full investigation panel card
// ─────────────────────────────────────────────────────────────────
function ConflictCard({ conflict, idx, sourceDoc, targetDoc, onDismiss, onFlag }) {
  const [actionState, setActionState] = useState(conflict.status || 'active'); // active | dismissed | flagged
  const [loading, setLoading] = useState(null); // 'dismiss' | 'flag' | null

  // Parse highlight terms (stored as JSON string from DB)
  const parseTerms = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch { return []; }
  };

  const termsA = parseTerms(conflict.highlight_terms_a);
  const termsB = parseTerms(conflict.highlight_terms_b);

  // Drift score — lower = higher semantic tension
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

  const isFlagged = actionState === 'flagged';
  const isDismissed = actionState === 'dismissed';

  return (
    <div
      style={{
        border: `1px solid ${isFlagged ? 'rgba(201,154,74,0.45)' : 'rgba(40,50,62,1)'}`,
        borderRadius: '10px',
        background: '#12181f',
        marginBottom: '20px',
        overflow: 'hidden',
        opacity: isDismissed ? 0.35 : 1,
        transform: isDismissed ? 'scale(0.97)' : 'scale(1)',
        transition: 'opacity 0.5s ease, transform 0.5s ease, border-color 0.3s ease',
        animationDelay: `${idx * 0.07}s`,
        animation: 'cardIn .35s ease forwards',
      }}
    >
      {/* Card Header: index + severity + drift */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid #1e2936',
        background: '#0d1117',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '9.5px',
            textTransform: 'uppercase', letterSpacing: '0.5px', color: '#586170',
          }}>#{idx + 1} Structural Contradiction</span>
          {isFlagged && (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
              background: 'rgba(201,154,74,0.15)', color: '#c99a4a',
              border: '1px solid rgba(201,154,74,0.35)', borderRadius: '10px',
              padding: '2px 8px', letterSpacing: '0.5px',
            }}>FLAGGED FOR REVISION</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {driftPct !== null && (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px',
              color: '#ef4444', background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)', borderRadius: '4px',
              padding: '2px 7px',
              title: 'Semantic tension score',
            }}>⚡ {driftPct}% tension</span>
          )}
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '9.5px',
            textTransform: 'uppercase', letterSpacing: '0.5px',
            padding: '3px 8px', borderRadius: '12px', fontWeight: 500,
            background: 'rgba(198,86,74,0.15)', color: '#c6564a',
            border: '1px solid rgba(198,86,74,0.35)',
          }}>High</span>
        </div>
      </div>

      {/* SECTION 2: AI VERDICT BANNER */}
      {conflict.reasoning && (
        <div style={{
          margin: '14px 14px 0',
          padding: '12px 14px',
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.2)',
          borderLeft: '3px solid #ef4444',
          borderRadius: '6px',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
            textTransform: 'uppercase', letterSpacing: '1px',
            color: '#ef4444', marginBottom: '8px',
          }}>
            <span style={{
              width: '5px', height: '5px', borderRadius: '50%',
              background: '#ef4444', display: 'inline-block',
              boxShadow: '0 0 6px rgba(239,68,68,0.6)',
            }}></span>
            AI Compliance Verdict
          </div>
          <div style={{
            fontSize: '12px', lineHeight: '1.65', color: '#c5cdd6',
          }}>
            {conflict.reasoning}
          </div>
        </div>
      )}

      {/* SECTION 3 + 4: ISOLATED SUMMARIES WITH NEON HIGHLIGHTS */}
      <div style={{ padding: '14px 14px 0' }}>
        <div style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
          textTransform: 'uppercase', letterSpacing: '0.8px',
          color: '#586170', marginBottom: '10px',
        }}>Isolated Blast Radius</div>

        {/* Side-by-side summary cards */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          {/* Summary A */}
          <div style={{
            flex: 1, background: '#0d1117', border: '1px solid #1e2936',
            borderRadius: '7px', padding: '12px',
          }}>
            <div style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
              textTransform: 'uppercase', letterSpacing: '0.5px',
              color: '#4c9a6d', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#4c9a6d', display: 'inline-block' }}></span>
              {sourceDoc?.split('.')[0] ?? 'Source'}
            </div>
            <div style={{ fontSize: '12px', lineHeight: '1.6', color: '#8b95a1' }}>
              <NeonText
                text={conflict.isolated_summary_a || conflict.source_text}
                terms={termsA}
              />
            </div>
          </div>

          {/* Summary B */}
          <div style={{
            flex: 1, background: '#0d1117', border: '1px solid #2a1e1e',
            borderRadius: '7px', padding: '12px',
          }}>
            <div style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: '9px',
              textTransform: 'uppercase', letterSpacing: '0.5px',
              color: '#c6564a', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#c6564a', display: 'inline-block' }}></span>
              {targetDoc?.split('.')[0] ?? 'Target'}
            </div>
            <div style={{ fontSize: '12px', lineHeight: '1.6', color: '#8b95a1' }}>
              <NeonText
                text={conflict.isolated_summary_b || conflict.target_text}
                terms={termsB}
              />
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 5: RESOLUTION ACTIONS */}
      <div style={{
        display: 'flex', gap: '8px', padding: '12px 14px',
        borderTop: '1px solid #1e2936', background: '#0a0f14',
      }}>
        {/* Dismiss / False Positive */}
        <button
          id={`btn-dismiss-${conflict.id}`}
          onClick={handleDismiss}
          disabled={loading !== null || isDismissed || isFlagged}
          style={{
            flex: 1, padding: '9px 0', border: '1px solid #28323e',
            borderRadius: '6px', background: 'transparent',
            color: isDismissed ? '#586170' : '#8b95a1',
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '10.5px',
            letterSpacing: '0.3px', cursor: loading !== null || isDismissed || isFlagged ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s', opacity: isDismissed || isFlagged ? 0.5 : 1,
          }}
          onMouseEnter={(e) => { if (!loading && !isDismissed && !isFlagged) { e.currentTarget.style.borderColor = '#586170'; e.currentTarget.style.color = '#e8eaed'; } }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#28323e'; e.currentTarget.style.color = isDismissed ? '#586170' : '#8b95a1'; }}
        >
          {loading === 'dismiss' ? '...' : isDismissed ? '✓ Dismissed' : '✗ Dismiss · False Positive'}
        </button>

        {/* Flag for Revision */}
        <button
          id={`btn-flag-${conflict.id}`}
          onClick={handleFlag}
          disabled={loading !== null || isDismissed || isFlagged}
          style={{
            flex: 1, padding: '9px 0',
            border: `1px solid ${isFlagged ? 'rgba(201,154,74,0.6)' : 'rgba(198,86,74,0.35)'}`,
            borderRadius: '6px',
            background: isFlagged ? 'rgba(201,154,74,0.08)' : 'rgba(198,86,74,0.08)',
            color: isFlagged ? '#c99a4a' : '#c6564a',
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '10.5px',
            letterSpacing: '0.3px', cursor: loading !== null || isDismissed || isFlagged ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s', opacity: isDismissed ? 0.5 : 1,
            fontWeight: 600,
          }}
          onMouseEnter={(e) => { if (!loading && !isDismissed && !isFlagged) { e.currentTarget.style.background = 'rgba(198,86,74,0.16)'; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = isFlagged ? 'rgba(201,154,74,0.08)' : 'rgba(198,86,74,0.08)'; }}
        >
          {loading === 'flag' ? '...' : isFlagged ? '⚑ Flagged for Revision' : '⚑ Flag for Revision'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [triagePairs, setTriagePairs] = useState([]);  // conflict pairs for inbox
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  
  // Modals & Context Menus
  const [deepSearchPrompt, setDeepSearchPrompt] = useState(null);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  const [activeMenu, setActiveMenu] = useState(null);
  
  // VIEW STATE: Toggle between 'graph' and 'inbox'
  const [viewMode, setViewMode] = useState('graph');
  
  // INBOX STATES:
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRows, setSelectedRows] = useState(new Set());

  const containerRef = useRef(null);
  const fileInputRef = useRef(null);

  // Global listener to close the context menu
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
        links: Array.isArray(nextGraph.links) ? nextGraph.links : []
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

  // Structural physics: Recalculate boundaries
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
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

  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    let targetDocId = null;

    try {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await axios.post(`${API_BASE_URL}/api/upload`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            if (res.data.requires_deep_search) {
                targetDocId = res.data.document_id;
            }
        }
        await loadWorkspace(); 
        if (targetDocId) {
            setDeepSearchPrompt(targetDocId); 
        }
    } catch (error) {
        console.error('Upload pipeline failure:', error);
    } finally {
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
        console.error("Deep search failed to initiate.", error);
        setIsDeepSearching(false);
    }
  };

  const handleRebuildGraph = async () => {
    setUploading(true);
    try {
      await axios.post(`${API_BASE_URL}/api/graph/rebuild`);
      await loadWorkspace();
    } catch (error) {
      console.error('Index rebuilding failure:', error);
    } finally {
      setUploading(false);
    }
  };

  // Opens the investigation drawer — works for graph link clicks AND inbox pair clicks
  const openInspectDrawer = async (sourceId, targetId) => {
    setSelectedEdge({ source: sourceId, target: targetId });
    setDrawerOpen(true);
    setConflicts([]);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/investigate`, {
        params: { source: sourceId, target: targetId }
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
    setTimeout(() => setSelectedEdge(null), 300); 
  };

  const handleDeleteDocument = async (docName) => {
    setActiveMenu(null);
    try {
      await axios.delete(`${API_BASE_URL}/api/documents/${docName}`);
      if (selectedEdge && (selectedEdge.source === docName || selectedEdge.target === docName)) {
        closeDrawer();
      }
      await loadWorkspace();
    } catch (error) {
      console.error(`[SYSTEM ERROR] Failed to delete ${docName}:`, error);
    }
  };

  const renderNode = (node, ctx, globalScale) => {
    const label = node.id;
    const fontSize = 11.5 / globalScale;
    const hasConflict = graphData.links.some(l => 
      ((typeof l.source === 'object' ? l.source.id : l.source) === node.id || 
       (typeof l.target === 'object' ? l.target.id : l.target) === node.id) 
      && l.has_conflict
    );

    ctx.beginPath();
    ctx.arc(node.x, node.y, 6, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#1c2430'; 
    ctx.fill();
    ctx.lineWidth = 1.5 / globalScale;
    ctx.strokeStyle = hasConflict ? '#c6564a' : '#4c9a6d';
    ctx.stroke();
    ctx.font = `${fontSize}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8eaed';
    ctx.fillText(label, node.x, node.y + 12);
  };

  // INBOX LOGIC: Filter triage pairs by search query
  const filteredPairs = triagePairs.filter(pair => {
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
      {/* THE DEEP SEARCH MODAL OVERLAY */}
      {deepSearchPrompt && (
        <div style={{
            position: 'absolute', inset: 0, zIndex: 9999, display: 'flex', 
            alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(8px)'
        }}>
          <div style={{
              background: '#161c24', border: '1px solid #c99a4a', borderRadius: '8px', padding: '30px', maxWidth: '450px',
              boxShadow: '0 0 40px rgba(201, 154, 74, 0.15)', textAlign: 'center'
          }}>
            <h2 style={{fontFamily: "'Fraunces', serif", fontSize: '18px', color: '#e8eaed', marginBottom: '10px'}}>
              Local Delta Audit Complete
            </h2>
            <p style={{fontSize: '13px', color: '#8b95a1', marginBottom: '25px', lineHeight: '1.6'}}>
              The engine has successfully checked <b>{deepSearchPrompt}</b> against its direct predecessors. <br/><br/>
              Would you like to execute a Deep Semantic Audit across the entire knowledge base to detect hidden cross-document contradictions?
            </p>
            <div style={{display: 'flex', gap: '15px', justifyContent: 'center'}}>
              <button onClick={() => setDeepSearchPrompt(null)} className="btn" disabled={isDeepSearching} style={{flex: 1, justifyContent: 'center'}}>
                Skip Full Audit
              </button>
              <button onClick={executeDeepSearch} className="btn primary" disabled={isDeepSearching} style={{flex: 1, justifyContent: 'center', background: '#c99a4a', borderColor: '#c99a4a'}}>
                {isDeepSearching ? 'Auditing Database...' : 'Execute Deep Search'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP BAR */}
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark"></div>
          <div className="brand-name">Semantic Compliance Engine</div>
          <div className="brand-sub">Knowledge Audit</div>
        </div>
        <div className="topbar-actions">
          <div className="status-chip"><span className="status-dot"></span> System Live</div>
          <button className="btn">Export report</button>
          <button className="btn primary" onClick={handleRebuildGraph}>
            {uploading ? 'Processing...' : '↻ Re-index'}
          </button>
        </div>
      </div>

      {/* BODY */}
      <div className="body">
        
        {/* SIDEBAR */}
        <div className={`sidebar ${drawerOpen ? 'collapsed' : ''}`} id="sidebar">
          <div className="sidebar-inner">
            <div className="stats-row">
              <div className="stat"><div className="stat-num">{documents.length}</div><div className="stat-label">Documents</div></div>
              <div className="stat conflict"><div className="stat-num">{triagePairs.length}</div><div className="stat-label">Conflict Pairs</div></div>
              <div className="stat warning"><div className="stat-num">{graphData.links.filter(l => l.has_conflict).length}</div><div className="stat-label">Graph Edges</div></div>
            </div>

            <input ref={fileInputRef} type="file" multiple accept=".txt,.pdf,.docx" className="hidden" style={{display: 'none'}} onChange={handleFileUpload} />
            <div className="upload-zone" onClick={() => fileInputRef.current?.click()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="1.6">
                <path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>
              </svg>
              <div className="upload-zone-text">{uploading ? 'Ingesting data...' : 'Drop files or click to upload'}</div>
              <div className="upload-zone-sub">.pdf · .docx · .md · .txt</div>
            </div>

            <div className="sidebar-tabs">
              <div className="sidebar-tab active">All files</div>
              <div className="sidebar-tab">By severity</div>
            </div>

            <div className="file-list">
              <div className="file-group-label">Document Registry</div>
              {documents.length === 0 ? (
                <div style={{padding: '10px 8px', fontSize: '11px', color: '#586170', fontStyle: 'italic'}}>No infrastructure mapped.</div>
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
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px',
                            display: 'flex', alignItems: 'center', opacity: 0.6, transition: 'opacity 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e8eaed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="1.5"></circle>
                            <circle cx="12" cy="5" r="1.5"></circle>
                            <circle cx="12" cy="19" r="1.5"></circle>
                          </svg>
                        </button>

                        {activeMenu === docName && (
                          <div style={{
                            position: 'absolute', right: 0, top: '24px', background: '#1c2430', 
                            border: '1px solid #28323e', borderRadius: '6px', padding: '4px', 
                            zIndex: 50, minWidth: '140px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)'
                          }}>
                            <div 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setActiveMenu(null); 
                                setDeepSearchPrompt(docName); 
                              }}
                              style={{
                                padding: '8px 10px', fontSize: '11px', color: '#6fa8c9', cursor: 'pointer', 
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px',
                                transition: 'background 0.15s', marginBottom: '2px'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(111, 168, 201, 0.1)'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                              Run Deep Search
                            </div>

                            <div 
                              onClick={(e) => { e.stopPropagation(); handleDeleteDocument(docName); }}
                              style={{
                                padding: '8px 10px', fontSize: '11px', color: '#c6564a', cursor: 'pointer', 
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px',
                                transition: 'background 0.15s'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(198, 86, 74, 0.1)'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
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

        {/* MAIN VIEWPORT */}
        <div className="canvas-wrap" ref={containerRef} style={{ display: 'flex', flexDirection: 'column' }}>
          
          {/* Universal Toolbar */}
          <div style={{ position: 'absolute', top: '16px', left: '16px', display: 'flex', gap: '8px', zIndex: 10 }}>
            {/* The Mandatory View Switcher */}
            <select 
              className="btn"
              style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', outline: 'none', cursor: 'pointer' }}
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
            >
              <option value="graph">⎈ Topology Graph</option>
              <option value="inbox">≡ Triage Inbox</option>
            </select>
          </div>

          <div className="canvas-toolbar-right">
            <button className="btn icon">⤢</button>
          </div>

          {/* DYNAMIC RENDERING: Canvas OR Inbox */}
          {loading ? (
             <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
               <div style={{ color: '#8b95a1', fontSize: '13px' }} className="mono">Loading Vectors...</div>
             </div>
          ) : viewMode === 'graph' ? (
             <>
                <ForceGraph2D
                  width={dimensions.width}
                  height={dimensions.height}
                  graphData={graphData}
                  nodeRelSize={6}
                  linkColor={(link) => link.has_conflict ? 'rgba(198, 86, 74, 0.85)' : 'rgba(76, 154, 109, 0.5)'}
                  linkWidth={(link) => link.has_conflict ? 2.5 : 1.5}
                  onLinkClick={handleLinkClick}
                  nodeCanvasObject={renderNode}
                  backgroundColor="transparent"
                />
                <div className="legend">
                  <div className="legend-title">Edge legend</div>
                  <div className="legend-row"><span className="legend-line" style={{background: '#4c9a6d'}}></span> Aligned / high similarity</div>
                  <div className="legend-row"><span className="legend-line" style={{background: '#c99a4a'}}></span> Overlap, under review</div>
                  <div className="legend-row"><span className="legend-line" style={{background: '#c6564a'}}></span> Contradiction detected</div>
                </div>
             </>
          ) : (
             /* THE TRIAGE INBOX VIEW */
             <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg)', paddingTop: '60px', overflow: 'hidden' }}>
                {/* Inbox Toolbar */}
                <div style={{ padding: '0 20px 15px 20px', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div className="sidebar-search" style={{ margin: 0, flex: 1, maxWidth: '400px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
                    <input 
                      type="text" 
                      placeholder="Filter by document name..." 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <div style={{ flex: 1 }}></div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px', color: '#586170' }}>
                    {filteredPairs.length} conflict pair{filteredPairs.length !== 1 ? 's' : ''}
                  </div>
                  {selectedRows.size > 0 && (
                    <button className="btn" style={{ fontSize: '11px', color: '#c6564a', borderColor: 'rgba(198,86,74,0.3)' }}>Bulk Dismiss ({selectedRows.size})</button>
                  )}
                </div>

                {/* Inbox Table Header */}
                <div style={{ display: 'flex', padding: '10px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: '10.5px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.5px' }} className="mono">
                  <div style={{ width: '36px' }}>
                    <input type="checkbox" onChange={handleToggleAll} checked={selectedRows.size === filteredPairs.length && filteredPairs.length > 0} />
                  </div>
                  <div style={{ width: '90px' }}>Severity</div>
                  <div style={{ flex: 1 }}>Document Conflict Pair</div>
                  <div style={{ width: '90px' }}>Conflicts</div>
                  <div style={{ width: '130px' }}>Last Detected</div>
                  <div style={{ width: '100px', textAlign: 'right' }}>Action</div>
                </div>

                {/* Inbox Table Body */}
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
                      // Convert ISO timestamp → relative or formatted string
                      const detectedAt = pair.latest_at
                        ? new Date(pair.latest_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                      const tensionPct = pair.min_drift !== null
                        ? Math.round((1 - pair.min_drift) * 100)
                        : null;

                      return (
                        <div
                          key={`${pair.source_doc}-${pair.target_doc}`}
                          style={{
                            display: 'flex', alignItems: 'center', padding: '13px 20px',
                            borderBottom: '1px solid var(--border)',
                            background: isSelected ? 'rgba(198,86,74,0.04)' : 'transparent',
                            transition: 'background 0.15s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = isSelected ? 'rgba(198,86,74,0.06)' : 'var(--surface-2)'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = isSelected ? 'rgba(198,86,74,0.04)' : 'transparent'}
                        >
                          {/* Checkbox */}
                          <div style={{ width: '36px' }}>
                            <input type="checkbox" checked={isSelected} onChange={() => handleToggleRow(idx)} />
                          </div>

                          {/* Severity */}
                          <div style={{ width: '90px', display: 'flex', alignItems: 'center', gap: '6px' }} className="mono">
                            <span style={{ color: '#c6564a', fontSize: '14px' }}>🔴</span>
                            <span style={{ color: '#c6564a', fontSize: '11px' }}>High</span>
                          </div>

                          {/* Document pair */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} className="mono">
                              <span style={{ fontSize: '12px', color: '#e8eaed', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={pair.source_doc}>
                                {pair.source_doc}
                              </span>
                              <span style={{ color: '#c6564a', fontSize: '12px', flexShrink: 0 }}>⟷</span>
                              <span style={{ fontSize: '12px', color: '#c99a4a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={pair.target_doc}>
                                {pair.target_doc}
                              </span>
                            </div>
                            {tensionPct !== null && (
                              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px', color: '#ef4444', marginTop: '3px' }}>
                                ⚡ {tensionPct}% semantic tension
                              </div>
                            )}
                          </div>

                          {/* Conflict count badge */}
                          <div style={{ width: '90px' }}>
                            <span style={{
                              fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px',
                              background: 'rgba(198,86,74,0.12)', color: '#c6564a',
                              border: '1px solid rgba(198,86,74,0.3)', borderRadius: '4px',
                              padding: '2px 8px'
                            }}>
                              {pair.conflict_count} found
                            </span>
                          </div>

                          {/* Date */}
                          <div style={{ width: '130px', fontSize: '11px', color: 'var(--text-muted)', fontFamily: "'IBM Plex Mono', monospace" }}>
                            {detectedAt}
                          </div>

                          {/* Inspect button */}
                          <div style={{ width: '100px', textAlign: 'right' }}>
                            <button
                              id={`inbox-inspect-${idx}`}
                              onClick={() => openInspectDrawer(pair.source_doc, pair.target_doc)}
                              className="btn"
                              style={{ display: 'inline-flex', background: 'transparent', borderColor: 'rgba(198,86,74,0.4)', color: '#c6564a', fontSize: '11px', padding: '4px 8px' }}
                            >
                              [Inspect →]
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

        {/* DRAWER (Investigation Panel) */}
        <div className={`drawer ${drawerOpen ? 'open' : ''}`} id="drawer">
          {selectedEdge && (
            <div className="drawer-inner">

              {/* ── SECTION 1: THE CLASH HEADER ── */}
              <div style={{
                padding: '18px 20px 14px',
                borderBottom: '1px solid #28323e',
                background: '#0d1117',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '9px',
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                    color: '#c6564a',
                    marginBottom: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}>
                    <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#c6564a', boxShadow: '0 0 6px rgba(198,86,74,0.8)' }}></span>
                    Conflict Investigation
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '11.5px',
                      color: '#e8eaed',
                      background: '#1c2430',
                      border: '1px solid #2e3d4e',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: '160px',
                    }} title={selectedEdge.source}>{selectedEdge.source}</span>
                    <span style={{ color: '#c6564a', fontSize: '14px', flexShrink: 0 }}>⟷</span>
                    <span style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: '11.5px',
                      color: '#c99a4a',
                      background: '#1c2430',
                      border: '1px solid #3a2e1a',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: '160px',
                    }} title={selectedEdge.target}>{selectedEdge.target}</span>
                  </div>
                  <div style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '10px',
                    color: '#586170',
                    marginTop: '8px'
                  }}>
                    {conflicts.length} confirmed contradiction{conflicts.length !== 1 ? 's' : ''} detected
                  </div>
                </div>
                <button className="drawer-close" onClick={closeDrawer} style={{ flexShrink: 0, marginLeft: '8px' }}>×</button>
              </div>

              {/* ── BODY: SCROLLABLE CONFLICT CARDS ── */}
              <div className="drawer-body custom-scrollbar">
                {conflicts.length === 0 ? (
                  <div style={{ color: '#8b95a1', fontSize: '12px', textAlign: 'center', marginTop: '60px', fontFamily: "'IBM Plex Mono', monospace" }}>
                    <div style={{ fontSize: '24px', marginBottom: '12px', opacity: 0.3 }}>⧖</div>
                    Awaiting server telemetry...
                  </div>
                ) : (
                  conflicts.map((conflict, idx) => (
                    <ConflictCard
                      key={conflict.id ?? idx}
                      conflict={conflict}
                      idx={idx}
                      sourceDoc={selectedEdge.source}
                      targetDoc={selectedEdge.target}
                      onDismiss={(id) => setConflicts(prev => prev.filter(c => c.id !== id))}
                      onFlag={(id) => setConflicts(prev => prev.map(c => c.id === id ? { ...c, status: 'flagged' } : c))}
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