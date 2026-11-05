#!/bin/sh
# Startet die App als unprivilegierter Benutzer "node".
# Läuft der Container als root, wird das Datenverzeichnis einmalig dem Benutzer "node" zugewiesen,
# damit bestehende Daten (früher als root angelegt) weiter les- und schreibbar bleiben.
set -e

DATA="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ "$(stat -c %u "$DATA")" != "$(id -u node)" ]; then
    echo "Setze Besitzer von $DATA auf node (einmalig) ..."
    chown -R node:node "$DATA" || echo "WARNUNG: chown auf $DATA fehlgeschlagen - App kann evtl. nicht schreiben."
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
