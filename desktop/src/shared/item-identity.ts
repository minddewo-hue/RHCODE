export function turnScopedItemId(turnId: unknown, itemId: unknown): string {
  const item = typeof itemId === "string" ? itemId : String(itemId || "");
  const turn = typeof turnId === "string" ? turnId : "";
  return turn && item ? `${turn}::${item}` : item;
}
