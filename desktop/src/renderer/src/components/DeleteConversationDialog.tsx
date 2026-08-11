import { Trash2 } from "lucide-react";
import { AppModal } from "./AppModal";

interface DeleteConversationDialogProps {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConversationDialog({ title, onCancel, onConfirm }: DeleteConversationDialogProps) {
  return (
    <AppModal
      title="Delete conversation"
      icon={<Trash2 size={18} />}
      className="delete-confirmation-modal"
      onClose={onCancel}
    >
      <div className="delete-confirmation-body">
        <p>Permanently delete <strong>{title}</strong> and its data from this computer?</p>
        <p>This cannot be undone.</p>
      </div>
      <div className="modal-actions">
        <button className="secondary" autoFocus onClick={onCancel}>Cancel</button>
        <button className="danger" onClick={onConfirm}>
          <Trash2 size={14} /> Permanently delete conversation
        </button>
      </div>
    </AppModal>
  );
}
