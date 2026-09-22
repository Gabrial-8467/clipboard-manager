#!/usr/bin/env bash
# Install clipman (GTK app) and the GNOME Shell clipboard-history extension.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

LIB_DIR="$HOME/.local/lib/clipboard-manager"
BIN_DIR="$HOME/.local/bin"
EXT_DIR="$DATA_HOME/gnome-shell/extensions/clipboard-history@local"
EXT_SRC="$PROJECT_DIR/gnome-extension"
AUTOSTART_DIR="$CONFIG_HOME/autostart"

OPT_INSTALL_EXT=1
OPT_INSTALL_APP=1
SHORTCUT=""
GUI=""

usage() {
    echo "Usage: $0 [--no-extension] [--no-app] [--shortcut '<Super>v'] [--gui]"
    echo ""
    echo "  --no-extension   skip the GNOME Shell extension"
    echo "  --no-app         skip the clipman GTK app + autostart"
    echo "  --shortcut X     register a GNOME global shortcut to toggle the app"
    echo "  --gui            run the app window after install (for testing)"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-extension) OPT_INSTALL_EXT=0 ;;
        --no-app) OPT_INSTALL_APP=0 ;;
        --shortcut) SHORTCUT="${2:-}"; shift ;;
        --gui) GUI=1 ;;
        -h|--help) usage ;;
        *) echo "unknown option: $1" >&2; usage ;;
    esac
    shift
done

if ! command -v python3 >/dev/null; then
    echo "python3 is required" >&2
    exit 1
fi

# ----------------------------------------------------------------------
# 1) GNOME Shell extension
# ----------------------------------------------------------------------
if [[ "$OPT_INSTALL_EXT" -eq 1 ]]; then
    echo ">> Installing GNOME extension -> $EXT_DIR"
    mkdir -p "$EXT_DIR"
    cp -r "$EXT_SRC"/. "$EXT_DIR"/
    if command -v glib-compile-schemas >/dev/null; then
        glib-compile-schemas "$EXT_DIR/schemas" || true
    fi
    UUID="clipboard-history@local"
    # Newly installed extensions are only discovered by the *running* shell on
    # restart, so also register ourselves as enabled up-front.
    if command -v gsettings >/dev/null; then
        enabled="$(gsettings get org.gnome.shell enabled-extensions)"
        case "$enabled" in
            *"$UUID"*) ;;
            *)
                current="$(gsettings get org.gnome.shell enabled-extensions)"
                if [[ "$current" == "@as []" ]]; then
                    current=""
                else
                    current="${current:1:-1}"
                fi
                gsettings set org.gnome.shell enabled-extensions \
                    "[${current:+$current, }'$UUID']" 2>/dev/null || true
                ;;
        esac
    fi
    if command -v gnome-extensions >/dev/null; then
        # Only needed if the shell was restarted already (no-op otherwise).
        gnome-extensions enable "$UUID" >/dev/null 2>&1 \
            || true
    else
        echo "  (gnome-extensions not found; enable via Extensions app)"
    fi
fi

# ----------------------------------------------------------------------
# 2) clipman GTK app + launcher + autostart
# ----------------------------------------------------------------------
if [[ "$OPT_INSTALL_APP" -eq 1 ]]; then
    echo ">> Installing clipman app -> $LIB_DIR"
    rm -rf "$LIB_DIR"
    mkdir -p "$LIB_DIR" "$BIN_DIR"
    cp -r "$PROJECT_DIR/app/clipman" "$LIB_DIR/clipman"
    rm -rf "$LIB_DIR/clipman/__pycache__"

    cat > "$BIN_DIR/clipman" <<'EOF'
#!/usr/bin/env python3
"""clipman launcher"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)) + "/../lib/clipboard-manager")
from clipman.cli import main

if __name__ == "__main__":
    sys.exit(main())
EOF
    chmod +x "$BIN_DIR/clipman"

    mkdir -p "$AUTOSTART_DIR"
    cat > "$AUTOSTART_DIR/clipboard-manager.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Clipboard History (clipman)
Comment=Clipboard history manager
Exec=$BIN_DIR/clipman hide
Terminal=false
X-GNOME-Autostart-enabled=true
EOF

    if command -v update-desktop-database >/dev/null; then
        update-desktop-database "$BIN_DIR" >/dev/null 2>&1 || true
    fi
    echo ">> clipman installed. Try: ${BIN_DIR}/clipman toggle"
fi

# ----------------------------------------------------------------------
# 3) optional global shortcut (GNOME custom keybinding)
# ----------------------------------------------------------------------
if [[ -n "$SHORTCUT" && "$OPT_INSTALL_APP" -eq 1 ]]; then
    echo ">> Registering shortcut '$SHORTCUT' -> open history"
    python3 - "$SHORTCUT" <<'EOF'
import os
import subprocess
import sys

binding = sys.argv[1]
command = f"{os.path.expanduser('~/.local/bin/clipman')} toggle"

base_schema = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clipman/"
schema = f"{base_schema}:{path}"
list_key_schema = "org.gnome.settings-daemon.plugins.media-keys"

def gset(schema, key, value):
    subprocess.run(["gsettings", "set", schema, key, value], check=True)


out = subprocess.run(
    ["gsettings", "get", list_key_schema, "custom-keybindings"],
    capture_output=True, text=True,
).stdout.strip()
try:
    existing = eval(out) if not out.startswith("@as") else []
except Exception:
    existing = []
new = [x for x in existing if "clipman" not in x]
new.append(path)
gset(list_key_schema, "custom-keybindings", str(new))

gset(schema, "name", "'Clipboard History'")
gset(schema, "command", repr(command))
gset(schema, "binding", repr(binding))
print(f"Shortcut {binding} registered (toggle clipboard history).")
EOF
fi

if [[ "$GUI" == "1" ]]; then
    "$BIN_DIR/clipman" &
fi

echo ""
echo "Done. Restart GNOME Shell (Alt+F2 -> r, or log out/in), then:"
echo "  - click the clipboard icon in the top bar"
echo "  - press the shortcut (default Ctrl+Alt+V for the extension)"
echo "  - or run: ${BIN_DIR}/clipman toggle"