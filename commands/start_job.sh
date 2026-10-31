#!/bin/bash
# FPP command "Audio Leveler: Start Job". The Audio Leveler page queues a job
# (plugindata/AudioLeveler/launch.json) and asks fppd to run this, so the
# worker runs under fppd rather than under the web server. fppd waits for this
# script and runs it as root, so it starts the worker in the background, as
# FPP's own user (the page shares the worker's files), and returns at once.
#
# Run on its own (from a playlist, say), it does nothing: only a job the page
# queued in the last 30 seconds is started.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${MEDIADIR:-/home/fpp/media}/plugindata/AudioLeveler"
LAUNCH="${DATA}/launch.json"

[ -f "${LAUNCH}" ] || exit 0
python3 -c 'import json, sys, time
j = json.load(open(sys.argv[1]))
sys.exit(0 if j.get("state") == "starting" and time.time() - float(j.get("requested", 0)) < 30 else 1)' \
    "${DATA}/job.json" 2>/dev/null || exit 0

RUN_AS=""
if [ "$(id -u)" = "0" ] && id fpp >/dev/null 2>&1; then
    RUN_AS="runuser -u fpp --"
    command -v runuser >/dev/null 2>&1 || RUN_AS="sudo -u fpp"
fi
PRIO="nice -n 19"
command -v ionice >/dev/null 2>&1 && PRIO="${PRIO} ionice -c 3"

# Started with only stdin, stdout and stderr open, so the worker holds on to
# nothing of fppd's for the hours a job can wait for the show to end.
(
    for fd in /proc/self/fd/*; do
        fd=${fd##*/}
        [ "${fd}" -gt 2 ] 2>/dev/null && eval "exec ${fd}>&-" 2>/dev/null
    done
    exec nohup setsid ${RUN_AS} ${PRIO} python3 "${PLUGIN_DIR}/bin/leveler.py" --launch "${LAUNCH}" \
        >/dev/null 2>&1 </dev/null
) &
exit 0
