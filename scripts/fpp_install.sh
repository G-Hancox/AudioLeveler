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

# ffmpeg is declared in pluginInfo.json "dependencies", which FPP 10+ installs
# for us. FPP 9 and older ignore that block, so install it here as a fallback,
# only when it is missing. Standard FPP images already ship ffmpeg.
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ffmpeg not found, installing it" >> "$PLUGIN_LOG"
    apt-get -y -q install ffmpeg >> "$PLUGIN_LOG" 2>&1 || \
        echo "$(date '+%Y-%m-%d %H:%M:%S') ffmpeg install failed; the plugin page will say so" >> "$PLUGIN_LOG"
fi

DATADIR="${MEDIADIR}/plugindata/AudioLeveler"
mkdir -p "${DATADIR}/backups" "${DATADIR}/tmp"
chown -R "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "${DATADIR}" 2>/dev/null || true
chmod +x "$(dirname "$0")/../bin/leveler.py" 2>/dev/null || true

# FPP 10 and later load the plugin and its Start Job command as soon as it is
# installed. Older FPP only reads plugin commands when fppd starts: until then
# the page starts jobs itself, and FPP's restart banner asks for a restart.
# The version comes from fppd's API; if fppd can't be asked, a restart is
# requested to be safe.
FPP_MAJOR="$(curl -s -m 10 http://127.0.0.1/api/fppd/version 2>/dev/null | sed -n 's/.*"majorVersion" *: *\([0-9]*\).*/\1/p')"
if [ -z "${FPP_MAJOR}" ] || [ "${FPP_MAJOR}" -lt 10 ]; then
    setSetting restartFlag 1
fi

exit 0
