import React, { useState, useEffect, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import { UploadCloud, FileText, AlertTriangle, CheckCircle, GitBranch, ShieldAlert } from 'lucide-react';
import { API_BASE_URL } from './config';

function App() {
  const [documents, setDocuments] = useState([]);
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 600 });

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
      console.error('System Boot Failure:', error);
      setDocuments([]);
      setGraphData({ nodes: [], links: [] });
    } finally {
      setLoading(false);
    }
  };

  // --- Boot Sequence: Fetch O(1) Pre-computed Data ---
  useEffect(() => {
    loadWorkspace();
  }, []);

  // --- Resize Listener for the Graph Canvas ---
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

    const resizeObserver = new ResizeObserver(updateDimensions);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener('resize', updateDimensions);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateDimensions);
    };
  }, [loading]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleRebuildGraph = async () => {
    try {
      setUploading(true);
      await axios.post(`${API_BASE_URL}/api/graph/rebuild`);
      await loadWorkspace();
    } catch (error) {
      console.error('Graph rebuild failure:', error);
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files || []);

    if (files.length === 0) {
      return;
    }

    setUploading(true);

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);

        await axios.post(`${API_BASE_URL}/api/upload`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
      }

      await loadWorkspace();
    } catch (error) {
      console.error('Upload pipeline failure:', error);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  // --- Interaction: Triggering the Split-Screen Audit ---
  const handleLinkClick = async (link) => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    
    setSelectedEdge({ source: sourceId, target: targetId });
    
    try {
      const res = await axios.get(`${API_BASE_URL}/api/investigate`, {
        params: {
          source: sourceId,
          target: targetId
        }
      });
      setConflicts(Array.isArray(res.data?.conflicts) ? res.data.conflicts : []);
    } catch (error) {
      console.error("Failed to retrieve conflict payload:", error);
      setConflicts([]);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-emerald-400 font-mono tracking-widest text-lg animate-pulse">
        INITIALIZING SEMANTIC COMPLIANCE ENGINE...
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-slate-950 text-slate-300 flex overflow-hidden font-sans selection:bg-emerald-500/30">
      
      {/* LEFT COLUMN: Data Management & Ingestion (25%) */}
      <div className="w-1/4 border-r border-slate-800 bg-slate-900 flex flex-col z-10 shadow-2xl">
        <div className="p-5 border-b border-slate-800">
          <h1 className="text-sm font-bold text-slate-100 tracking-widest uppercase flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-emerald-400" />
            Compliance Engine
          </h1>
          <p className="text-xs text-slate-500 mt-1 font-mono">v2.0.4 // Enterprise Scope</p>
          <p className="text-[10px] text-slate-600 mt-2 font-mono">
            {documents.length} documents · {graphData.links.length} edges
          </p>
        </div>

        {/* The Ingestion Dropzone */}
        <div className="p-4 border-b border-slate-800">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.pdf,.docx"
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            type="button"
            onClick={handleUploadClick}
            className="w-full border-2 border-dashed border-slate-700 hover:border-emerald-500/50 bg-slate-950/50 rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer transition-colors group text-left"
          >
            <UploadCloud className="w-8 h-8 text-slate-500 group-hover:text-emerald-400 transition-colors mb-2" />
            <span className="text-xs font-semibold text-slate-300">{uploading ? 'Processing documents...' : 'Upload documents'}</span>
            <span className="text-[10px] text-slate-500 mt-1 text-center">Select .txt, .pdf, or .docx files to rebuild the knowledge graph</span>
          </button>
          <button
            type="button"
            onClick={handleRebuildGraph}
            className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-slate-300 hover:border-emerald-500/60 hover:text-white transition-colors"
          >
            Rebuild Graph Links
          </button>
        </div>

        {/* File Version Timeline / Registry */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-[10px] font-bold text-slate-500 tracking-wider mb-3 uppercase">Active Document Registry</div>
          <div className="space-y-1">
            {documents.length === 0 ? (
              <div className="text-xs text-slate-600 font-mono italic">No policies indexed.</div>
            ) : (
              documents.map((doc, idx) => (
                <div key={idx} className="flex items-center justify-between p-2 hover:bg-slate-800 rounded cursor-pointer group">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <FileText className="w-4 h-4 text-slate-500 group-hover:text-blue-400 shrink-0" />
                    <span className="text-xs text-slate-300 truncate font-medium">{doc}</span>
                  </div>
                  <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0 opacity-50 group-hover:opacity-100" />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* CENTER COLUMN: The Knowledge Graph Canvas */}
      <div className="flex-1 flex flex-col relative bg-[#0a0f18]" ref={containerRef}>
        <div className="absolute top-4 left-4 z-10 bg-slate-900/80 backdrop-blur border border-slate-800 px-3 py-2 rounded shadow-lg pointer-events-none">
          <h2 className="text-xs font-bold text-slate-200 flex items-center gap-2 uppercase tracking-wide">
            <GitBranch className="w-3 h-3 text-blue-400" />
            Semantic Relationship Topology
          </h2>
          <p className="text-[10px] text-slate-500 mt-1">Select an edge (link) to audit contextual drift.</p>
          <p className="text-[10px] text-slate-500 mt-1">{graphData.nodes.length} nodes · {graphData.links.length} links loaded</p>
        </div>

        {/* The Force Graph Engine */}
        <ForceGraph2D
          width={Math.max(dimensions.width, 320)}
          height={Math.max(dimensions.height, 320)}
          graphData={graphData}
          nodeLabel="id"
          nodeColor={() => '#3b82f6'}
          nodeRelSize={6}
          linkColor={() => '#ef4444'}
          linkWidth={(link) => link.max_similarity > 0.9 ? 3 : 1}
          linkDirectionalParticles={2}
          linkDirectionalParticleSpeed={0.005}
          onLinkClick={handleLinkClick}
          backgroundColor="#0a0f18"
        />
      </div>

      {/* RIGHT COLUMN: The Split-Screen Audit Portal */}
      {selectedEdge && (
        <div className="w-[35%] border-l border-slate-800 bg-slate-900 flex flex-col shadow-[-10px_0_30px_rgba(0,0,0,0.5)] z-20">
          
          {/* Header */}
          <div className="p-4 border-b border-slate-800 bg-slate-950">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-amber-500 flex items-center gap-2 uppercase tracking-wide">
                <AlertTriangle className="w-4 h-4" />
                Active Audit Log
              </h2>
              <button 
                onClick={() => setSelectedEdge(null)}
                className="text-[10px] text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-800"
              >
                ESC
              </button>
            </div>
            <div className="mt-3 text-[10px] font-mono text-slate-400 bg-slate-900 p-2 rounded border border-slate-800">
              <span className="text-blue-400 truncate block">{selectedEdge.source}</span>
              <span className="text-slate-500 block my-1">↨ semantic conflict detected with ↨</span>
              <span className="text-amber-400 truncate block">{selectedEdge.target}</span>
            </div>
          </div>

          {/* Filtering row (Visual Placeholder for Bulk Toggles) */}
          <div className="flex border-b border-slate-800 text-[10px] uppercase font-bold tracking-wider">
            <button className="flex-1 py-2 text-white border-b-2 border-emerald-500 bg-slate-800">Flagged ({conflicts.length})</button>
            <button className="flex-1 py-2 text-slate-500 hover:text-slate-300">Cleared (0)</button>
          </div>

          {/* Conflict List */}
          <div className="flex-1 overflow-y-auto bg-slate-900 p-4 space-y-4">
            {conflicts.length === 0 ? (
              <div className="text-center text-slate-500 text-xs py-10 italic">
                Awaiting conflict payload from database...
              </div>
            ) : (
              conflicts.map((conflict, idx) => (
                <div key={idx} className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden shadow-md">
                  <div className="bg-slate-900 border-b border-slate-800 px-3 py-1.5 flex justify-between items-center">
                    <span className="text-[9px] text-slate-400 font-mono tracking-widest">DRIFT: {(conflict.drift_score * 100).toFixed(1)}%</span>
                  </div>
                  
                  {/* Split Screen Diff */}
                  <div className="p-3 text-xs leading-relaxed font-mono">
                    <div className="mb-2">
                      <span className="text-[9px] text-blue-500 font-bold tracking-wider uppercase block mb-1">Source Logic</span>
                      <div className="text-slate-300 bg-blue-950/20 p-2 rounded border border-blue-900/30">
                        {conflict.source_text}
                      </div>
                    </div>
                    <div>
                      <span className="text-[9px] text-amber-500 font-bold tracking-wider uppercase block mb-1">Contradicting Logic</span>
                      <div className="text-slate-300 bg-amber-950/20 p-2 rounded border border-amber-900/30">
                        {conflict.target_text}
                      </div>
                    </div>
                  </div>

                  {/* Resolution Bar */}
                  <div className="flex border-t border-slate-800">
                    <button className="flex-1 py-2 text-[10px] font-bold tracking-wider uppercase text-slate-400 hover:text-emerald-400 hover:bg-emerald-950/30 transition-colors">
                      Clear Flag
                    </button>
                    <div className="w-px bg-slate-800"></div>
                    <button className="flex-1 py-2 text-[10px] font-bold tracking-wider uppercase text-slate-400 hover:text-amber-400 hover:bg-amber-950/30 transition-colors">
                      Override Rule
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;