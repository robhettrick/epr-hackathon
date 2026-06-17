# Spot the Anomaly — Ralph project (START HERE)

This folder **is** the Ralph project for Brief 2. It's pre-set-up: `CLAUDE.md` guardrails at the
root and the specs in `specs/`. You install/run Ralph on your Mac and point it at this folder.

## Layout (what Ralph consumes)
```
CLAUDE.md                     ← build guardrails, read every iteration (project-specific)
specs/
  prd-brief-2-spot-the-anomaly.md   ← the PRD / what to build (golden path = §4)
  architecture-and-adrs.md          ← Hapi + Postgres decisions & constraints
docs/                         ← reference context (NOT scope): scenarios, research, field maps
fixtures/  reference/          ← data to build against (generate if absent — PRD §9)
# ralph init will add: IMPLEMENTATION_PLAN.md, PROGRESS.md, .claude/skills/commit/
```

---

## TONIGHT — pre-flight (prove the loop once)

```bash
# 1. Prereqs
claude --version
docker info | head -n 5                 # Docker Desktop is smoothest on macOS
npm install -g @devcontainers/cli

# 2. Install Ralph
git clone https://github.com/marc0der/ralph.git ~/code/ralph
cd ~/code/ralph && ./install.sh
export PATH="$HOME/.local/bin:$PATH"
ralph version

# 3. Build the sandbox image once (slow — do it tonight)
mkdir -p ~/code/ralph-smoketest && cd ~/code/ralph-smoketest && git init
SSH_AUTH_SOCK="" ralph sandbox --rebuild        # then `exit` the shell
```

> **Two confirmed macOS gotchas (already hit, fixes baked in):**
> 1. `ralph sandbox` fails mounting the SSH-agent socket → **always prefix `SSH_AUTH_SOCK=""`**.
>    SSH *push* from the sandbox won't work; don't push, use HTTPS, or the forwarded `gh` token.
> 2. A brand-new repo has no `HEAD` → `plan`/`build` fail with *"ambiguous argument 'HEAD'"*.
>    **Make an initial commit right after `ralph init`.**

Smoke test (inside the sandbox shell):
```bash
cd /workspace && ralph init
echo "Build a hello-world Node HTTP server on port 3000." > specs/hello.md
git add -A && git commit -m "chore: initial commit"
ralph plan -g "hello world server" && ralph build -n 1 --skip-push
```
A `PROGRESS.md` entry + a commit = you're ready.

---

## TOMORROW — run the build in THIS folder

```bash
cd ~/Documents/.../epr-hackathon        # this project folder
git init                                # if not already a repo
ralph init                              # skips existing specs/ and CLAUDE.md
git add -A && git commit -m "chore: bootstrap spot-the-anomaly"   # REQUIRED (Ralph needs HEAD)

SSH_AUTH_SOCK="" ralph sandbox          # enter the devcontainer (cd /workspace inside)

# plan once, then build in short bursts
ralph plan -g "Ingest EPR packaging-waste submissions, fan out to a registry of anomaly detectors, and produce per-detector scored, triaged lists for a regulator"
ralph build -n 5 --skip-push            # review PROGRESS.md, repeat
ralph build -n 5 --skip-push
```

Rules that keep you out of trouble:
- **Short bursts** (`-n 3`–`5`), review `PROGRESS.md` between runs. Never unleash the default 50.
- **Golden path is sacred** — get PRD §4 working end-to-end before any extra detector.
- **Build only the ★ detectors first** (PRD §6). Everything else is "later" in the plan.
- **Cheaper grind:** `ralph build -n 5 -m sonnet`; use `-m opus` for `plan`.
- If it drifts, edit `specs/` or `IMPLEMENTATION_PLAN.md` and re-run.

**15:15** rehearse + record a screen-capture backup. **15:30** demo the golden path (PRD §10),
never open settings.

## Before you build: data
The build needs `fixtures/` (≥2 operator submissions sharing suppliers/customers/vehicles + a
prior-year slice) and `reference/allowed-codes.json` (from the template's `Sheet1`). If they're
not here yet, generate them first — see PRD §9. (Rob's assistant can produce these.)

## Quick reference
| Command | Does |
| --- | --- |
| `ralph init` | Scaffold `IMPLEMENTATION_PLAN.md`, `PROGRESS.md` (skips existing specs/) |
| `ralph plan -g "goal"` | Analyse `specs/` + code, write the plan |
| `ralph build -n 5 --skip-push` | 5 iterations: implement → test → commit |
| `SSH_AUTH_SOCK="" ralph sandbox` | Enter the devcontainer shell |
| `ralph archive` / `ralph clean` | Park / delete loop artifacts before a new goal |
