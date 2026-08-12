#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the June repository.
#
# Installs mise (the toolchain manager this repo pins in mise.toml), the
# repository-pinned Node.js and pnpm, and the project dependencies. Safe to run
# repeatedly and on a cached/partially-prepared filesystem.
set -euo pipefail

# 1. Install mise if it is not already present.
if ! command -v mise >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/mise" ]; then
  curl -fsSL https://mise.run | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# 2. Ensure mise-managed tools resolve in every future shell. Shims mode works
#    in non-interactive shells (the ones the agent runs commands in), and the
#    activation hook adds interactive niceties. Appended only once.
BASHRC="$HOME/.bashrc"
if ! grep -qF 'mise activate bash --shims' "$BASHRC" 2>/dev/null; then
  {
    echo ''
    echo '# mise: repository-pinned Node.js/pnpm (see mise.toml)'
    echo 'export PATH="$HOME/.local/bin:$PATH"'
    echo 'eval "$(mise activate bash --shims)"'
    echo 'eval "$(mise activate bash)"'
  } >>"$BASHRC"
fi

# 3. Install the pinned toolchain and project dependencies.
mise trust --yes
mise install
mise exec -- pnpm install --frozen-lockfile
