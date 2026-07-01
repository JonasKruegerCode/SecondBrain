#!/usr/bin/env bash

# Runs linting, type-checking, and tests for backend and frontend.
# Usage: ./check.sh [--no-tests]

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
FAILED=()
RUN_TESTS=true

for arg in "$@"; do
  [[ "$arg" == "--no-tests" ]] && RUN_TESTS=false
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() {
  local name="$1"; shift
  printf "\n${YELLOW}▶ %s${NC}\n" "$name"
  if "$@"; then
    printf "${GREEN}✓ %s${NC}\n" "$name"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗ %s${NC}\n" "$name"
    FAIL=$((FAIL + 1))
    FAILED+=("$name")
  fi
}

# ── Backend ──────────────────────────────────────────────────────────────────
printf "\n${BOLD}═══ Backend ═══${NC}\n"
cd "$ROOT/backend"

step "ruff"  poetry run ruff check src/ tests/
step "mypy"  poetry run mypy src/ tests/
$RUN_TESTS && step "pytest" poetry run pytest

# ── Frontend ─────────────────────────────────────────────────────────────────
printf "\n${BOLD}═══ Frontend ═══${NC}\n"
cd "$ROOT/frontend"

if [[ ! -d node_modules ]]; then
  printf "${YELLOW}⚙  node_modules missing — running npm install...${NC}\n"
  npm install
fi

step "tsc"        npx tsc --noEmit
step "vite build" npm run build

# ── Summary ───────────────────────────────────────────────────────────────────
printf "\n${BOLD}════════════════════════════════════${NC}\n"
if [[ $FAIL -eq 0 ]]; then
  printf "${GREEN}✓ All %d checks passed${NC}\n" "$PASS"
  exit 0
else
  printf "${RED}✗ %d of %d checks failed:${NC}\n" "$FAIL" "$((PASS + FAIL))"
  for s in "${FAILED[@]}"; do
    printf "  ${RED}• %s${NC}\n" "$s"
  done
  exit 1
fi
