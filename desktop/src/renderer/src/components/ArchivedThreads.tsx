import { Archive, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "@rhzycode/protocol";
import { basename, getErrorMessage } from "../app-utils";
import { AppModal } from "./AppModal";

interface ArchivedThreadsProps {
  projectPath: string;
  onClose: () => void;
  onRestored: (thread: ThreadSummary, open: boolean) => void;
}

export function ArchivedThreads({ projectPath, onClose, onRestored }: ArchivedThreadsProps) {
  const [scope, setScope] = useState(projectPath);
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [revision, setRevision] = useState(0);
  const mutationPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setThreads([]);
    void window.rhzycode.listThreads({ archived: true, ...(scope ? { cwd: scope } : {}) })
      .then((items) => { if (!cancelled) setThreads(items); })
      .catch((cause) => { if (!cancelled) setError(getErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, revision]);

  async function restore(thread: ThreadSummary, open: boolean) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setRestoring(thread.id);
    setError("");
    setStatus("");
    try {
      await window.rhzycode.unarchiveThread(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setStatus(`Restored "${thread.title}".`);
      onRestored(thread, open);
    } catch (cause) {
      setError(`Restore failed: ${getErrorMessage(cause)}`);
    } finally {
      mutationPending.current = false;
      setRestoring(null);
    }
  }

  const query = search.trim().toLowerCase();
  const visible = threads.filter((thread) =>
    `${thread.title}\n${thread.projectPath}`.toLowerCase().includes(query));

  return (
    <AppModal title="Archived conversations" icon={<Archive size={18} />} className="archived-modal" onClose={onClose}>
      <div className="archived-toolbar">
        <select aria-label="Archived project" value={scope} disabled={restoring !== null} onChange={(event) => setScope(event.target.value)}>
          {projectPath && <option value={projectPath}>Current project: {basename(projectPath)}</option>}
          <option value="">All projects</option>
        </select>
        <button className="icon-button compact" aria-label="Refresh archived conversations" disabled={loading || restoring !== null} onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw size={15} className={loading ? "spinning" : ""} />
        </button>
      </div>
      <label className="thread-search">
        <Search size={13} />
        <input aria-label="Search archived conversations" placeholder="Search archived conversations" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      {error && <p className="archived-notice" role="alert">{error}</p>}
      {status && <p className="archived-notice" role="status">{status}</p>}
      {loading ? <p className="archived-notice" role="status">Loading archived conversations...</p> : (
        <div className="archived-list">
          {!error && visible.length === 0 && <p className="archived-notice">{query ? "No matching archived conversations" : "No archived conversations"}</p>}
          {visible.map((thread) => (
            <div className="archived-row" key={thread.id}>
              <div className="archived-details">
                <strong>{thread.title}</strong>
                <small title={thread.projectPath}>{thread.projectPath}</small>
                <small>{new Date(thread.updatedAt).toLocaleString()}</small>
              </div>
              <div className="archived-actions">
                <button disabled={restoring !== null} onClick={() => void restore(thread, false)}>
                  <RotateCcw size={13} />{restoring === thread.id ? "Restoring..." : "Restore"}
                </button>
                <button disabled={restoring !== null} onClick={() => void restore(thread, true)}>Restore and open</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppModal>
  );
}
