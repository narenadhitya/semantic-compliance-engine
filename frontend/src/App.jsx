import React, { useState, useEffect, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import { API_BASE_URL } from './config';
import './App.css';

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
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
      const [docRes, graphRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/documents`),
        axios.get(`${API_BASE_URL}/api/graph`)
      ]);

      const nextGraph = graphRes.data?.data ?? graphRes.data ?? { nodes: [], links: [] };
      setDocuments(Array.isArray(docRes.data?.documents) ? docRes.data.documents : []);
      setGraphData({
        nodes: Array.isArray(nextGraph.nodes) ? nextGraph.nodes : [],
        links: Array.isArray(nextGraph.links) ? nextGraph.links : []
      });
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

  const handleLinkClick = async (link) => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    
    setSelectedEdge({ source: sourceId, target: targetId });
    setDrawerOpen(true);
    setConflicts([]); 
    
    try {
      const res = await axios.get(`${API_BASE_URL}/api/investigate`, {
        params: { source: sourceId, target: targetId }
      });
      setConflicts(Array.isArray(res.data?.conflicts) ? res.data.conflicts : []);
    } catch (error) {
      console.error("Failed to retrieve conflict vectors:", error);
    }
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

  // INBOX LOGIC: Filter links based on search query
  const filteredInboxLinks = graphData.links.filter(link => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    const searchLower = searchQuery.toLowerCase();
    return sourceId.toLowerCase().includes(searchLower) || targetId.toLowerCase().includes(searchLower);
  }).sort((a, b) => {
    // Sort logic: Conflicts bubble to the top
    if (a.has_conflict && !b.has_conflict) return -1;
    if (!a.has_conflict && b.has_conflict) return 1;
    return 0;
  });

  const handleToggleRow = (idx) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(idx)) newSelected.delete(idx);
    else newSelected.add(idx);
    setSelectedRows(newSelected);
  };

  const handleToggleAll = () => {
    if (selectedRows.size === filteredInboxLinks.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(filteredInboxLinks.map((_, i) => i)));
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
              <div className="stat conflict"><div className="stat-num">{graphData.links.filter(l => l.has_conflict).length}</div><div className="stat-label">Conflicts</div></div>
              <div className="stat warning"><div className="stat-num">0</div><div className="stat-label">Review</div></div>
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
              <div className="file-group-label">Active Registry</div>
              {documents.length === 0 ? (
                <div style={{padding: '10px 8px', fontSize: '11px', color: '#586170', fontStyle: 'italic'}}>No infrastructure mapped.</div>
              ) : (
                documents.map((doc, idx) => {
                  const docName = typeof doc === 'string' ? doc : doc.document_name;
                  const isActive = typeof doc === 'string' ? true : doc.is_active;

                  return (
                    <div key={idx} className="file-row" style={{ opacity: isActive ? 1 : 0.4, position: 'relative' }}>
                      <span className={`health-dot ${isActive ? 'healthy' : 'warning'}`}></span>
                      <span className="file-icon">▤</span>
                      <div className="file-meta" style={{ flex: 1, minWidth: 0 }}>
                        <div className="file-name">{docName}</div>
                        <div className="file-date mono">{isActive ? 'Active Node' : 'Archived Delta'}</div>
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
                                transition: 'background 0.15s', marginBottom: '2px'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(198, 86, 74, 0.1)'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                              Destroy File
                            </div>
                            
                            <div 
                              onClick={(e) => { e.stopPropagation(); setActiveMenu(null); }}
                              style={{
                                padding: '8px 10px', fontSize: '11px', color: '#8b95a1', cursor: 'pointer', 
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px',
                                transition: 'background 0.15s'
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#212b38'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="5" rx="2" ry="2"></rect><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"></path><line x1="10" y1="13" x2="14" y2="13"></line></svg>
                              Archive Record
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
                {/* Inbox Toolbar Stubs */}
                <div style={{ padding: '0 20px 15px 20px', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <div className="sidebar-search" style={{ margin: 0, flex: 1, maxWidth: '400px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
                    <input 
                      type="text" 
                      placeholder="Filter pairs (e.g., GDPR)..." 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <button className="btn" style={{ fontSize: '11px' }}>Status: All ▾</button>
                  <button className="btn" style={{ fontSize: '11px' }}>Severity: Any ▾</button>
                  <button className="btn" style={{ fontSize: '11px' }}>Department: Any ▾</button>
                  <div style={{ flex: 1 }}></div>
                  {selectedRows.size > 0 && (
                    <button className="btn" style={{ fontSize: '11px', color: '#c6564a', borderColor: 'rgba(198,86,74,0.3)' }}>Bulk Dismiss ({selectedRows.size})</button>
                  )}
                </div>

                {/* Inbox Table Header */}
                <div style={{ display: 'flex', padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.5px' }} className="mono">
                  <div style={{ width: '40px' }}>
                    <input type="checkbox" onChange={handleToggleAll} checked={selectedRows.size === filteredInboxLinks.length && filteredInboxLinks.length > 0} />
                  </div>
                  <div style={{ width: '80px' }}>Severity</div>
                  <div style={{ flex: 1 }}>Semantic Relationship Pair</div>
                  <div style={{ width: '120px' }}>Recency</div>
                  <div style={{ width: '100px', textAlign: 'right' }}>Action</div>
                </div>

                {/* Inbox Table Body (Virtualized scrolling placeholder via overflow) */}
                <div style={{ flex: 1, overflowY: 'auto' }} className="custom-scrollbar">
                  {filteredInboxLinks.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '50px', color: 'var(--text-faint)', fontSize: '13px' }}>
                      No compliance pairs match your filter.
                    </div>
                  ) : (
                    filteredInboxLinks.map((link, idx) => {
                      const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
                      const targetId = typeof link.target === 'object' ? link.target.id : link.target;
                      const isSelected = selectedRows.has(idx);

                      return (
                        <div 
                          key={idx} 
                          style={{ 
                            display: 'flex', alignItems: 'center', padding: '12px 20px', 
                            borderBottom: '1px solid var(--border)', 
                            background: isSelected ? 'rgba(111,168,201,0.05)' : 'transparent',
                            transition: 'background 0.15s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = isSelected ? 'rgba(111,168,201,0.08)' : 'var(--surface-2)'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = isSelected ? 'rgba(111,168,201,0.05)' : 'transparent'}
                        >
                          {/* Checkbox */}
                          <div style={{ width: '40px' }}>
                            <input type="checkbox" checked={isSelected} onChange={() => handleToggleRow(idx)} />
                          </div>

                          {/* Severity Indicator */}
                          <div style={{ width: '80px', display: 'flex', alignItems: 'center', gap: '6px' }} className="mono">
                            {link.has_conflict ? (
                               <><span style={{ color: '#c6564a', fontSize: '14px' }}>🔴</span> <span style={{ color: '#c6564a', fontSize: '11px' }}>High</span></>
                            ) : (
                               <><span style={{ color: '#4c9a6d', fontSize: '14px' }}>🟢</span> <span style={{ color: '#4c9a6d', fontSize: '11px' }}>Aligned</span></>
                            )}
                          </div>

                          {/* Relationship Text */}
                          <div style={{ flex: 1, fontSize: '13px', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} className="mono">
                            {sourceId} <span style={{ color: 'var(--text-faint)', margin: '0 8px' }}>⟷</span> {targetId}
                          </div>

                          {/* Mock Recency */}
                          <div style={{ width: '120px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                            {link.has_conflict ? '2 days ago' : '1 wk ago'}
                          </div>

                          {/* Action Button */}
                          <div style={{ width: '100px', textAlign: 'right' }}>
                            <button 
                              onClick={() => handleLinkClick(link)}
                              className="btn" 
                              style={{ display: 'inline-flex', background: 'transparent', borderColor: 'var(--border)', fontSize: '11px', padding: '4px 8px' }}
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

        {/* DRAWER (Investigation Panel) - Operates for BOTH views */}
        <div className={`drawer ${drawerOpen ? 'open' : ''}`} id="drawer">
          {selectedEdge && (
            <div className="drawer-inner">
              <div className="drawer-header">
                <div style={{maxWidth: '90%'}}>
                  <div className="drawer-header-title mono" style={{fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    {selectedEdge.source} ⟷
                  </div>
                  <div className="drawer-header-title mono" style={{fontSize: '13px', color: '#c99a4a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    {selectedEdge.target}
                  </div>
                </div>
                <button className="drawer-close" onClick={closeDrawer}>×</button>
              </div>

              <div className="drawer-pager">
                <div className="drawer-pager-label">Conflicts: {conflicts.length}</div>
              </div>

              <div className="drawer-body">
                {conflicts.length === 0 ? (
                  <div style={{color: '#8b95a1', fontSize: '12px', textAlign: 'center', marginTop: '40px'}}>
                    Awaiting server telemetry...
                  </div>
                ) : (
                  conflicts.map((conflict, idx) => (
                    <div key={idx} className="conflict-card" style={{animationDelay: `${idx * 0.05}s`}}>
                      <div className="card-header">
                        <span className="mono" style={{fontSize: '11px', color: '#8b95a1'}}>Structural Contradiction</span>
                        <span className="severity-badge high">High</span>
                      </div>
                      
                      <div className="excerpt-block">
                        <div className="excerpt">
                          <div className="excerpt-doc">Base Logic</div>
                          <div className="excerpt-text">{conflict.source_text}</div>
                        </div>
                        <div className="excerpt">
                          <div className="excerpt-doc" style={{color: '#c6564a'}}>Contradicting Logic</div>
                          <div className="excerpt-text">{conflict.target_text}</div>
                        </div>
                      </div>

                      {conflict.llm_analysis && (
                        <div className="verdict-block">
                          <div className="verdict-label"><span className="verdict-dot"></span> AI Judge verdict</div>
                          <div className="verdict-line">{conflict.llm_analysis}</div>
                        </div>
                      )}

                      <div className="card-actions">
                        <button className="card-action">Mark reviewed</button>
                        <button className="card-action">Flag for legal</button>
                        <button className="card-action dismiss">Dismiss</button>
                      </div>
                    </div>
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