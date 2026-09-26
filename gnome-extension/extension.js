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
const KEY_IMAGES = 'save-images';

const MAX_MENU_ITEMS = 250;
const SEARCH_DEBOUNCE_MS = 120;
const PASTE_DELAY_MS = 70;
const THUMBNAIL_SIZE = 28;

// Mirrors the text mimetypes St.Clipboard itself accepts (st-clipboard.c), so
// we can tell an image-only clipboard (a screenshot) from one that also has
// text, without paying for a read we would throw away.
const TEXT_MIMETYPES = [
    'text/plain;charset=utf-8',
    'text/plain',
    'UTF8_STRING',
    'STRING',
];
const IMAGE_MIMETYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/gif',
];
// Screenshots are a few MB; anything past this is not something to keep around.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Copying a file in Files, or an app that copies a path, offers the path as
// text. That is never something worth keeping, and it is what made screenshots
// show up here as bare paths.
const IMAGE_FILE_EXTENSIONS =
    /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|heif)$/i;

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

function imageDir() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'clipboard-manager',
        'images',
    ]);
}

function imageExtensionFor(mime) {
    switch (mime) {
        case 'image/jpeg':
            return 'jpg';
        case 'image/tiff':
            return 'tif';
        default:
            return mime.slice('image/'.length);
    }
}

