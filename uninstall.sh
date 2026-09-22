#!/usr/bin/env bash
# Remove clipman and the clipboard-history extension.
set -euo pipefail

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UUID="clipboard-history@local"

echo ">> Removing clipman app"
rm -rf "$HOME/.local/lib/clipboard-manager"
rm -f "$HOME/.local/bin/clipman"
rm -f "$CONFIG_HOME/autostart/clipboard-manager.desktop"

echo ">> Removing GNOME extension"
if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
fi
rm -rf "$DATA_HOME/gnome-shell/extensions/$UUID"

echo ">> Removing custom keybinding (if any)"
python3 - <<'EOF' 2>/dev/null || true
import subprocess
schema = "org.gnome.settings-daemon.plugins.media-keys"
path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clipman/"
out = subprocess.run(["gsettings", "get", schema, "custom-keybindings"],
                     capture_output=True, text=True).stdout.strip()
try:
    items = eval(out) if not out.startswith("@as") else []
except Exception:
    items = []
items = [x for x in items if "clipman" not in x]
subprocess.run(["gsettings", "set", schema, "custom-keybindings", str(items)], check=False)
EOF

echo ""
echo "Removed. Restart GNOME Shell (Alt+F2 -> r) to unload the extension."
echo "Your history (if any) is kept at: $DATA_HOME/clipboard-manager/history.jsonl"