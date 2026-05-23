import { useState } from 'react';
import { getClient } from '../useSessions';

const DEFAULT_CWD = '';

export function HireWorkerModal({ onClose }: { onClose: () => void }) {
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [prompt, setPrompt] = useState('list the files in this directory and tell me what this project is');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await getClient().hire({ cwd: cwd.trim(), prompt: prompt.trim() });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Hire a worker</h2>
        <label>working directory</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <label>first prompt</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        {err && <div style={{ color: '#ff8888', marginBottom: 8 }}>{err}</div>}
        <div className="row">
          <button onClick={onClose} disabled={busy}>
            CANCEL
          </button>
          <button onClick={onSubmit} disabled={busy || !cwd.trim() || !prompt.trim()}>
            {busy ? 'HIRING…' : 'HIRE'}
          </button>
        </div>
      </div>
    </div>
  );
}
