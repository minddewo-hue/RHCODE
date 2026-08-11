import { X } from "lucide-react";
import type { ReactNode } from "react";

interface AppModalProps {
  title: string;
  icon: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

export function AppModal({ title, icon, className, onClose, children }: AppModalProps) {
  const titleId = `app-modal-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div className="app-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`app-modal ${className || ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="app-modal-header">
          <div>{icon}<h2 id={titleId}>{title}</h2></div>
          <button className="icon-button compact" title={`Close ${title}`} aria-label={`Close ${title}`} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="app-modal-body">{children}</div>
      </section>
    </div>
  );
}
