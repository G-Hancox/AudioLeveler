#!/bin/bash
set -e
# AudioLeveler install script. Safe to run more than once.

: "${FPPDIR:=/opt/fpp}"
. "${FPPDIR}/scripts/common"

PLUGIN_LOG="${LOGDIR}/plugin-AudioLeveler.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') Installing Audio Leveler" >> "$PLUGIN_LOG"
# This script runs as root, but the page and the worker run as FPP's own user
# and append to the same log, so hand the file to that user.
chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true

# ffmpeg is declared in pluginInfo.json "dependencies"; FPP installs it (and
# standard FPP images already ship it).

DATADIR="${MEDIADIR}/plugindata/AudioLeveler"
mkdir -p "${DATADIR}/backups" "${DATADIR}/tmp"
chown -R "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "${DATADIR}" 2>/dev/null || true
chmod +x "$(dirname "$0")/../bin/leveler.py" 2>/dev/null || true

# No restart needed: FPP loads the plugin, its callbacks and its Start Job
# command as soon as it is installed.

exit 0
