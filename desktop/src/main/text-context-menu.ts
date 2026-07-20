import type { MenuItemConstructorOptions } from "electron";

export interface TextContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
  };
}

export function buildTextContextMenu(
  params: TextContextMenuParams,
): MenuItemConstructorOptions[] {
  const hasSelection = params.selectionText.length > 0;
  const items: MenuItemConstructorOptions[] = [];

  if (params.isEditable) {
    items.push(
      { label: "剪切", role: "cut", enabled: Boolean(params.editFlags.canCut) },
      {
        label: "复制",
        role: "copy",
        enabled: Boolean(params.editFlags.canCopy) || hasSelection,
      },
      { label: "粘贴", role: "paste", enabled: Boolean(params.editFlags.canPaste) },
    );
  } else {
    items.push({ label: "复制", role: "copy", enabled: hasSelection });
  }

  items.push(
    { type: "separator" },
    { label: "全选", role: "selectAll", enabled: true },
  );
  return items;
}
