#!/bin/bash
#
# Initialize a fresh Hetzner box for distributed training.
#
# Usage:
#   ./scripts/init-hetzner.sh <ip>           # SSH as root to create iain user
#   ./scripts/init-hetzner.sh <ip> <user>    # SSH as <user> to create iain user
#
# What it does:
#   0. Creates 'iain' user with sudo + copies SSH keys
#   1. Installs system deps (node 22, python3, numpy, pnpm)
#   2. Creates /home/iain/code/chaos
#   3. Pushes the repo + model
#   4. Installs npm deps and builds
#   5. Verifies collection works (1 test game)
#
# Prerequisites:
#   - SSH key access to the box (id_ed25519_hetzner)
#   - Initial user must have root/sudo

set -euo pipefail

HOST=${1:?Usage: $0 <ip> [user]}
INIT_USER=${2:-root}
REMOTE_USER=iain
REMOTE_PATH=/home/iain/code/chaos
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)

run_as() {
  local user=$1 desc=$2 cmd=$3
  echo "[$HOST] $desc"
  ssh $SSH_OPTS "${user}@${HOST}" "$cmd"
}

run() {
  run_as "$INIT_USER" "$1" "$2"
}

echo "═══════════════════════════════════════════════"
echo "  Initializing Hetzner box: ${HOST}"
echo "═══════════════════════════════════════════════"
echo

# ── 0. Create iain user ─────────────────────────────────────────────────────

run_as "$INIT_USER" "creating iain user..." '
  set -e
  if id iain &>/dev/null; then
    echo "  user iain already exists"
  else
    useradd -m -s /bin/bash iain
    echo "  ✓ created user iain"
  fi

  # Copy SSH authorized keys so we can SSH as iain
  mkdir -p /home/iain/.ssh
  if [ -f /root/.ssh/authorized_keys ]; then
    cp /root/.ssh/authorized_keys /home/iain/.ssh/authorized_keys
  fi
  chown -R iain:iain /home/iain/.ssh
  chmod 700 /home/iain/.ssh
  chmod 600 /home/iain/.ssh/authorized_keys 2>/dev/null || true
  echo "  ✓ SSH keys copied"
'

# Copy the hetzner private key so workers can upload to coordinator
echo "[$HOST] copying SSH private key for inter-box communication..."
rsync -az -e "ssh ${SSH_OPTS}" \
  "$SSH_KEY" \
  "${INIT_USER}@${HOST}:/home/iain/.ssh/id_ed25519_hetzner"
rsync -az -e "ssh ${SSH_OPTS}" \
  "${SSH_KEY}.pub" \
  "${INIT_USER}@${HOST}:/home/iain/.ssh/id_ed25519_hetzner.pub" 2>/dev/null || true
run_as "$INIT_USER" "fixing key permissions..." '
  chown iain:iain /home/iain/.ssh/id_ed25519_hetzner*
  chmod 600 /home/iain/.ssh/id_ed25519_hetzner
'

# ── 1. System dependencies ───────────────────────────────────────────────────

run "installing system deps..." '
  set -e

  # Node.js (v20 LTS via nodesource)
  if ! command -v node &>/dev/null; then
    echo "  installing node..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    echo "  node already installed: $(node --version)"
  fi

  # pnpm
  if ! command -v pnpm &>/dev/null; then
    echo "  installing pnpm..."
    npm install -g pnpm
  else
    echo "  pnpm already installed: $(pnpm --version)"
  fi

  # Python3 + numpy (for training)
  if ! command -v python3 &>/dev/null; then
    echo "  installing python3..."
    apt-get update -qq
    apt-get install -y python3 python3-pip
  else
    echo "  python3 already installed: $(python3 --version)"
  fi

  if ! python3 -c "import numpy" 2>/dev/null; then
    echo "  installing numpy..."
    pip install --break-system-packages numpy || pip install numpy
  else
    echo "  numpy already installed"
  fi

  # Build essentials (for native node modules if needed)
  apt-get install -y -qq build-essential git 2>/dev/null || true
'

# ── 2. Create project directory ──────────────────────────────────────────────

run "creating project dir..." "mkdir -p ${REMOTE_PATH}"