// A bare file:// URI or local image path, i.e. the text form of an image copy.
// Anything with whitespace is prose, and remote URLs are left alone because a
// link to an image is still text worth keeping.
function looksLikeImagePath(text) {
    const t = text.trim();
    if (!t || /\s/.test(t))
        return false;
    if (/^file:/i.test(t))
        return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t))
        return false;
    return IMAGE_FILE_EXTENSIONS.test(t.split(/[?#]/)[0]);
}

// Width/height out of a PNG IHDR chunk, so entries can be told apart at a
// glance. Returns null for anything that is not a PNG we can parse.
function pngSize(bytes) {
    const data = bytes.get_data();
    if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50)
        return null;
    const width = ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0;
    const height = ((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0;
    return width && height ? `${width}×${height}` : null;
}

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._snapshot = [];
        this._skipNext = null;
        this._skipImage = null;
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
                GLib.Source.remove(id);
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
        if (this._toggleId) {
            this._settings.disconnect(this._toggleId);
            this._toggleId = 0;
        }
        // removeKeybinding() throws if the accelerator was never registered,
        // which is the normal case now that toggle-menu ships unset.
        try {
            Main.wm.removeKeybinding(KEY_TOGGLE);
        } catch (e) {
        }
        // Destroying the indicator destroys the menu and everything in it.
        this._indicator?.destroy();
        this._indicator = null;
        this._menu = null;
        this._search = null;
        this._historySection = null;
        this._clearBtn = null;
        this._clipboard = null;
        this._settings = null;
        this._snapshot = [];
        this._skipImage = null;
    }

    // -- clipboard -------------------------------------------------------

    _onOwnerChange() {
        if (!this._settings.get_boolean(KEY_SAVE))
            return;
        const mimes = this._clipboardMimetypes();
        const image = mimes.find(m => IMAGE_MIMETYPES.includes(m));
        const hasText = mimes.some(m => TEXT_MIMETYPES.includes(m));
        // Text wins when an app offers both, so existing behaviour is kept.
        if (image && !hasText && this._settings.get_boolean(KEY_IMAGES)) {
            this._captureImage(image);
            return;
        }
        this._readClipboardText(text => {
            if (!text || !text.trim())
                return;
            if (looksLikeImagePath(text))
                return;
            if (this._skipNext !== null && text === this._skipNext) {
                this._skipNext = null;
                return;
            }
            this._add(text);
        });
    }

    // Synchronous: st_clipboard_get_mimetypes() answers from the selection
    // source rather than reading the data out.
    _clipboardMimetypes() {
        const clip = this._clipboard;
        if (!clip)
            return [];
        try {
            return clip.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        } catch (e) {
            return [];
        }
    }

    // Screenshots and other image copies carry no text, so they would otherwise
    // leave no trace at all. The bytes are stored content-addressed: the same
    // image copied twice is one file and one entry.
    _captureImage(mime) {
        const clip = this._clipboard;
        if (!clip)
            return;
        try {
            clip.get_content(St.ClipboardType.CLIPBOARD, mime, (_cl, bytes) => {
                if (!bytes)
                    return;
                if (this._skipImage !== null) {
                    this._skipImage = null;
                    return;
                }
                if (bytes.get_size() > MAX_IMAGE_BYTES) {
                    log(`clipboard-history: ${mime} too large (${bytes.get_size()} bytes), skipped`);
                    return;
                }
                const digest = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
                const path = GLib.build_filenamev([imageDir(), `${digest}.${imageExtensionFor(mime)}`]);
                this._storeImage(bytes, path, () => {
                    const size = mime === 'image/png' ? pngSize(bytes) : null;
                    this._addItem({
                        text: size ? `Image ${size}` : `Image (${mime.slice(6)})`,
                        ts: Date.now(),
                        pin: false,
                        mime,
                        image: path,
                    }, path);
                });
            });
        } catch (e) {
            log(`clipboard-history: image read failed: ${e}`);
        }
    }

    _storeImage(bytes, path, cb) {
        const file = Gio.File.new_for_path(path);
        try {
            if (file.query_exists(null)) {
                cb();
                return;
            }
        } catch (e) {
            // cannot tell, so just try to write it
        }
        GLib.mkdir_with_parents(imageDir(), 0o755);
        file.replace_contents_async(
            bytes, null, false, Gio.FileCreateFlags.NONE, null,
            (f, result) => {
                try {
                    f.replace_contents_finish(result);
                } catch (e) {
                    log(`clipboard-history: image write failed: ${e}`);
                }
                cb();
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

    // Copy the entry back to the clipboard and inject Ctrl+V (Shift+Ctrl+V /
    // Ctrl+Insert in terminals is not detected yet) into the previously focused
    // window, so a click pastes where you are typing.
    _pasteEntry(entry) {
        if (entry.image)
            this._pasteImageEntry(entry);
        else
            this._pasteTextEntry(entry.text);
        this._menu.close();
    }

    _pasteTextEntry(text) {
        this._setClipboard(text);
        this._schedulePaste();
    }

    // Same as a text entry, but the clipboard set is asynchronous, so the paste
    // waits for the image to actually be on the clipboard.
    _pasteImageEntry(entry) {
        const clip = this._clipboard;
        if (!clip)
            return;
        const file = Gio.File.new_for_path(entry.image);
        file.load_contents_async(null, (f, result) => {
            let bytes = null;
            try {
                [, bytes] = f.load_contents_finish(result);
            } catch (e) {
                log(`clipboard-history: image read failed: ${e}`);
                return;
            }
            if (!bytes)
                return;
            this._skipImage = entry.image;
            try {
                clip.set_content(St.ClipboardType.CLIPBOARD, entry.mime, bytes);
            } catch (e) {
                log(`clipboard-history: image set failed: ${e}`);
                this._skipImage = null;
                return;
            }
            this._schedulePaste();
        });
    }

    _schedulePaste() {
        if (this._pasteTimeout)
            GLib.Source.remove(this._pasteTimeout);
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
        this._addItem({text, ts: Date.now(), pin: false}, text);
    }

    // Text is keyed by its content, images by the file they were stored as, so
    // re-copying something just moves the existing entry back to the top.
    _addItem(item, key) {
        for (let i = 0; i < this._snapshot.length; i++) {
            if (this._entryKey(this._snapshot[i]) === key) {
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

    _entryKey(entry) {
        return entry.image ?? entry.text;
    }

    // The cap counts unpinned entries only: a pin survives until the user
    // unpins or deletes it, however far that pushes the history past the limit.
    // Capping unpinned rather than the total also guarantees a fresh copy is
    // never the one evicted.
    _trim() {
        let budget = this._settings.get_int(KEY_MAX);
        // Snapshot is newest-first, so keep the first `budget` unpinned entries
        // and drop the older ones behind them.
        const dropped = [];
        this._snapshot = this._snapshot.filter(e => {
            if (e.pin)
                return true;
            if (budget > 0) {
                budget--;
                return true;
            }
            dropped.push(e);
            return false;
        });
        for (const entry of dropped)
            this._forgetImage(entry);
    }

    // Drop the stored file once no entry references it any more. Dedupe means
    // that is normally immediate, but check first rather than assume.
    _forgetImage(entry) {
        if (!entry.image)
            return;
        if (this._snapshot.some(e => e !== entry && e.image === entry.image))
            return;
        const file = Gio.File.new_for_path(entry.image);
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, result) => {
            try {
                f.delete_finish(result);
            } catch (e) {
                // already gone, or never written
            }
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
        this._forgetImage(entry);
        this._rebuildList();
    }

    _clearAll() {
        // Pinned entries survive a clear; only the rest are dropped.
        const dropped = this._snapshot.filter(e => !e.pin);
        this._snapshot = this._snapshot.filter(e => e.pin);
        this._save();
        for (const entry of dropped)
            this._forgetImage(entry);
        this._rebuildList();
    }

    // -- menu ------------------------------------------------------------

    // Touch-search only rebuilds ~120ms after you stop typing.
    _rebuildDebounced() {
        if (this._rebuildTimeout)
            GLib.Source.remove(this._rebuildTimeout);
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
                    GLib.Source.remove(this._focusIdle);
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

        if (entry.image) {
            // Explicit file icon: the stored path is an absolute filename, not
            // a themed icon name, so it must not go through the name lookup.
            const thumb = new St.Image({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(entry.image)),
                icon_size: THUMBNAIL_SIZE,
                style_class: 'clipboard-history-thumb',
            });
            // Sits left of the label, which expands to fill the row.
            item.insert_child_at_index(thumb, 0);
        }

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
        item.connect('activate', () => this._pasteEntry(entry));
        return item;
    }

    // -- shortcut --------------------------------------------------------

    _bindShortcut() {
        this._rebindShortcut();
        this._toggleId = this._settings.connect(`changed::${KEY_TOGGLE}`, () => {
            this._rebindShortcut();
        });
    }

    _rebindShortcut() {
        try {
            Main.wm.removeKeybinding(KEY_TOGGLE);
        } catch (e) {
            // not registered yet, nothing to remove
        }
        // The accelerator ships unset, so there is nothing to bind until the
        // user picks one.
        if (this._settings.get_strv(KEY_TOGGLE).length === 0)
            return;
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