import io
p = "src/renderer/src/App.tsx"
src = io.open(p, encoding="utf-8").read()

def rep(old, new, count=1):
    global src
    assert src.count(old) == count, f"expected {count} occurrence(s), found {src.count(old)}:\n{old[:120]}"
    src = src.replace(old, new)

# 1. imports
rep("""  isSameProjectPath,
  mergeActivityDeltas,""", """  isSameProjectPath,
  isUsableThreadModel,
  mergeActivityDeltas,""")
rep("""  storeLastThread,
  summarizePrompt,""", """  storeLastThread,
  storeSelectedModel,
  summarizePrompt,""")

# 2. modelsRef declaration
rep("""  const selectedModelRef = useRef(selectedModel);
  const preferredModelRef = useRef(selectedModel);""", """  const selectedModelRef = useRef(selectedModel);
  const preferredModelRef = useRef(selectedModel);
  const modelsRef = useRef<ModelOption[]>([]);""")

# 3. modelsRef sync effect
rep("""  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);
""", """  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    modelsRef.current = models;
  }, [models]);
""")

# 4. ensurePreferredModel -> storeSelectedModel
rep("""    if (nextModel) localStorage.setItem("rhzycode.selectedModel", nextModel);""",
    """    if (nextModel) storeSelectedModel(nextModel);""")

# 5. applyThreadModel / applyPreferredModel + hook into applyThreadDetail
rep("""  function applyThreadDetail(detail: ThreadDetail): void {""",
"""  // The model selector is bound to the open conversation: opening a thread
  // restores the model stored for that thread instead of the global default.
  function applyThreadModel(model: string): void {
    if (!isUsableThreadModel(model)) {
      applyPreferredModel();
      return;
    }
    const available = modelsRef.current;
    const resolved = available.some((entry) => entry.model === model)
      ? model
      : preferredModelFromCatalog(available, model) || model;
    preferredModelRef.current = resolved;
    selectedModelRef.current = resolved;
    setSelectedModel(resolved);
  }

  function applyPreferredModel(): void {
    const nextModel = ensurePreferredModel(modelsRef.current);
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
  }

  function applyThreadDetail(detail: ThreadDetail): void {""")

rep("""    setWorkspaceProject(detail.thread.projectPath);
    setWorkspaceThread(detail.thread.id);
    loadedThreadIdRef.current = detail.thread.id;""", """    setWorkspaceProject(detail.thread.projectPath);
    setWorkspaceThread(detail.thread.id);
    applyThreadModel(detail.thread.model);
    loadedThreadIdRef.current = detail.thread.id;""")

# 6. changeSelectedModel only mutates the open thread
rep("""  function changeSelectedModel(nextModel: string) {
    selectedModelRef.current = nextModel;
    preferredModelRef.current = nextModel;
    setSelectedModel(nextModel);
    localStorage.setItem("rhzycode.selectedModel", nextModel);
    const selectedThread = selectedThreadIdRef.current;
    if (!selectedThread) return;
    void window.rhzycode.setThreadModel(selectedThread, nextModel)""",
"""  // A manual selection updates the model of the open conversation only; with
  // no conversation open it records the default used for new tasks.
  function changeSelectedModel(nextModel: string) {
    const selectedThread = selectedThreadIdRef.current;
    preferredModelRef.current = nextModel;
    selectedModelRef.current = nextModel;
    setSelectedModel(nextModel);
    if (!selectedThread) {
      storeSelectedModel(nextModel);
      return;
    }
    void window.rhzycode.setThreadModel(selectedThread, nextModel)""")

# 7. keep the selector in sync when the selected thread's model changes remotely
rep("""    if (event.type === "thread.updated") {
      const active = isActiveThreadStatus(event.thread.status);
      markThreadActive(event.thread.id, active);
      setThreads((current) => {""",
"""    if (event.type === "thread.updated") {
      const active = isActiveThreadStatus(event.thread.status);
      markThreadActive(event.thread.id, active);
      if (selectedThreadIdRef.current === event.thread.id) applyThreadModel(event.thread.model);
      setThreads((current) => {""")

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("App.tsx ok")
