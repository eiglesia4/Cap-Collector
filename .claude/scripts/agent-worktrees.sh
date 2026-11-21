#!/usr/bin/env bash
# One persistent worktree per dev agent (decided 2026-11-20, CAP-70): ../capcollector-wt/<agent>. The integrator
# works in the main checkout itself (on `main`), as in Edu's other projects. Run from the main checkout. Idempotent: creates the missing agent worktrees (detached on origin/main),
# gives each its own .envrc.local with CAP_AGENT set, runs npm ci, and removes the old per-story worktrees
# (../capcollector-wt/CAP-*, integrate-*) when they are clean and pushed. Never deletes work: anything dirty
# or unpushed is reported and left in place.
set -euo pipefail

AGENTS=(dev-app dev-api dev-infra)
root="$(git rev-parse --show-toplevel)"
wt_base="$(cd "$root/.." && pwd)/capcollector-wt"
cd "$root"

# Sets `export CAP_AGENT="<agent>"` in an .envrc.local: replaces the line, or appends it when missing.
set_agent() {
  local file="$1" agent="$2"
  if grep -qE '^export CAP_AGENT=' "$file"; then
    sed -i.bak -E "s/^export CAP_AGENT=.*/export CAP_AGENT=\"$agent\"/" "$file" && rm -f "$file.bak"
  else
    printf '\nexport CAP_AGENT="%s"\n' "$agent" >> "$file"
  fi
  echo "      $(basename "$(dirname "$file")")/.envrc.local: CAP_AGENT=$agent"
}

git fetch --prune origin
mkdir -p "$wt_base"

# .project_name is local (gitignored, Edu 2026-11-21; Warp and claude-agent read it): `CAP` unless already set.
PROJECT_NAME_DEFAULT="CAP"
ensure_project_name() {
  local dir="$1" src="$root/.project_name"
  [[ -f "$dir/.project_name" ]] && return 0
  if [[ -f "$src" ]]; then cp "$src" "$dir/.project_name"; else printf '%s\n' "$PROJECT_NAME_DEFAULT" > "$dir/.project_name"; fi
  echo "      $(basename "$dir")/.project_name: $(cat "$dir/.project_name")"
}

# 0. The main checkout belongs to the integrator.
ensure_project_name "$root"
if [[ ! -f "$root/.envrc.local" ]]; then cp "$root/.envrc.local.example" "$root/.envrc.local"; chmod 600 "$root/.envrc.local"; fi
set_agent "$root/.envrc.local" integrator

# 1. Old per-story worktrees → removed when clean and pushed.
git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r dir; do
  name="$(basename "$dir")"
  [[ "$dir" == "$wt_base"/* ]] || continue
  [[ " ${AGENTS[*]} " == *" $name "* ]] && continue
  if [[ ! -d "$dir" ]]; then continue; fi
  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
    echo "KEEP  $dir — uncommitted changes (run /handoff there, then rerun)"; continue
  fi
  branch="$(git -C "$dir" symbolic-ref --quiet --short HEAD || true)"
  if [[ -n "$branch" ]] && ! git -C "$dir" rev-parse --verify --quiet "origin/$branch" >/dev/null; then
    echo "KEEP  $dir — branch $branch not on origin (push it, then rerun)"; continue
  fi
  if [[ -n "$branch" ]] && [[ -n "$(git -C "$dir" log --oneline "origin/$branch..HEAD")" ]]; then
    echo "KEEP  $dir — unpushed commits on $branch"; continue
  fi
  git worktree remove "$dir" && echo "REMOVED $dir"
done
git worktree prune

# 2. One worktree per agent.
for agent in "${AGENTS[@]}"; do
  dir="$wt_base/$agent"
  if [[ -d "$dir" ]]; then
    echo "OK    $dir (exists)"
  else
    git worktree add --detach "$dir" origin/main
    echo "ADDED $dir"
  fi
  if [[ ! -f "$dir/.envrc.local" ]]; then
    src="$root/.envrc.local"; [[ -f "$src" ]] || src="$root/.envrc.local.example"
    cp "$src" "$dir/.envrc.local"
    chmod 600 "$dir/.envrc.local"
  fi
  set_agent "$dir/.envrc.local" "$agent"
  ensure_project_name "$dir"
  if command -v direnv >/dev/null; then (cd "$dir" && direnv allow . >/dev/null); fi
  if [[ ! -d "$dir/node_modules" ]]; then (cd "$dir" && npm ci --silent) && echo "      npm ci done"; fi
done

echo
git worktree list
echo
echo "Start any agent with the claude-agent shell function (CLAUDE.md § Configuración):"
echo "  cd $root && claude-agent                 → $(cat "$root/.project_name")_integrator"
echo "  cd $wt_base/<agent> && claude-agent      → $(cat "$root/.project_name")_<agent>"
