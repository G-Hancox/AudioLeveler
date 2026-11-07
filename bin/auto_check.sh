#!/bin/bash
# Audio Leveler: look for new or replaced songs and level them, when
# "Level new and replaced songs automatically" is switched on.
#
# Called from the plugin's fppd callbacks (fppd starting, a playlist stopping)
# and by the Audio Leveler page when it opens. It must return at once: fppd
# waits for its callbacks. So it only checks the switch, skips if it ran in the
# last minute or a job is already running, and starts the worker in the
# background. The worker itself finds the new songs (and exits straight away
# if there are none) and waits until no show is playing before changing
# anything.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${MEDIADIR:-/home/fpp/media}/plugindata/AudioLeveler"
SETTINGS="${DATA}/auto.json"

# Off unless the page saved it on.
[ -f "${SETTINGS}" ] || exit 0
grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true' "${SETTINGS}" || exit 0

# At most one check a minute.
STAMP="${DATA}/auto.last"
if [ -f "${STAMP}" ] && [ $(( $(date +%s) - $(stat -c %Y "${STAMP}" 2>/dev/null || echo 0) )) -lt 60 ]; then
    exit 0
fi

# A job is already running (it holds the lock): nothing to do now.
if command -v flock >/dev/null 2>&1 && [ -f "${DATA}/worker.lock" ]; then
    flock -n "${DATA}/worker.lock" true 2>/dev/null || exit 0
fi

touch "${STAMP}" 2>/dev/null

RUN_AS=""
if [ "$(id -u)" = "0" ] && id fpp >/dev/null 2>&1; then
    chown fpp:fpp "${STAMP}" 2>/dev/null
    RUN_AS="runuser -u fpp --"
    command -v runuser >/dev/null 2>&1 || RUN_AS="sudo -u fpp"
fi
PRIO="nice -n 19"
command -v ionice >/dev/null 2>&1 && PRIO="${PRIO} ionice -c 3"

# Started with only stdin, stdout and stderr open, so the worker holds on to
# nothing of fppd's while it waits for a show to end.
(
    for fd in /proc/self/fd/*; do
        fd=${fd##*/}
        [ "${fd}" -gt 2 ] 2>/dev/null && eval "exec ${fd}>&-" 2>/dev/null
    done
    exec nohup setsid ${RUN_AS} ${PRIO} python3 "${PLUGIN_DIR}/bin/leveler.py" auto --data "${DATA}" \
        >/dev/null 2>&1 </dev/null
) &
exit 0
