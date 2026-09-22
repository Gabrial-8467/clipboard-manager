"""Clipman - clipboard history manager.

Commands:
    clipman                     run the app (monitor + history window)
    clipman --hide              run in background (no window)
    clipman toggle              show / hide the history window
    clipman show                show the history window
    clipman clear               clear the whole history
    clipman quit                stop the background app
    clipman status              print daemon / history state

The app is a single-instance Gtk.Application: any second invocation forwards
its arguments to the already running instance via DBus activation, so
``clipman toggle`` works as a global-shortcut target.
"""

import argparse
import os
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, GLib, Gtk

from .monitor import Monitor
from .storage import HISTORY_PATH, Storage
from .window import HistoryWindow

APP_ID = "io.github.clipman.Clipman"


def _ensure_environment():
    """Guarantee a session display even when launched without one
    (e.g. by the compositor, which has no DISPLAY/WAYLAND_DISPLAY)."""
    runtime = os.environ.setdefault(
        "XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"
    )
    defaults = {
        "WAYLAND_DISPLAY": "wayland-0",
        "DISPLAY": ":0",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
    }
    missing = [k for k, v in defaults.items() if not os.environ.get(k)]
    for key, value in defaults.items():
        os.environ.setdefault(key, value)
    if missing:
        print(
            "clipman: heals missing session environment "
            f"({', '.join(missing)})",
            file=sys.stderr,
            flush=True,
        )


class ClipmanApp(Gtk.Application):
    def __init__(self, options):
        super().__init__(
            application_id=APP_ID,
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS,
        )
        self.options = options
        self.command = options.command
        self.storage = None
        self.monitor = None
        self.window = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Keep the app alive even when run without a window (daemon mode).
        self.hold()
        self.storage = Storage(max_items=self.options.max_items)
        self.monitor = Monitor(self.storage, backend=self.options.backend)
        self.monitor.start()

    def do_activate(self):
        if self.command == "hide":
            return
        self._open_window()

    def do_command_line(self, command_line):
        args = command_line.get_arguments()[1:]
        parser = build_parser()
        parsed, _unknown = parser.parse_known_args(args)
        if args:
            self._apply(parsed.command)
        elif self.command not in ("hide",):
            self._open_window()
        return 0

    def do_shutdown(self):
        if self.monitor:
            self.monitor.stop()
        if self.window:
            self.window.destroy()
        Gtk.Application.do_shutdown(self)

    def _ensure_window(self):
        if self.window is None:
            self.window = HistoryWindow(self, self.storage, self.monitor)

    def _open_window(self):
        try:
            self._ensure_window()
            self.window.present()
        except Exception as exc:  # noqa: BLE001 - never kill the daemon on UI errors
            import traceback

            print("clipman: cannot open window:", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            print(f"clipman: {exc}", file=sys.stderr, flush=True)

    def _apply(self, command):
        if command == "toggle":
            self._open_window()
            if self.window and self.window.is_visible():
                self.window.hide()
        elif command == "show":
            self._open_window()
        elif command == "clear":
            self.storage.clear()
            if self.window:
                self.window.refresh()
        elif command == "hide":
            pass  # already running in background
        elif command == "quit":
            self.quit()
        elif command == "status":
            self._print_status()
        else:
            self._open_window()

    def _print_status(self):
        n = len(self.storage.items)
        latest = self.storage.items[0]["text"] if self.storage.items else ""
        lines = [
            f"application-id: {APP_ID}",
            f"history: {HISTORY_PATH}",
            f"items: {n}",
            f"latest: {latest[:60]!r}",
            f"window-open: {bool(self.window and self.window.is_visible())}",
        ]
        print("\n".join(lines), flush=True)


def build_parser():
    p = argparse.ArgumentParser(
        prog="clipman", description="Clipboard history manager"
    )
    p.add_argument(
        "--max-items", type=int, default=500, help="keep at most N items"
    )
    p.add_argument(
        "--backend",
        choices=["gtk", "wl-paste"],
        default="gtk",
        help="clipboard monitor backend",
    )
    p.add_argument(
        "command",
        nargs="?",
        default="app",
        help="(none) | hide | toggle | show | clear | quit | status",
    )
    return p


def main(argv=None):
    _ensure_environment()
    argv = sys.argv[1:] if argv is None else argv
    args = build_parser().parse_args(argv)
    app = ClipmanApp(args)
    return app.run(None)


if __name__ == "__main__":
    sys.exit(main())