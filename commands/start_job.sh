#!/bin/bash
# FPP command "Audio Leveler: Start Job". The Audio Leveler page asks fppd to
# run this, so all of the plugin's background work runs under fppd rather
# than under the web server. fppd waits for this script and runs it as root,
# so the work is started in the background, as FPP's own user (the page shares
# its files), and this returns at once. $1 is the Task:
#
#   Queued job (default)    the measuring/leveling/restoring job the page
#                           queued (launch.json). Run on its own, from a
#                           playlist say, it does nothing: only a job queued in
#                           the last 30 seconds is started.
#   Check videos for sound  bin/probe_videos.py, for videos not checked yet.
#   Level new uploads       bin/auto_check.sh (does nothing unless automatic
#                           leveling is switched on).

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${MEDIADIR:-/home/fpp/media}/plugindata/AudioLeveler"
LAUNCH="${DATA}/launch.json"
TASK="${1:-Queued job}"

if [ "${TASK}" = "Level new uploads" ]; then
    exec "${PLUGIN_DIR}/bin/auto_check.sh"   # returns at once; starts the worker itself
fi

RUN_AS=""
if [ "$(id -u)" = "0" ] && id fpp >/dev/null 2>&1; then
    RUN_AS="runuser -u fpp --"
    command -v runuser >/dev/null 2>&1 || RUN_AS="sudo -u fpp"
fi
PRIO="nice -n 19"
command -v ionice >/dev/null 2>&1 && PRIO="${PRIO} ionice -c 3"

# Start a command in the background with only stdin, stdout and stderr open,
# so it holds on to nothing of fppd's while it runs (a job can wait hours for
# a show to end).
detach() {
    (
        for fd in /proc/self/fd/*; do
            fd=${fd##*/}
            [ "${fd}" -gt 2 ] 2>/dev/null && eval "exec ${fd}>&-" 2>/dev/null
        done
        exec nohup setsid ${RUN_AS} ${PRIO} "$@" >/dev/null 2>&1 </dev/null
    ) &
}

case "${TASK}" in
    "Check videos for sound")
        # The videos folder comes from the settings the page saved (auto.json).
        VIDEOS="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("videos") or "")' \
            "${DATA}/auto.json" 2>/dev/null)"
        [ -n "${VIDEOS}" ] && [ -d "${VIDEOS}" ] || exit 0
        detach python3 "${PLUGIN_DIR}/bin/probe_videos.py" --videos "${VIDEOS}" --data "${DATA}"
        ;;
    "Queued job")
        [ -f "${LAUNCH}" ] || exit 0
        python3 -c 'import json, sys, time
j = json.load(open(sys.argv[1]))
sys.exit(0 if j.get("state") == "starting" and time.time() - float(j.get("requested", 0)) < 30 else 1)' \
            "${DATA}/job.json" 2>/dev/null || exit 0
        detach python3 "${PLUGIN_DIR}/bin/leveler.py" --launch "${LAUNCH}"
        ;;
esac
exit 0
