#!/bin/bash
# Audio Leveler's fppd callbacks: lifecycle, plus playlist "stop" for
# automatic leveling of new songs (only when that's switched on). Having a callbacks
# script lets fppd load the plugin (and its "Start Job" command) straight
# after an install, with no restart. When fppd stops or unloads the plugin
# (to update or uninstall it), a running job is asked to stop after the song
# it is on, so no song is left half done. fppd waits for this, so it returns
# at once.

case "$1" in
    --list)
        echo "lifecycle,playlist"
        ;;
    --type)
        DATA="${MEDIADIR:-/home/fpp/media}/plugindata/AudioLeveler"
        HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [ "$2" = "lifecycle" ] && [ "$3" = "shutdown" ]; then
            [ -f "${DATA}/worker.lock" ] && touch "${DATA}/cancel" 2>/dev/null
        elif [ "$2" = "lifecycle" ] && [ "$3" = "startup" ]; then
            # Auto-level (if switched on): songs uploaded while fppd was down.
            "${HERE}/bin/auto_check.sh"
        elif [ "$2" = "playlist" ]; then
            # Only when a playlist stops: songs uploaded before or during the
            # show get leveled once it's over. The per-song "playing" calls
            # are ignored. auto_check.sh returns at once.
            if printf '%s' "$4" | grep -Eq '"Action"[[:space:]]*:[[:space:]]*"stop"'; then
                "${HERE}/bin/auto_check.sh"
            fi
        fi
        ;;
esac
exit 0
