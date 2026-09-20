import io
p = "src/renderer/src/app-utils.ts"
src = io.open(p, encoding="utf-8").read()

old = '''export function storedSelectedModel(): string {
  return localStorage.getItem("rhzycode.selectedModel") || "";
}
'''
new = '''export function storedSelectedModel(): string {
  return localStorage.getItem("rhzycode.selectedModel") || "";
}

export function storeSelectedModel(model: string): void {
  if (model) localStorage.setItem("rhzycode.selectedModel", model);
}

// "default" and "previous" are placeholders, not real model ids.
export function isUsableThreadModel(model: string | undefined): model is string {
  return Boolean(model) && model !== "default" && model !== "previous";
}
'''
assert old in src, "app-utils block not found"
src = src.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(src)
print("app-utils ok")
