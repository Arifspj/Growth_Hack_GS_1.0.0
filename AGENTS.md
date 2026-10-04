# AGENTS.md — Growth Hack GS AI

Automation rules for any code change in this repo.

## Mandatory workflow (every code change)

1. **Version bump always**
   - Every code update that changes behavior MUST bump `version` in
     `extension/manifest.json`.
   - Bump the patch by +1 (e.g. `1.4.0` → `1.4.1`). No bump = no commit.
   - Commit message MUST start with the new version tag, e.g.
     `v1.4.1: <short description>`.

2. **Commit**
   - Stage only the files relevant to the change.
   - Author identity is always:
     `git -c user.name="Arifspj" -c user.email="Arifspj@users.noreply.github.com"`
   - Message convention:
     `vX.Y.Z: <imperative summary of the change>`

3. **Git push always**
   - After committing, MUST push to the remote (`main`):
     `git push origin main` (with the same `-c` identity flags).
   - Push is part of the definition of "done" — never leave a commit unpushed.

## Test / verify after a change

- Reload the extension at `chrome://extensions` and refresh the target sheet tab.
- Run the affected feature (Scrape / Details / AI Research) and confirm the log.
- If a run hangs or a row fails, capture the extension log + provider-tab state.

## Repo facts

- Remote: `https://github.com/Arifspj/Growth_Hack_GS_1.0.0.git`, branch `main`.
- Extension dir: `extension/` (MV3 service worker = `background.js`).
- Default spreadsheet id and auth live in `extension` code (Sheets API v4).
- AI research writes column order = `AI_COLUMNS` in `background.js`
  (Summary → Linked Companies → Big Orders → Catalysts → Risks → Sector).
- Uncommitted pending changes MUST NOT be overwritten by a new fetch/rebase
  without checking `git status` first.