#!/bin/bash
# Build the extensions.gnome.org submission zip.
#
# The zip must contain the compiled schema: GNOME Shell reads settings straight
# out of the extension directory and will not compile it for you, so shipping
# only the XML leaves getSettings() returning null on a fresh install.
#
# The file list is explicit on purpose. extensions.gnome.org asks for no
# unnecessary files, and the icon is deliberately left out -- EGO takes the
# listing icon from a web upload, not from the zip.

set -euo pipefail

cd "$(dirname "$0")"

SRC="gnome-extension"
DIST="dist"
UUID="clipboard-history@gabrialdeora.github.com"
SCHEMA="org.gnome.shell.extensions.clipboard-history"

command -v glib-compile-schemas >/dev/null || {
    echo "glib-compile-schemas not found (install glib2-devel / libglib2.0-dev)" >&2
    exit 1
}

# The schema filename must be <schema-id>.gschema.xml for EGO to accept it.
XML="$SRC/schemas/$SCHEMA.gschema.xml"
[ -f "$XML" ] || { echo "missing $XML" >&2; exit 1; }

echo "compiling schema"
glib-compile-schemas --strict "$SRC/schemas"

mkdir -p "$DIST"
ZIP="$(pwd)/$DIST/$UUID.zip"
rm -f "$ZIP"

# Stage the exact layout EGO expects: metadata.json at the archive root, with
# schemas/ kept as a subdirectory.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/schemas"
cp "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" \
   "$SRC/stylesheet.css" "$STAGE/"
cp "$SRC/schemas/$SCHEMA.gschema.xml" \
   "$SRC/schemas/gschemas.compiled" "$STAGE/schemas/"
cp LICENSE "$STAGE/"

# -X strip extra file attributes, -9 max compression.
(cd "$STAGE" && zip -r -X -9 "$ZIP" . -x '.*' >/dev/null)

echo
echo "built $ZIP"
unzip -l "$ZIP"
