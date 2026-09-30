#!/usr/bin/env bash
# ============================================
# Database Migration Script
#
# Runs the migration framework for the ZKVote backend SQLite database.
# Supports up, down, status, and dry-run commands.
#
# Usage:
#   ./scripts/migrate-database.sh up          # Apply pending migrations
#   ./scripts/migrate-database.sh down        # Rollback last migration
#   ./scripts/migrate-database.sh down --all  # Rollback all migrations
#   ./scripts/migrate-database.sh status      # Show migration status
#   ./scripts/migrate-database.sh dry-run     # Preview pending migrations
#
# Environment:
#   BACKEND_DIR   Path to backend directory (default: ./backend)
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$PROJECT_ROOT/backend}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# HELP
# ============================================

show_help() {
    cat <<EOF
Database Migration Script for ZKVote

Usage: $(basename "$0") <command> [options]

Commands:
  up          Apply all pending migrations
  down        Rollback the last migration
  down --all  Rollback all migrations
  status      Show migration status table
  dry-run     Preview what would be applied without making changes
  help        Show this help message

Options:
  --target ID  Stop at a specific migration ID (for up/down)

Examples:
  $(basename "$0") up
  $(basename "$0") up --target 002
  $(basename "$0") down
  $(basename "$0") down --all
  $(basename "$0") status
  $(basename "$0") dry-run

Environment:
  BACKEND_DIR  Path to backend directory (default: $BACKEND_DIR)
EOF
}

# ============================================
# VALIDATION
# ============================================

if [ ! -d "$BACKEND_DIR" ]; then
    echo -e "${RED}Error: Backend directory not found: $BACKEND_DIR${NC}"
    echo "Set BACKEND_DIR environment variable or run from project root."
    exit 1
fi

if [ ! -f "$BACKEND_DIR/package.json" ]; then
    echo -e "${RED}Error: No package.json found in $BACKEND_DIR${NC}"
    exit 1
fi

# ============================================
# COMMAND DISPATCH
# ============================================

COMMAND="${1:-help}"
shift 2>/dev/null || true

case "$COMMAND" in
    up)
        echo -e "${YELLOW}Applying pending migrations...${NC}"
        cd "$BACKEND_DIR" && npx tsx src/services/migrate.ts up "$@"
        echo -e "${GREEN}Migration up complete.${NC}"
        ;;
    down)
        echo -e "${YELLOW}Rolling back migrations...${NC}"
        cd "$BACKEND_DIR" && npx tsx src/services/migrate.ts down "$@"
        echo -e "${GREEN}Migration down complete.${NC}"
        ;;
    status)
        echo -e "${YELLOW}Migration status:${NC}"
        cd "$BACKEND_DIR" && npx tsx src/services/migrate.ts status
        ;;
    dry-run)
        echo -e "${YELLOW}Dry run — no changes will be made.${NC}"
        cd "$BACKEND_DIR" && npx tsx src/services/migrate.ts dry-run
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}Unknown command: $COMMAND${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac