#!/usr/bin/env bash
# One persistent worktree per agent (decided 2026-11-20, CAP-70): ../capcollector-wt/<agent>.
# Run from Edu's main checkout. Idempotent: creates the missing agent worktrees (detached on origin/main),
# gives each its own .envrc.local with CAP_AGENT set, runs npm ci, and removes the old per-story worktrees
# (../capcollector-wt/CAP-*, integrate-*) when they are clean and pushed. Never deletes work: anything dirty
# or unpushed is reported and left in place.
set -euo pipefail

AGENTS=(integrator dev-app dev-api dev-infra)
root="$(git rev-parse --show-toplevel)"
wt_base="$(cd "$root/.." && pwd)/capcollector-wt"
cd "$root"

git fetch --prune origin
mkdir -p "$wt_base"

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
    sed -E "s/^export CAP_AGENT=.*/export CAP_AGENT=\"$agent\"/" "$src" > "$dir/.envrc.local"
    chmod 600 "$dir/.envrc.local"
    echo "      .envrc.local with CAP_AGENT=$agent"
  fi
  if command -v direnv >/dev/null; then (cd "$dir" && direnv allow . >/dev/null); fi
  if [[ ! -d "$dir/node_modules" ]]; then (cd "$dir" && npm ci --silent) && echo "      npm ci done"; fi
done

echo
git worktree list
echo
echo "Start an agent:  cd $wt_base/<agent> && claude      (then /integrate, /next, /revise)"
