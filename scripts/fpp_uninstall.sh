#!/bin/bash
set -e
# AudioLeveler uninstall script. Safe to run more than once.

: "${FPPDIR:=/opt/fpp}"
. "${FPPDIR}/scripts/common"

PLUGIN_LOG="${LOGDIR}/plugin-AudioLeveler.log"
DATADIR="${MEDIADIR}/plugindata/AudioLeveler"

# Stop a job that is still running.
pkill -f "AudioLeveler/bin/leveler.py" 2>/dev/null || true

# Remove working files, but keep the backed-up originals: they are the only
# copy of the user's songs as they were before leveling. The help page tells
# the user where they are so they can delete them when they want.
if [ -d "${DATADIR}" ]; then
    rm -rf "${DATADIR}/tmp"
    rm -f "${DATADIR}/analysis.json" "${DATADIR}/leveled.json" "${DATADIR}/job.json" \
          "${DATADIR}/request.json" "${DATADIR}/cancel" "${DATADIR}/worker.lock" \
          "${DATADIR}"/*.tmp
    if [ -d "${DATADIR}/backups" ] && [ -z "$(ls -A "${DATADIR}/backups")" ]; then
        rmdir "${DATADIR}/backups"
    fi
    if ! rmdir "${DATADIR}" 2>/dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') Uninstalled; original songs kept in ${DATADIR}/backups" >> "$PLUGIN_LOG"
        chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
    fi
fi

exit 0
