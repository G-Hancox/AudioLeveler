#!/bin/bash
set -e
# AudioLeveler install script. Safe to run more than once.

: "${FPPDIR:=/opt/fpp}"
. "${FPPDIR}/scripts/common"

PLUGIN_LOG="${LOGDIR}/plugin-AudioLeveler.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') Installing Audio Leveler" >> "$PLUGIN_LOG"

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
chown -R fpp:fpp "${DATADIR}" 2>/dev/null || true
chmod +x "$(dirname "$0")/../bin/leveler.py" 2>/dev/null || true

exit 0
