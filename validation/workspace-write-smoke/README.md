# Workspace-write smoke

This non-Git directory reproduces the Codex CLI 0.144.4 Windows Code Mode path bug.

Expected result: RHZYCODE Desktop runs `prompt.md` with `workspace-write` and creates `proof.txt` containing `RHZYCODE_WORKSPACE_WRITE_OK`.

Current result: the session receives the correct cwd and writable root, but `apply_patch` and fallback writes are rejected as outside the project. RHZYCODE must not silently fall back to Full access.

Re-run after a Codex upgrade:

```powershell
node desktop\scripts\desktop-task-driver.mjs `
  --project validation\workspace-write-smoke `
  --prompt-file validation\workspace-write-smoke\prompt.md `
  --model sub2api/gpt-5.6-terra `
  --sandbox workspace-write `
  --timeout-minutes 10
```
