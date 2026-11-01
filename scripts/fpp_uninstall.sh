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
          "${DATADIR}/request.json" "${DATADIR}/launch.json" "${DATADIR}/cancel" "${DATADIR}/worker.lock" \
          "${DATADIR}"/*.tmp
    if [ -d "${DATADIR}/backups" ] && [ -z "$(ls -A "${DATADIR}/backups")" ]; then
        rmdir "${DATADIR}/backups"
    fi
    if ! rmdir "${DATADIR}" 2>/dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') Uninstalled; original songs kept in ${DATADIR}/backups" >> "$PLUGIN_LOG"
        chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
    fi
fi

# FPP 10 and later unload the plugin's command live; older FPP keeps listing it
# until fppd restarts.
FPP_MAJOR="$(curl -s -m 10 http://127.0.0.1/api/fppd/version 2>/dev/null | sed -n 's/.*"majorVersion" *: *\([0-9]*\).*/\1/p')"
if [ -z "${FPP_MAJOR}" ] || [ "${FPP_MAJOR}" -lt 10 ]; then
    setSetting restartFlag 1
fi

# The saved defaults (target, ceiling, leveling type...) are kept across a
# Reinstall (FPP sets FPP_PLUGIN_REINSTALL=1 from 10.4), and removed on a real
# uninstall.
if [ "${FPP_PLUGIN_REINSTALL:-0}" != "1" ]; then
    rm -f "${MEDIADIR}/config/plugin.AudioLeveler"
fi

exit 0
