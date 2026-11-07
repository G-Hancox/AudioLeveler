#!/bin/bash
set -e
# AudioLeveler uninstall script. Safe to run more than once.

: "${FPPDIR:=/opt/fpp}"
. "${FPPDIR}/scripts/common"

PLUGIN_LOG="${LOGDIR}/plugin-AudioLeveler.log"
DATADIR="${MEDIADIR}/plugindata/AudioLeveler"

# Stop a job or video check that is still running.
pkill -f "AudioLeveler/bin/leveler.py" 2>/dev/null || true
pkill -f "AudioLeveler/bin/probe_videos.py" 2>/dev/null || true

if [ -d "${DATADIR}" ]; then
    rm -rf "${DATADIR}/tmp"
    rm -f "${DATADIR}/cancel" "${DATADIR}/worker.lock" "${DATADIR}/probe.lock" "${DATADIR}/launch.json" \
          "${DATADIR}/request.json" "${DATADIR}"/*.tmp
fi

# A Reinstall (FPP sets FPP_PLUGIN_REINSTALL=1 from 10.4) keeps everything:
# settings, measurements, per-song fixes and the record of what was leveled.
if [ "${FPP_PLUGIN_REINSTALL:-0}" = "1" ]; then
    exit 0
fi

# A real uninstall removes the settings and working files, but keeps the
# backed-up originals: they are the only copy of the user's songs as they were
# before leveling. The help page says where they are, to delete when wanted.
rm -f "${MEDIADIR}/config/plugin.AudioLeveler"
if [ -d "${DATADIR}" ]; then
    rm -f "${DATADIR}/analysis.json" "${DATADIR}/leveled.json" "${DATADIR}/choices.json" "${DATADIR}/auto.json" \
          "${DATADIR}/auto.last" "${DATADIR}/videoprobe.json" "${DATADIR}/job.json"
    rmdir "${DATADIR}/backups/videos" 2>/dev/null || true
    rmdir "${DATADIR}/backups" 2>/dev/null || true
    if ! rmdir "${DATADIR}" 2>/dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') Uninstalled; original songs and videos kept in ${DATADIR}/backups" >> "$PLUGIN_LOG"
        chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
    fi
fi

exit 0
