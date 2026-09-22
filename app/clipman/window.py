"""GTK4 history window: searchable list of copied items."""

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gdk, GObject, Gtk

from .storage import ordered


class _ListEntry(GObject.Object):
    __gtype_name__ = "ClipmanHistoryEntry"

    def __init__(self, **fields):
        super().__init__()
        for key, value in fields.items():
            setattr(self, key, value)


def preview(text, limit=160):
    text = text.replace("\t", " ").replace("\r", " ")
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    one = " ".join(lines) or text
    if len(one) > limit:
        return one[: limit - 1] + "…"
    return one


class HistoryWindow(Gtk.ApplicationWindow):
    def __init__(
        self,
        app,
        storage,
        monitor,
        on_copy=None,
        on_pin=None,
        on_delete=None,
        on_clear=None,
    ):
        super().__init__(application=app, title="Clipboard History")
        self.storage = storage
        self.monitor = monitor
        self.on_copy = on_copy or (lambda text: None)
        self.on_pin = on_pin or (lambda index: None)
        self.on_delete = on_delete or (lambda index: None)
        self.on_clear = on_clear or (lambda: None)

        self.set_default_size(520, 480)

        self._store = Gio.ListStore.new(_ListEntry)
        self._entries = []

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        root.set_margin_top(8)
        root.set_margin_bottom(8)
        root.set_margin_start(8)
        root.set_margin_end(8)
        self.set_child(root)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self._search = Gtk.SearchEntry(placeholder_text="Search history…")
        self._search.set_hexpand(True)
        self._search.connect("search-changed", self._on_search_changed)
        top.append(self._search)
        clear_btn = Gtk.Button(icon_name="edit-clear-all-symbolic")
        clear_btn.add_css_class("destructive-action")
        clear_btn.set_tooltip_text("Clear all history")
        clear_btn.connect("clicked", self._on_clear_clicked)
        top.append(clear_btn)
        root.append(top)

        scroller = Gtk.ScrolledWindow()
        scroller.set_vexpand(True)
        scroller.set_hexpand(True)
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroller.set_propagate_natural_height(True)

        self._selection = Gtk.SingleSelection.new(self._store)
        self._list_view = Gtk.ListView.new(self._selection, None)

        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._on_row_setup)
        factory.connect("bind", self._on_row_bind)
        factory.connect("unbind", self._on_row_unbind)
        self._list_view.set_factory(factory)
        self._list_view.connect("activate", self._on_row_activate)

        scroller.set_child(self._list_view)
        root.append(scroller)

        bottom = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self._pin_btn = Gtk.Button(icon_name="view-pin-symbolic")
        self._pin_btn.set_tooltip_text("Pin / unpin selected")
        self._pin_btn.connect("clicked", self._on_pin_clicked)
        bottom.append(self._pin_btn)

        self._delete_btn = Gtk.Button(icon_name="edit-delete-symbolic")
        self._delete_btn.set_tooltip_text("Remove selected")
        self._delete_btn.connect("clicked", self._on_delete_clicked)
        bottom.append(self._delete_btn)

        self._status_label = Gtk.Label(label="", xalign=0)
        self._status_label.set_hexpand(True)
        bottom.append(self._status_label)
        root.append(bottom)

        self._selection.connect("selection-changed", self._on_selection_changed)
        self.refresh()
        self._update_status()

    # -- data / list filling ---------------------------------------------

    def refresh(self):
        entries = ordered(self.storage.snapshot())
        query = self._search.get_text().strip().lower()
        if query:
            entries = [e for e in entries if query in e["text"].lower()]
        self._entries = entries
        self._store.remove_all()
        for entry in entries:
            self._store.append(_ListEntry(**entry))
        self._update_status()

    def _on_search_changed(self, *args):
        self.refresh()

    def _update_status(self):
        total = len(self.storage.items)
        shown = len(self._entries)
        pin_count = sum(1 for e in self.storage.items if e.get("pin"))
        parts = [f"{total} item{'s' if total != 1 else ''}"]
        if pin_count:
            parts.append(f"{pin_count} pinned")
        if shown != total:
            parts.append(f"{shown} shown")
        self._status_label.set_text(" · ".join(parts))

    def _flash_status(self, text, timeout_ms=1800):
        self._status_label.set_text(text)
        GLib.timeout_add(timeout_ms, self._update_status_true)
        return False

    def _update_status_true(self):
        self._update_status()
        return GLib.SOURCE_REMOVE

    # -- rows -------------------------------------------------------------

    def _on_row_setup(self, factory, list_item):
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.set_margin_top(4)
        box.set_margin_bottom(4)
        box.set_margin_start(4)
        box.set_margin_end(4)

        pin = Gtk.Image(icon_name="view-pin-symbolic")
        pin.set_margin_top(2)
        label = Gtk.Label(
            label="",
            xalign=0,
            ellipsize=Gtk.EllipsizeMode.END,
            wrap=True,
            wrap_mode=Gtk.PangoWrapMode.WORD_CHAR,
        )
        label.set_max_width_chars(60)
        label.set_hexpand(True)
        label.set_vexpand(True)
        label.set_margin_top(6)
        label.set_margin_bottom(6)

        box.append(pin)
        box.append(label)

        list_item.set_child(box)
        list_item.pin_icon = pin
        list_item.label = label

    def _on_row_bind(self, factory, list_item):
        entry = list_item.get_item()
        list_item.label.set_text(preview(entry.text))
        list_item.pin_icon.set_visible(entry.pin)

    def _on_row_unbind(self, factory, list_item):
        list_item.label.set_text("")

    def _on_row_activate(self, list_view, selection, position):
        entry = self._entries[position]
        self._copy(entry["text"])

    # -- actions ----------------------------------------------------------

    def _copy(self, text):
        if self.monitor:
            self.monitor.note_manual(text)
        clipboard = Gdk.Display.get_default().get_clipboard()
        clipboard.set_text(text)
        self.on_copy(text)
        self._flash_status(f"Copied {len(text)} chars")

    def _selected_index(self):
        idx = self._selection.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._entries):
            return None
        return idx

    def _on_pin_clicked(self, *args):
        idx = self._selected_index()
        if idx is None:
            return
        self.storage.toggle_pin(idx)
        self.on_pin(idx)
        self.refresh()

    def _on_delete_clicked(self, *args):
        idx = self._selected_index()
        if idx is None:
            return
        self.storage.delete_at(idx)
        self.on_delete(idx)
        self.refresh()

    def _on_clear_clicked(self, *args):
        self.storage.clear()
        self.on_clear()
        self.refresh()

    def _on_selection_changed(self, selection, position, n_items):
        index = selection.get_selected()
        self._pin_btn.set_sensitive(index != Gtk.INVALID_LIST_POSITION)
        self._delete_btn.set_sensitive(index != Gtk.INVALID_LIST_POSITION)