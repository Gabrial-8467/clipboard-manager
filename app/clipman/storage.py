"""Persistent clipboard history storage.

Both the GNOME Shell extension and this app share the same JSON-lines file so
they show one history no matter which frontend is used.

File format (oldest -> newest, one JSON object per line):
    {"text": "...", "ts": 1700000000000, "pin": false}

In memory the entries are kept newest-first.
"""

import json
import os
import re
import threading
import time

# Maximum length of a single stored item, prevents pathological copies.
MAX_TEXT_LENGTH = 200_000

# Extensions that mark a copied path as an image rather than something worth
# keeping. Copying a file in Files, or using a tool that copies a path, offers
# that path as text -- which is how screenshots used to end up here as bare
# paths even though the image itself was never stored.
_IMAGE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".tif", ".tiff", ".svg", ".avif", ".heic", ".heif",
)


def looks_like_image_path(text):
    """True for a bare file:// URI or local image path.

    This is the text form of an image copy. Anything with whitespace is prose,
    and remote URLs are left alone because a link to an image is still text
    worth keeping.
    """
    t = text.strip()
    if not t or any(ch.isspace() for ch in t):
        return False
    if t.lower().startswith("file:"):
        return True
    if re.match(r"^[a-z][a-z0-9+.-]*://", t, re.IGNORECASE):
        return False
    return re.split(r"[?#]", t, 1)[0].lower().endswith(_IMAGE_EXTENSIONS)

try:
    from xdg_base_dirs import xdg_data_home
except ImportError:
    def xdg_data_home():
        return os.environ.get(
            "XDG_DATA_HOME", os.path.expanduser("~/.local/share")
        )

HISTORY_PATH = os.path.join(
    xdg_data_home(), "clipboard-manager", "history.jsonl"
)


def now_ms():
    return int(time.time() * 1000)


class Storage:
    def __init__(self, path=HISTORY_PATH, max_items=500):
        self.path = path
        self.max_items = max(int(max_items or 500), 10)
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.items = self._load()

    # -- persistence -----------------------------------------------------

    def _load(self):
        items = []
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            item = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(item, dict) and isinstance(
                            item.get("text"), str
                        ):
                            items.append(item)
            except OSError:
                pass
        items.reverse()  # newest first
        return items

    def _flush(self):
        directory = os.path.dirname(self.path)
        tmp = os.path.join(directory, ".history.tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                for item in reversed(self.items):
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
            os.replace(tmp, self.path)
        except OSError:
            pass

    # -- mutations -------------------------------------------------------

    def _trim(self):
        """Drop the oldest unpinned entries above the cap.

        Pinned entries are exempt: a pin survives until the user unpins or
        deletes it, however far that pushes the history past the limit. Capping
        the unpinned entries rather than the total also guarantees a fresh copy
        is never the one evicted.
        """
        budget = self.max_items
        kept = []
        dropped = []
        for entry in self.items:  # newest first
            if entry.get("pin"):
                kept.append(entry)
            elif budget > 0:
                budget -= 1
                kept.append(entry)
            else:
                dropped.append(entry)
        self.items = kept
        for entry in dropped:
            self._forget_image(entry)

    def _forget_image(self, entry):
        """Delete a stored image once no entry references it any more."""
        path = entry.get("image")
        if not path:
            return
        if any(e.get("image") == path for e in self.items):
            return
        try:
            os.remove(path)
        except OSError:
            pass

    def add(self, text):
        """Add a copy to history. Returns the new/updated item or None."""
        if not text:
            return None
        text = text.rstrip("\x00").strip()
        if not text:
            return None
        if looks_like_image_path(text):
            return None
        if len(text) > MAX_TEXT_LENGTH:
            text = text[:MAX_TEXT_LENGTH]

        with self._lock:
            for i, item in enumerate(self.items):
                if item.get("text") == text:
                    item["ts"] = now_ms()
                    del self.items[i]
                    self.items.insert(0, item)
                    self._flush()
                    return item

            item = {"text": text, "ts": now_ms(), "pin": False}
            self.items.insert(0, item)
            self._trim()
            self._flush()
            return item

    def toggle_pin(self, index):
        with self._lock:
            if 0 <= index < len(self.items):
                self.items[index]["pin"] = not self.items[index]["pin"]
                self._flush()

    def delete_at(self, index):
        with self._lock:
            if 0 <= index < len(self.items):
                entry = self.items.pop(index)
                self._flush()
                self._forget_image(entry)

    def clear(self):
        with self._lock:
            dropped = self.items
            self.items = []
            self._flush()
            for entry in dropped:
                self._forget_image(entry)

    # -- queries ---------------------------------------------------------

    def snapshot(self):
        """Newest-first copy of all items."""
        with self._lock:
            return [dict(i) for i in self.items]


def ordered(entries):
    """Pinned items first, then by recency."""
    pinned = [e for e in entries if e.get("pin")]
    rest = [e for e in entries if not e.get("pin")]
    return pinned + rest