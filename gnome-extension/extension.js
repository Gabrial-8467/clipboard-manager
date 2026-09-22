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

function historyPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'clipboard-manager',
        'history.jsonl',
    ]);
}

function readTextFile(path) {
    try {
        const [ok, data] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        if (typeof data === 'string')
            return data;
        return new TextDecoder().decode(data);
    } catch (e) {
        return null;
    }
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
        if (this._ownerId && this._selection) {
            this._selection.disconnect(this._ownerId);
            this._ownerId = 0;
            this._selection = null;
        }
        try {
            Main.wm.removeKeybinding(KEY_TOGGLE);
        } catch (e) {
        }
        this._indicator?.destroy();
        this._indicator = null;
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

    // -- history ---------------------------------------------------------

    _reload() {
        this._snapshot = [];
        const raw = readTextFile(historyPath());
        if (!raw)
            return;
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
        this._snapshot.reverse(); // newest first
        this._rebuildList();
    }

    _save() {
        const path = historyPath();
        const dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        const sb = [];
        for (let i = this._snapshot.length - 1; i >= 0; i--)
            sb.push(JSON.stringify(this._snapshot[i]));
        GLib.file_set_contents(path, sb.join('\n') + '\n');
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
        const max = this._settings.get_int(KEY_MAX);
        if (this._snapshot.length > max)
            this._snapshot.length = max;
        if (this._menuOpen)
            this._rebuildList();
        this._save();
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
        this._snapshot = [];
        this._save();
        this._rebuildList();
    }

    // -- menu ------------------------------------------------------------

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
        this._search.clutter_text.connect('text-changed', () => this._rebuildList());
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

        menu.connect('open-state-changed', (m, open) => {
            this._menuOpen = open;
            if (open) {
                this._reload();
                this._search.text = '';
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
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
        item.connect('activate', () => {
            this._setClipboard(text);
            this._menu.close();
        });
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