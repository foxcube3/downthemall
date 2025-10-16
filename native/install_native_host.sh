#!/usr/bin/env bash
# Simple installer for the DownThemAll native messaging host (user-level, Linux)
# Usage:
#   sudo ./install_native_host.sh --system /usr/lib/downthemall/native_host.py
#   ./install_native_host.sh --user /home/you/path/to/native_host.py

set -euo pipefail
CMDNAME=$(basename "$0")
show_help(){
  cat <<EOF
$CMDNAME --user /path/to/native_host.py --ext-id <extension-id>

Installs a native messaging host manifest for Chrome/Chromium/Firefox at user level.
Options:
  --user PATH       Install to user directory (~/.config/google-chrome/NativeMessagingHosts or ~/.mozilla/native-messaging-hosts)
  --system PATH     Install to system directory (/etc/opt/chrome/native-messaging-hosts or /usr/lib/mozilla/native-messaging-hosts)
  --ext-id ID       Extension ID to allow (required)
  --name NAME       Manifest name (default: downthemall.native)
  --help            Show this help

Note: the script will try to detect appropriate host manifest directory for Chrome/Chromium and Firefox.
EOF
}

if [ "$#" -eq 0 ]; then
  show_help
  exit 1
fi

MODE="user"
HOST_PATH=""
EXT_ID=""
NAME="downthemall.native"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      MODE="user"
      HOST_PATH="$2"
      shift 2
      ;;
    --system)
      MODE="system"
      HOST_PATH="$2"
      shift 2
      ;;
    --ext-dir)
      EXT_DIR="$2"
      shift 2
      ;;
    --ext-id)
      EXT_ID="$2"
      shift 2
      ;;
    --name)
      NAME="$2"
      shift 2
      ;;
    --help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      show_help
      exit 2
      ;;
  esac
done

if [ -z "$HOST_PATH" ] || [ -z "$EXT_ID" ]; then
  # Try to auto-detect extension id from EXT_DIR if provided
  if [ -z "$EXT_ID" ] && [ -n "${EXT_DIR:-}" ] && [ -d "$EXT_DIR" ]; then
    # Try reading manifest.json 'browser_specific_settings.gecko.id' or for Chrome unpacked use the extension id directory name
    if [ -f "$EXT_DIR/manifest.json" ]; then
      # attempt to extract gecko id
      GID=$(python3 - <<PY
import json,sys
try:
    m=json.load(open(sys.argv[1]))
    bid=m.get('browser_specific_settings',{}).get('gecko',{}).get('id')
    if bid:
        print(bid)
except Exception:
    pass
PY
 "$EXT_DIR/manifest.json") || true
      if [ -n "$GID" ]; then
        EXT_ID="$GID"
      else
        # fallback: use the extension directory name (Chrome temporary id)
        EXT_ID=$(basename "$EXT_DIR")
      fi
    fi
  fi
  if [ -z "$HOST_PATH" ] || [ -z "$EXT_ID" ]; then
    echo "Missing required arguments"
  show_help
  exit 2
  fi
fi

HOST_PATH_ABS=$(readlink -f "$HOST_PATH")
if [ ! -x "$HOST_PATH_ABS" ]; then
  # try making it executable
  if [ -f "$HOST_PATH_ABS" ]; then
    chmod +x "$HOST_PATH_ABS" || true
  else
    echo "Host path not found: $HOST_PATH_ABS"
    exit 3
  fi
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE="$SCRIPT_DIR/manifest.template.json"
MANIFEST_JSON="$SCRIPT_DIR/${NAME}.json"

# create manifest from template
cat "$TEMPLATE" | sed "s|__ABSOLUTE_PATH_TO_NATIVE_HOST__|$HOST_PATH_ABS|g" | sed "s|__EXTENSION_ID__|$EXT_ID|g" > "$MANIFEST_JSON"

if [ "$MODE" = "user" ]; then
  # try Chrome/Chromium user dir first
  CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
  FIREFOX_DIR="$HOME/.mozilla/native-messaging-hosts"
  if [ -d "$CHROME_DIR" ] || mkdir -p "$CHROME_DIR" 2>/dev/null; then
    DEST="$CHROME_DIR/$NAME.json"
  elif [ -d "$CHROMIUM_DIR" ] || mkdir -p "$CHROMIUM_DIR" 2>/dev/null; then
    DEST="$CHROMIUM_DIR/$NAME.json"
  elif [ -d "$FIREFOX_DIR" ] || mkdir -p "$FIREFOX_DIR" 2>/dev/null; then
    DEST="$FIREFOX_DIR/$NAME.json"
  else
    echo "Could not determine user native messaging directory. Please copy $MANIFEST_JSON to your browser's native messaging hosts directory manually."
    exit 4
  fi
else
  # system-level - try common locations
  if [ -d "/etc/opt/chrome/native-messaging-hosts" ] || mkdir -p "/etc/opt/chrome/native-messaging-hosts" 2>/dev/null; then
    DEST="/etc/opt/chrome/native-messaging-hosts/$NAME.json"
  elif [ -d "/usr/lib/mozilla/native-messaging-hosts" ] || mkdir -p "/usr/lib/mozilla/native-messaging-hosts" 2>/dev/null; then
    DEST="/usr/lib/mozilla/native-messaging-hosts/$NAME.json"
  else
    echo "Could not determine system native messaging directory. Please copy $MANIFEST_JSON to your browser's native messaging hosts directory manually."
    exit 5
  fi
fi

cp "$MANIFEST_JSON" "$DEST"
chmod 644 "$DEST"

echo "Installed manifest to $DEST"
echo "Ensure the host executable is at: $HOST_PATH_ABS"
echo "Extension ID allowed in manifest: $EXT_ID"

echo "Done."
