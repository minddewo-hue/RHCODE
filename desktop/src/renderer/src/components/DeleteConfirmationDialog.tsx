import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { AppModal } from "./AppModal";

interface DeleteConfirmationDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmationDialog({
  title,
  children,
  confirmLabel,
  onCancel,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  return (
    <AppModal
      title={title}
      icon={<Trash2 size={18} />}
      className="delete-confirmation-modal"
      onClose={onCancel}
    >
      <div className="delete-confirmation-body">{children}</div>
      <div className="modal-actions">
        <button className="danger" onClick={onConfirm}>
          <Trash2 size={14} /> {confirmLabel}
        </button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </AppModal>
  );
}
