#!/bin/bash
# Audio Leveler's fppd callbacks: only the lifecycle ones. Having a callbacks
# script lets fppd load the plugin (and its "Start Job" command) straight
# after an install, with no restart. When fppd stops or unloads the plugin
# (to update or uninstall it), a running job is asked to stop after the song
# it is on, so no song is left half done. fppd waits for this, so it returns
# at once.

case "$1" in
    --list)
        echo "lifecycle"
        ;;
    --type)
        if [ "$2" = "lifecycle" ] && [ "$3" = "shutdown" ]; then
            DATA="${MEDIADIR:-/home/fpp/media}/plugindata/AudioLeveler"
            [ -f "${DATA}/worker.lock" ] && touch "${DATA}/cancel" 2>/dev/null
        fi
        ;;
esac
exit 0
