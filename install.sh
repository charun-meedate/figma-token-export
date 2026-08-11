#!/usr/bin/env bash
# Installs this repo's skills into a project (or the current user).
#
#   ./install.sh ~/dev/my-project                    all skills -> <project>/.claude/skills/
#   ./install.sh ~/dev/my-project --skill figma-rename   just one
#   ./install.sh ~/dev/my-project --link             symlink instead of copying
#   ./install.sh --global                            install into ~/.claude/skills/
#   ./install.sh --list                              show what this repo ships
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

available_skills() {
  find "$SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
}

[[ $# -eq 0 ]] && usage 1

LINK=false
TARGET_ROOT=""
SELECTED=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --link) LINK=true ;;
    --global) TARGET_ROOT="$HOME" ;;
    --list)
      echo "Skills in this repo:"
      available_skills | sed 's/^/  /'
      exit 0
      ;;
    --skill)
      [[ $# -ge 2 ]] || { echo "Error: --skill needs a name." >&2; exit 1; }
      SELECTED+=("$2")
      shift
      ;;
    -h|--help) usage 0 ;;
    -*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) TARGET_ROOT="$1" ;;
  esac
  shift
done

if [[ -z "$TARGET_ROOT" ]]; then
  echo "Error: pass a project directory, or --global." >&2
  usage 1
fi
if [[ ! -d "$TARGET_ROOT" ]]; then
  echo "Error: $TARGET_ROOT does not exist." >&2
  exit 1
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  while IFS= read -r name; do SELECTED+=("$name"); done < <(available_skills)
fi

DEST_DIR="$TARGET_ROOT/.claude/skills"
mkdir -p "$DEST_DIR"

for SKILL_NAME in "${SELECTED[@]}"; do
  SRC="$SKILLS_DIR/$SKILL_NAME"
  if [[ ! -d "$SRC" ]]; then
    echo "Error: no skill called \"$SKILL_NAME\" in $SKILLS_DIR. Available:" >&2
    available_skills | sed 's/^/  /' >&2
    exit 1
  fi

  DEST="$DEST_DIR/$SKILL_NAME"

  # Report what is being replaced before replacing it — an existing skill may
  # be a local edit someone has not pushed back to this repo yet.
  if [[ -e "$DEST" || -L "$DEST" ]]; then
    if [[ -L "$DEST" ]]; then
      echo "Replacing existing symlink: $DEST -> $(readlink "$DEST")"
    else
      echo "Replacing existing directory: $DEST"
      if command -v diff >/dev/null && ! diff -rq "$SRC" "$DEST" >/dev/null 2>&1; then
        echo "  Note: the installed copy differs from this repo. Differences:"
        diff -rq "$SRC" "$DEST" 2>/dev/null | sed 's/^/    /' || true
        printf "  Continue and overwrite? [y/N] "
        read -r reply
        [[ "$reply" =~ ^[Yy]$ ]] || { echo "Skipped $SKILL_NAME."; continue; }
      fi
    fi
    rm -rf "$DEST"
  fi

  if $LINK; then
    ln -s "$SRC" "$DEST"
    echo "Linked  $DEST -> $SRC"
  else
    cp -R "$SRC" "$DEST"
    echo "Copied  $SRC -> $DEST"
  fi
done

echo
echo "Installed: ${SELECTED[*]}"
cat <<EOF

Next:
  export tokens   cp "$DEST_DIR/figma-token-export/scripts/tokens.config.example.json" "$TARGET_ROOT/tokens.config.json"
  rename things   cp "$DEST_DIR/figma-rename/scripts/rename.config.example.json" "$TARGET_ROOT/rename.config.json"

Edit the file you copied, then ask for the job in Claude Code (or run
/figma-token-export, /figma-rename).
EOF
