import { useState, useEffect } from 'react'

function App() {
  const [documents, setDocuments] = useState([]);
  const [sourceFile, setSourceFile] = useState("");
  const [targetFile, setTargetFile] = useState("");
  const [results, setResults] = useState([]);
  const [isAuditing, setIsAuditing] = useState(false);
  const [error, setError] = useState(null);

  // 1. Fetch the document registry on load
  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/documents")
      .then(res => res.json())
      .then(data => {
        if (data.status === "success") {
          setDocuments(data.documents);
        }
      })
      .catch(err => console.error("Failed to connect to backend API:", err));
  }, []);

  // 2. Trigger the AI Comparison Engine
  const handleRunAudit = async () => {
    if (!sourceFile || !targetFile) {
      setError("Please select both a Source and Target document.");
      return;
    }
    
    setError(null);
    setIsAuditing(true);
    setResults([]);

    try {
      const response = await fetch("http://127.0.0.1:8000/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_file: sourceFile,
          target_file: targetFile
        })
      });
      
      const data = await response.json();
      if (data.status === "success") {
        setResults(data.conflicts);
      } else {
        setError("Audit Engine Error: " + data.detail);
      }
    } catch (err) {
      setError("Failed to reach the Semantic Engine. Is the FastAPI server running?");
    } finally {
      setIsAuditing(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 p-8 font-sans">
      <header className="mb-10 border-b border-slate-700 pb-6">
        <h1 className="text-3xl font-bold tracking-tight text-blue-400">
          Semantic Compliance Engine
        </h1>
        <p className="text-slate-400 mt-2">Intelligent Multi-Source Knowledge Auditing Pipeline</p>
      </header>

      {/* Control Panel */}
      <div className="bg-slate-800 p-6 rounded-lg border border-slate-700 mb-8 flex items-end gap-6 shadow-xl">
        <div className="flex-1">
          <label className="block text-sm font-medium text-slate-300 mb-2">Version 1 (Original Policy)</label>
          <select 
            className="w-full bg-slate-900 border border-slate-600 rounded-md p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={sourceFile}
            onChange={(e) => setSourceFile(e.target.value)}
          >
            <option value="">-- Select Document --</option>
            {documents.map(doc => (
              <option key={`src-${doc}`} value={doc}>{doc}</option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="block text-sm font-medium text-slate-300 mb-2">Version 2 (Updated Policy)</label>
          <select 
            className="w-full bg-slate-900 border border-slate-600 rounded-md p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            value={targetFile}
            onChange={(e) => setTargetFile(e.target.value)}
          >
            <option value="">-- Select Document --</option>
            {documents.map(doc => (
              <option key={`tgt-${doc}`} value={doc}>{doc}</option>
            ))}
          </select>
        </div>

        <button 
          onClick={handleRunAudit}
          disabled={isAuditing}
          className="bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 px-8 rounded-md transition-all disabled:opacity-50 h-[50px]"
        >
          {isAuditing ? "Processing Vectors..." : "Run Audit"}
        </button>
      </div>

      {error && <div className="bg-red-900/50 border border-red-500 text-red-200 p-4 rounded-md mb-8">{error}</div>}

      {/* Results Viewport */}
      {results.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
            <span className="bg-red-500 text-white text-xs px-2 py-1 rounded-full">{results.length}</span>
            Compliance Contradictions Detected
          </h2>
          
          <div className="flex flex-col gap-6">
            {results.map((conflict, idx) => (
              <div key={idx} className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden shadow-lg">
                <div className="bg-slate-900/50 px-4 py-2 border-b border-slate-700 text-xs font-mono text-slate-400 flex justify-between">
                  <span>Conflict #{idx + 1}</span>
                  <span>Drift Score: {conflict.drift_score.toFixed(4)}</span>
                </div>
                
                {/* The Split-Screen Diff Viewer */}
                <div className="grid grid-cols-2 divide-x divide-slate-700">
                  <div className="p-6">
                    <h3 className="text-xs uppercase text-slate-500 font-bold mb-3 tracking-wider">Original Text</h3>
                    <p className="text-sm leading-relaxed text-red-300 bg-red-950/30 p-3 rounded border border-red-900/50">
                      {conflict.original_text}
                    </p>
                  </div>
                  <div className="p-6">
                    <h3 className="text-xs uppercase text-slate-500 font-bold mb-3 tracking-wider">Altered Text</h3>
                    <p className="text-sm leading-relaxed text-green-300 bg-green-950/30 p-3 rounded border border-green-900/50">
                      {conflict.altered_text}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Zero Conflicts State */}
      {results.length === 0 && !isAuditing && !error && sourceFile && targetFile && (
        <div className="text-center py-20 border border-dashed border-slate-700 rounded-lg bg-slate-800/50">
          <p className="text-slate-400">Run an audit to cross-reference document vectors.</p>
        </div>
      )}
    </div>
  )
}

export default App