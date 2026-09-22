# Clipboard History Manager (Linux / GNOME)

A clipboard manager that **saves your copy history**, with two front-ends that share
**one history store** (`~/.local/share/clipboard-manager/history.jsonl`):

| Component | What it is | Works on |
|---|---|---|
| `gnome-extension/` | GNOME Shell **top-bar extension** — click the clipboard icon for a searchable history menu | GNOME 45–50, Wayland or X11 |
| `app/` (`clipman`) | Lightweight **GTK4 Python app** — background monitor + searchable history window | Any Linux with GTK4 (GNOME, XFCE, i3+…) |

Pinned entries stay on top. Copying from either front-end puts the item into the
same shared history. Start **only one monitor** at a time (extension or app) to
avoid double-recording; both deduplicate, so running both is safe but noisy.

## Features

- Automatic capture of every text copy (Ctrl+C in any app)
- Searchable history (pinned items always first)
- Re-copy any old item with a click
- Pin / delete individual entries, clear everything
- Keyboard shortcut to toggle the menu / window
- Optional global shortcut to toggle the GTK app window (GNOME)
- History survives reboots (JSON-lines file, capped size)

## Install

```bash
git clone https://github.com/gabrialdeora/clipboard-manager  # or copy this folder
cd clipboard-manager
chmod +x install.sh uninstall.sh
./install.sh            # extension + app + autostart
./install.sh --no-app   # extension only
./install.sh --no-extension --shortcut '<Super>v'   # app + global shortcut only
```

Then **restart GNOME Shell** (Alt+F2 → `r`, or log out/in).

> The extension monitors the clipboard using GNOME Shell's own
> `owner-change` signal, which is exactly correct on Wayland — no polling,
> no extra ownership tricks.

### Uninstall

```bash
./uninstall.sh
```

## Using it

**GNOME extension**
- Click the `edit-paste` icon in the top bar
- Type to filter; click an entry to paste it where you are typing
- Star icon = pin/unpin, trash icon = delete
- `Ctrl+Alt+V` toggles the menu (configurable)

**clipman GTK app**
```bash
clipman                       # run with window
clipman hide                  # background monitor (used by autostart)
clipman toggle                # show/hide window (shortcut target)
clipman show  / clipman clear / clipman quit / clipman status
```

Both write to and read from the same file, so history you copy via the
extension shows up in the app and vice-versa.

## Configuration

**Extension** (GNOME Settings → Extensions → Clipboard History, or):

```bash
gsettings set org.gnome.shell.extensions.clipboard-history max-items 500
gsettings set org.gnome.shell.extensions.clipboard-history preview-length 160
gsettings set org.gnome.shell.extensions.clipboard-history toggle-menu "['<Super>v']"
gsettings set org.gnome.shell.extensions.clipboard-history save-history false   # monitor only
```

**App**

```bash
clipman --max-items 800
clipman --backend gtk        # default: GDK clipboard polling
clipman --backend wl-paste   # event-driven, needs wl-clipboard
```

## Requirements

- **Extension:** GNOME Shell ≥ 45, `gnome-extensions` tool
- **App:** Python ≥ 3.10 with PyGObject (`python3-gi`, GTK 4), optional `wl-clipboard`
  for the `wl-paste` backend

## Layout

```
clipboard-manager/
├── install.sh / uninstall.sh
├── gnome-extension/          # GNOME Shell extension
│   ├── extension.js  prefs.js  metadata.json  stylesheet.css  schemas/
└── app/clipman/              # Python GTK4 app
    ├── cli.py  monitor.py  storage.py  window.py
```