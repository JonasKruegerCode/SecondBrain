#!/bin/sh
# SecondBrain installer: one complete Docker Compose stack (frontend, REST, MCP,
# Neo4j and Qdrant). POSIX /bin/sh only, no bashisms.
#
#   curl -fsSL https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/install.sh | sh
#
# Optional environment:
#   SECOND_BRAIN_REF   Git ref to download the Compose files from (default: main)
#   SECOND_BRAIN_DIR   Install directory when no compose file is in the cwd
#   OPENROUTER_API_KEY Written into .env when it is empty (prompted otherwise)
set -eu
# Generated configuration and temporary replacements contain credentials.
umask 077

REPO="JonasKruegerCode/SecondBrain"
REF="${SECOND_BRAIN_REF:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

random_hex() {
  # 32 random bytes as 64 hex characters, without printing them elsewhere.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    return 0
  fi
  if command -v hexdump >/dev/null 2>&1; then
    hexdump -v -n32 -e '32/1 "%02x"' /dev/urandom
    return 0
  fi
  die "Cannot generate a random secret: install openssl, od or hexdump."
}

fetch() {
  # fetch <url> <destination>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "Neither curl nor wget is available to download the Compose files."
  fi
}

set_env_value() {
  # set_env_value <file> <key> <value>; replaces the key or appends it.
  _file="$1"
  _key="$2"
  _value="$3"
  _tmp="${_file}.tmp.$$"
  awk -v key="${_key}" -v val="${_value}" '
    substr($0, 1, length(key) + 1) == key "=" { print key "=" val; done = 1; next }
    { print }
    END { if (!done) print key "=" val }
  ' "${_file}" > "${_tmp}"
  mv "${_tmp}" "${_file}"
}

env_value_is_empty() {
  # True when the key is absent or its value is empty.
  grep -q "^$1=$" "$2" 2>/dev/null && return 0
  grep -q "^$1=" "$2" 2>/dev/null && return 1
  return 0
}

prompt_openrouter() {
  # Read one line from the controlling terminal, never from the piped stdin.
  # The subshell probe keeps a missing terminal quiet even under `set -e`.
  _prompted=""
  if ( : > /dev/tty ) 2>/dev/null; then
    printf '%s' "OpenRouter API key (optional, enables semantic search and chat; Enter to skip): " > /dev/tty
    IFS= read -r _prompted < /dev/tty || _prompted=""
    printf '\n' > /dev/tty
  fi
  if [ -n "${_prompted}" ]; then
    set_env_value "$1" OPENROUTER_API_KEY "${_prompted}"
  fi
}

command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Engine with Compose v2, then re-run this script."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose'). Update Docker or install the Compose plugin, then re-run this script."

# Use local files when they already exist; otherwise download into a directory.
if [ ! -f docker-compose.yml ]; then
  install_dir="${SECOND_BRAIN_DIR:-secondbrain}"
  mkdir -p "${install_dir}"
  cd "${install_dir}"
fi
[ -f docker-compose.yml ] || fetch "${RAW}/docker-compose.yml" docker-compose.yml
[ -f .env.example ] || fetch "${RAW}/.env.example" .env.example

if [ ! -f .env ]; then
  cp .env.example .env
  set_env_value .env SECOND_BRAIN_WIKI_API_KEY "$(random_hex)"
  set_env_value .env NEO4J_PASSWORD "$(random_hex)"
fi

if env_value_is_empty OPENROUTER_API_KEY .env; then
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    set_env_value .env OPENROUTER_API_KEY "${OPENROUTER_API_KEY}"
  else
    prompt_openrouter .env
  fi
fi

printf '%s\n' "Starting the SecondBrain stack (frontend, REST, MCP, Neo4j, Qdrant)..."
docker compose pull
docker compose up -d --wait

printf '\nSecondBrain is up.\n\n'
printf '  Directory:    %s\n' "$(pwd)"
printf '  Web app:      http://127.0.0.1:8080\n'
printf '  MCP endpoint: http://127.0.0.1:3001/mcp  (Bearer key in .env)\n'
cat <<'EOF'

Different host ports? Change WIKI_FRONTEND_PORT or WIKI_MCP_PORT in .env and
re-run 'docker compose up -d' in this directory.

Without an OpenRouter key, lexical search and the editor work. Chat and
semantic search stay off until a key is added to .env and the stack is
recreated. Indexes may still be building after the app is already usable.
EOF

