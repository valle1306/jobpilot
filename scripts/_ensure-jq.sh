#!/usr/bin/env bash
# Ensures jq is available. Installs it automatically if missing.
# Source this file at the top of any script: source "$(dirname "$0")/_ensure-jq.sh"

if command -v jq &>/dev/null; then
  return 0 2>/dev/null || exit 0
fi

echo "jq not found. Installing..." >&2

case "$(uname -s)" in
  Darwin)
    if command -v brew &>/dev/null; then
      brew install jq >&2
    else
      echo "Error: Homebrew not found. Install jq manually: https://jqlang.github.io/jq/download/" >&2
      exit 1
    fi
    ;;
  Linux)
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq jq >&2
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y jq >&2
    elif command -v yum &>/dev/null; then
      sudo yum install -y jq >&2
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm jq >&2
    elif command -v apk &>/dev/null; then
      apk add --no-cache jq >&2
    else
      echo "Error: No supported package manager found. Install jq manually: https://jqlang.github.io/jq/download/" >&2
      exit 1
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v winget &>/dev/null; then
      winget install jqlang.jq --accept-source-agreements --accept-package-agreements >&2
    elif command -v choco &>/dev/null; then
      choco install jq -y >&2
    elif command -v scoop &>/dev/null; then
      scoop install jq >&2
    else
      echo "Error: No supported package manager found (winget/choco/scoop). Install jq manually: https://jqlang.github.io/jq/download/" >&2
      exit 1
    fi
    ;;
  *)
    echo "Error: Unsupported OS. Install jq manually: https://jqlang.github.io/jq/download/" >&2
    exit 1
    ;;
esac

if ! command -v jq &>/dev/null; then
  echo "Error: jq installation failed. Install manually: https://jqlang.github.io/jq/download/" >&2
  exit 1
fi

echo "jq installed successfully." >&2
