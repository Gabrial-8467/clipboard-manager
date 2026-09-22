"""Clipboard watcher.

GTK backend (default): polls the GDK clipboard on the main loop. On Wayland
reads are non-destructive (no selection ownership is taken), on X11 this is the
same lightweight read/compare trick used by many manager tools. Text-only.

wl-paste backend (optional): spawns ``wl-paste --watch cat -n`` which emits one
line per clipboard change. Needs the ``wl-clipboard`` package.
"""

import subprocess

import gi

gi.require_version("Gdk", "4.0")
from gi.repository import GLib, Gdk

DEFAULT_POLL_MS = 700


class Monitor:
    def __init__(self, storage, backend="gtk", interval_ms=DEFAULT_POLL_MS):
        self.storage = storage
        self.backend = backend
        self.interval_ms = interval_ms
        self._last = None
        self._clipboard = None
        self._source = None
        self._proc = None
        self.on_new = None  # callable(item) -> None, called on the main loop

    def start(self):
        if self._source or self._proc:
            return
        if self.backend == "wl-paste":
            self._start_wl_paste()
        else:
            display = Gdk.Display.get_default()
            if display is None:
                return
            self._clipboard = display.get_clipboard()
            self._source = GLib.timeout_add(self.interval_ms, self._poll)

    def stop(self):
        if self._source:
            GLib.source_remove(self._source)
            self._source = None
        if self._proc:
            self._proc.terminate()
            self._proc = None

    def note_manual(self, text):
        """Tell the monitor a text we copied ourselves, so it is not re-added."""
        self._last = text

    # -- gtk polling backend ---------------------------------------------

    def _poll(self):
        try:
            self._clipboard.read_text_async(None, self._on_read)
        except GLib.Error:
            pass
        return True

    def _on_read(self, clipboard, result):
        try:
            text = clipboard.read_text_finish(result)
        except GLib.Error:
            return
        if not isinstance(text, str):
            return
        if text == self._last:
            return
        self._last = text
        item = self.storage.add(text)
        if item and self.on_new:
            self.on_new(item)

    # -- wl-paste backend ------------------------------------------------

    def _start_wl_paste(self):
        try:
            self._proc = subprocess.Popen(
                ["wl-paste", "--watch", "cat", "-n"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except FileNotFoundError:
            return
        GLib.io_add_watch(
            self._proc.stdout, GLib.IO_IN | GLib.IO_HUP, self._on_wl_paste
        )

    def _on_wl_paste(self, pipe, condition):
        if condition & GLib.IO_HUP:
            self._proc = None
            return GLib.SOURCE_REMOVE
        for line in pipe:
            text = line.rstrip("\n")
            if not text:
                continue
            if text == self._last:
                continue
            self._last = text
            item = self.storage.add(text)
            if item and self.on_new:
                self.on_new(item)
        return GLib.SOURCE_CONTINUE