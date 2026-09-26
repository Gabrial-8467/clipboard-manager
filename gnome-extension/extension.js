import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const KEY_SAVE = 'save-history';
const KEY_MAX = 'max-items';
const KEY_TOGGLE = 'toggle-menu';
const KEY_PREVIEW = 'preview-length';

const MAX_MENU_ITEMS = 250;
const SEARCH_DEBOUNCE_MS = 120;
const PASTE_DELAY_MS = 70;

// Paste is injected through an in-process Clutter virtual input device, the same
// mechanism the on-screen keyboard uses (no Remote Desktop portal / permission
// dialog). Keys are sent by evdev hardware keycode so it works under any
// keyboard layout. Codes from <linux/input-event-codes.h>.
const KEY_CTRL = 29; // KEY_LEFTCTRL
const KEY_V = 47; // KEY_V

function historyPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'clipboard-manager',
        'history.jsonl',
    ]);
}

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._snapshot = [];
        this._skipNext = null;
        this._menuOpen = false;

        this._buildIndicator();
        this._bindShortcut();

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection?.connect('owner-changed', () =>
            this._onOwnerChange());

        this._reload();
    }

    disable() {
        for (const id of [this._rebuildTimeout, this._pasteTimeout, this._focusIdle]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildTimeout = null;
        this._pasteTimeout = null;
        this._focusIdle = null;
        this._keyDevice = null;

        if (this._openStateId && this._menu) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        if (this._searchChangedId && this._search?.clutter_text) {
            this._search.clutter_text.disconnect(this._searchChangedId);
            this._searchChangedId = 0;
        }
        if (this._ownerId && this._selection) {
            this._selection.disconnect(this._ownerId);
            this._ownerId = 0;
            this._selection = null;
        }
        try {
            Main.wm.removeKeybinding(KEY_TOGGLE);
        } catch (e) {
        }
        this._search?.destroy();
        this._search = null;
        this._historySection?.destroy();
        this._historySection = null;
        this._clearBtn?.destroy();
        this._clearBtn = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._menu = null;
        this._clipboard = null;
        this._settings = null;
        this._snapshot = [];
    }

    // -- clipboard -------------------------------------------------------

    _onOwnerChange() {
        if (!this._settings.get_boolean(KEY_SAVE))
            return;
        this._readClipboardText(text => {
            if (typeof text !== 'string' || !text.trim())
                return;
            if (this._skipNext !== null && text === this._skipNext) {
                this._skipNext = null;
                return;
            }
            this._add(text);
        });
    }

    _readClipboardText(cb) {
        const clip = this._clipboard;
        if (!clip) {
            cb(null);
            return;
        }
        try {
            clip.get_text(St.ClipboardType.CLIPBOARD, (_cl, text) => cb(text));
        } catch (e) {
            cb(null);
        }
    }

    _setClipboard(text) {
        const clip = this._clipboard;
        if (!clip)
            return;
        this._skipNext = text;
        try {
            clip.set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {
            log(`clipboard-history: set_text failed: ${e}`);
        }
    }

    // Copy `text` to the clipboard and inject Ctrl+V (Shift+Ctrl+V / Ctrl+Insert
    // in terminals is not detected yet) into the previously focused window, so a
    // click pastes where you are typing.
    _pasteEntry(text) {
        this._setClipboard(text);
        this._menu.close();
        if (this._pasteTimeout)
            GLib.source_remove(this._pasteTimeout);
        this._pasteTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeout = null;
            try {
                this._injectPaste([KEY_CTRL], KEY_V);
            } catch (e) {
                log(`clipboard-history: paste injection failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Press modifiers, press the key, then release in reverse order using
    // monotonic timestamps (get_current_event_time() is 0 outside an event).
    _injectPaste(modifiers, key) {
        const device = this._keyDevice ??= (() =>
            Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE))();
        const now = () => GLib.get_monotonic_time();
        for (const mod of modifiers)
            device.notify_key(now(), mod, Clutter.KeyState.PRESSED);
        device.notify_key(now(), key, Clutter.KeyState.PRESSED);
        device.notify_key(now(), key, Clutter.KeyState.RELEASED);
        for (const mod of [...modifiers].reverse())
            device.notify_key(now(), mod, Clutter.KeyState.RELEASED);
    }

    // -- history ---------------------------------------------------------

    _reload() {
        this._snapshot = [];
        const file = Gio.File.new_for_path(historyPath());
        file.load_contents_async(null, (f, result) => {
            try {
                const [, contents] = f.load_contents_finish(result);
                const raw = new TextDecoder().decode(contents ?? new Uint8Array());
                for (const line of raw.split('\n')) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    try {
                        const item = JSON.parse(t);
                        if (item && typeof item.text === 'string')
                            this._snapshot.push(item);
                    } catch (e) {
                        // skip malformed line
                    }
                }
            } catch (e) {
                // missing or unreadable history file -> empty snapshot
            }
            this._snapshot.reverse(); // newest first
            this._rebuildList();
        });
    }

    _save() {
        const path = historyPath();
        const dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        const sb = [];
        for (let i = this._snapshot.length - 1; i >= 0; i--)
            sb.push(JSON.stringify(this._snapshot[i]));
        const file = Gio.File.new_for_path(path);
        const bytes = new TextEncoder().encode(sb.join('\n') + '\n');
        file.replace_contents_async(
            bytes, null, false, Gio.FileCreateFlags.NONE, null,
            (f, result) => {
                try {
                    f.replace_contents_finish(result);
                } catch (e) {
                    log(`clipboard-history: save failed: ${e}`);
                }
            });
    }

    _add(text) {
        const item = {
            text,
            ts: Date.now(),
            pin: false,
        };
        for (let i = 0; i < this._snapshot.length; i++) {
            if (this._snapshot[i].text === text) {
                const old = this._snapshot.splice(i, 1)[0];
                this._snapshot.unshift(old);
                if (this._menuOpen)
                    this._rebuildList();
                this._save();
                return;
            }
        }
        this._snapshot.unshift(item);
        this._trim();
        if (this._menuOpen)
            this._rebuildList();
        this._save();
    }

    // The cap counts unpinned entries only: a pin survives until the user
    // unpins or deletes it, however far that pushes the history past the limit.
    // Capping unpinned rather than the total also guarantees a fresh copy is
    // never the one evicted.
    _trim() {
        let budget = this._settings.get_int(KEY_MAX);
        // Snapshot is newest-first, so keep the first `budget` unpinned entries
        // and drop the older ones behind them.
        this._snapshot = this._snapshot.filter(e => {
            if (e.pin)
                return true;
            if (budget > 0) {
                budget--;
                return true;
            }
            return false;
        });
    }

    _togglePin(entry) {
        entry.pin = !entry.pin;
        this._save();
        this._rebuildList();
    }

    _deleteEntry(entry) {
        this._snapshot = this._snapshot.filter(e => e !== entry);
        this._save();
        this._rebuildList();
    }

    _clearAll() {
        // Pinned entries survive a clear; only the rest are dropped.
        this._snapshot = this._snapshot.filter(e => e.pin);
        this._save();
        this._rebuildList();
    }

    // -- menu ------------------------------------------------------------

    // Touch-search only rebuilds ~120ms after you stop typing.
    _rebuildDebounced() {
        if (this._rebuildTimeout)
            GLib.source_remove(this._rebuildTimeout);
        this._rebuildTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                this._rebuildTimeout = 0;
                this._rebuildList();
                return GLib.SOURCE_REMOVE;
            });
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        const icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        const menu = this._indicator.menu;
        this._menu = menu;

        const topbar = new St.BoxLayout({style_class: 'clipboard-history-topbar'});

        this._search = new St.Entry({
            hint_text: 'Search history…',
            can_focus: true,
            style_class: 'clipboard-history-search',
        });
        this._searchChangedId =
            this._search.clutter_text.connect('text-changed', () =>
                this._rebuildDebounced());
        this._search.set_x_expand(true);
        topbar.add_child(this._search);

        const clearBtn = new St.Button({
            label: 'Clear',
            style_class: 'clipboard-history-clear-button',
        });
        clearBtn.connect('clicked', () => this._clearAll());
        topbar.add_child(clearBtn);
        this._clearBtn = clearBtn;

        menu.box.add_child(topbar);

        this._historySection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._historySection);

        this._openStateId = menu.connect('open-state-changed', (m, open) => {
            this._menuOpen = open;
            if (open) {
                this._reload();
                this._search.text = '';
                if (this._focusIdle)
                    GLib.source_remove(this._focusIdle);
                this._focusIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._focusIdle = null;
                    this._search.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    _rebuildList() {
        if (!this._historySection || !this._menu)
            return;
        this._historySection.destroy();
        this._historySection = new PopupMenu.PopupMenuSection();

        const query = (this._search?.text || '').trim().toLowerCase();
        let entries = this._snapshot;
        if (query)
            entries = entries.filter(e => e.text.toLowerCase().includes(query));

        const pinned = entries.filter(e => e.pin);
        const rest = entries.filter(e => !e.pin);
        const ordered = pinned.concat(rest).slice(0, MAX_MENU_ITEMS);

        if (ordered.length === 0) {
            // empty state intentionally left blank
        } else {
            const previewLen = this._settings.get_int(KEY_PREVIEW);
            for (const entry of ordered)
                this._historySection.addMenuItem(this._makeItem(entry, previewLen));
        }
        this._menu.addMenuItem(this._historySection);
    }

    _makeItem(entry, previewLen) {
        const text = entry.text;
        const label = text.length <= previewLen
            ? text
            : text.slice(0, previewLen) + '…';
        const item = new PopupMenu.PopupMenuItem(label);

        const actions = new St.BoxLayout({style_class: 'clipboard-history-actions'});
        const pinBtn = new St.Button({
            style_class: 'clipboard-history-action',
            child: new St.Icon({
                icon_name: entry.pin ? 'starred-symbolic' : 'non-starred-symbolic',
                style_class: 'clipboard-history-action-icon',
            }),
        });
        pinBtn.connect('clicked', () => this._togglePin(entry));
        actions.add_child(pinBtn);

        const delBtn = new St.Button({
            style_class: 'clipboard-history-action',
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'clipboard-history-action-icon',
            }),
        });
        delBtn.connect('clicked', () => this._deleteEntry(entry));
        actions.add_child(delBtn);

        item.add_child(actions);
        item.connect('activate', () => this._pasteEntry(text));
        return item;
    }

    // -- shortcut --------------------------------------------------------

    _bindShortcut() {
        try {
            Main.wm.removeKeybinding(KEY_TOGGLE);
        } catch (e) {
        }
        try {
            Main.wm.addKeybinding(
                KEY_TOGGLE,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleMenu(),
            );
        } catch (e) {
            log(`clipboard-history: shortcut bind failed: ${e}`);
        }
    }

    _toggleMenu() {
        if (!this._indicator)
            return;
        if (this._indicator.menu.isOpen)
            this._indicator.menu.close();
        else
            this._indicator.menu.open();
    }
}