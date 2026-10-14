#!/bin/bash
# Installed as /usr/local/bin/wine inside the build container ONLY.
#
# On this Apple Silicon host Docker runs 32-bit x86 code under qemu-i386, which does not fill
# in the trap number of a signal. 32-bit wine then dies at PROCESS EXIT ("Got unexpected trap
# -1" / "nested exception on signal stack") — after WiX's candle/light have already written
# their output — and returns 1, which stops electron-builder. Tolerate exactly that, and only
# when the expected output file was (re)written during this run and looks complete.
real=/opt/wine-stable/bin/wine
case "$1" in
  *candle.exe|*light.exe) ;;
  *) exec "$real" "$@" ;;
esac

marker=$(mktemp); outf=$(mktemp); errf=$(mktemp)
touch "$marker"
"$real" "$@" >"$outf" 2>"$errf"
rc=$?
cat "$outf"; cat "$errf" >&2

if [ $rc -ne 0 ] && grep -q "nested exception on signal stack" "$errf" \
   && ! grep -Eq "error (CNDL|LGHT|WIX)[0-9]+" "$outf"; then
  out=""
  case "$1" in
    *candle.exe)
      out=$(find . -maxdepth 1 -name '*.wixobj' -newer "$marker" | head -1)
      if [ -n "$out" ] && tail -c 20 "$out" | grep -q "</wixObject>"; then
        echo "[wine-wrapper] candle: qemu exit crash tolerated, $out complete" >&2; rc=0
      fi ;;
    *light.exe)
      prev=""; for a in "$@"; do [ "$prev" = "-out" ] && out="$a"; prev="$a"; done
      out=$(printf '%s' "$out" | sed -e 's/^[Zz]://' -e 's#\\#/#g')
      if [ -s "$out" ] && [ "$out" -nt "$marker" ] && msiinfo suminfo "$out" >/dev/null 2>&1 \
         && grep -q "^Moving file .* to '" "$outf"; then
        echo "[wine-wrapper] light: qemu exit crash tolerated, $out complete" >&2; rc=0
      fi ;;
  esac
fi
rm -f "$marker" "$outf" "$errf"
exit $rc
