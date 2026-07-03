import React, { useState, useEffect, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import { API_BASE_URL } from './config';
import './App.css'; // Mandated: Must point to the CSS file provided above.

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  // Add this near your other useState declarations in App.jsx
  const [deepSearchPrompt, setDeepSearchPrompt] = useState(null);
  const [isDeepSearching, setIsDeepSearching] = useState(false);
  
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);

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

  // Structural physics: Recalculate canvas boundaries dynamically when panels shift
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
    
    // Slight delay to allow CSS transitions to finish before snapping D3 canvas
    const timer = setTimeout(updateDimensions, 300);
    return () => {
      window.removeEventListener('resize', updateDimensions);
      clearTimeout(timer);
    };
  }, [drawerOpen]);

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
            
            // Intercept backend signal for phased search
            if (res.data.requires_deep_search) {
                targetDocId = res.data.document_id;
            }
        }
        
        await loadWorkspace(); // Loads the local Delta to the sidebar
        
        if (targetDocId) {
            setDeepSearchPrompt(targetDocId); // Trigger UI Halt
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
        // Triggers the non-blocking FastAPI BackgroundTask
        await axios.post(`${API_BASE_URL}/api/graph/deep-search/${deepSearchPrompt}`);
        
        // Polling mock-up to refresh graph after background task finishes
        setTimeout(() => {
            loadWorkspace();
            setDeepSearchPrompt(null);
            setIsDeepSearching(false);
        }, 3000); 
    } catch (error) {
        console.error("Deep search failed to initiate.");
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
    setConflicts([]); // Clear previous state
    
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
    setTimeout(() => setSelectedEdge(null), 300); // Clear after animation completes
  };

  // Node drawing logic enforced to perfectly match the HTML SVG mockup
  const renderNode = (node, ctx, globalScale) => {
    const label = node.id;
    const fontSize = 11.5 / globalScale;
    
    // Calculate if node has any conflict links attached
    const hasConflict = graphData.links.some(l => 
      ((typeof l.source === 'object' ? l.source.id : l.source) === node.id || 
       (typeof l.target === 'object' ? l.target.id : l.target) === node.id) 
      && l.has_conflict
    );

    const strokeColor = hasConflict ? '#c6564a' : '#4c9a6d';

    ctx.beginPath();
    ctx.arc(node.x, node.y, 6, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#1c2430'; 
    ctx.fill();
    ctx.lineWidth = 1.5 / globalScale;
    ctx.strokeStyle = strokeColor;
    ctx.stroke();

    ctx.font = `${fontSize}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8eaed';
    ctx.fillText(label, node.x, node.y + 12);
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
        <button 
          onClick={() => setDeepSearchPrompt(null)} 
          className="btn" 
          disabled={isDeepSearching}
          style={{flex: 1, justifyContent: 'center'}}
        >
          Skip Full Audit
        </button>
        <button 
          onClick={executeDeepSearch} 
          className="btn primary" 
          disabled={isDeepSearching}
          style={{flex: 1, justifyContent: 'center', background: '#c99a4a', borderColor: '#c99a4a'}}
        >
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
              <div className="stat"><div className="stat-num">{documents.length}</div><div class="stat-label">Documents</div></div>
              <div className="stat conflict"><div className="stat-num">{graphData.links.filter(l => l.has_conflict).length}</div><div class="stat-label">Conflicts</div></div>
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

            <div className="sidebar-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8b95a1" strokeWidth="2">
                <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input type="text" placeholder="Filter documents…" />
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
                  // DICTATE: Extract object properties safely to prevent React from crashing
                  const docName = typeof doc === 'string' ? doc : doc.document_name;
                  const isActive = typeof doc === 'string' ? true : doc.is_active;

                  return (
                    <div key={idx} className="file-row" style={{ opacity: isActive ? 1 : 0.4 }}>
                      <span className={`health-dot ${isActive ? 'healthy' : 'warning'}`}></span>
                      <span className="file-icon">▤</span>
                      <div className="file-meta">
                        <div className="file-name">{docName}</div>
                        <div className="file-date mono">{isActive ? 'Active Node' : 'Archived Delta'}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* CANVAS */}
        <div className="canvas-wrap" ref={containerRef}>
          <div className="canvas-toolbar">
            <button className="btn">Graph view ▾</button>
          </div>
          <div className="canvas-toolbar-right">
            <button className="btn icon">⤢</button>
          </div>

          {!loading && (
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
          )}

          <div className="legend">
            <div className="legend-title">Edge legend</div>
            <div className="legend-row"><span className="legend-line" style={{background: '#4c9a6d'}}></span> Aligned / high similarity</div>
            <div className="legend-row"><span className="legend-line" style={{background: '#c99a4a'}}></span> Overlap, under review</div>
            <div className="legend-row"><span className="legend-line" style={{background: '#c6564a'}}></span> Contradiction detected</div>
          </div>
        </div>

        {/* DRAWER (Investigation Panel) */}
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