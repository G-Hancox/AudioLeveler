#!/bin/bash
# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
set -e
# AudioLeveler uninstall script. Safe to run more than once.

: "${FPPDIR:=/opt/fpp}"
. "${FPPDIR}/scripts/common"
# Treat an unset variable as an error from here on (FPP's common script,
# above, isn't written for it).
set -u

PLUGIN_LOG="${LOGDIR}/plugin-AudioLeveler.log"
DATADIR="${MEDIADIR}/plugindata/AudioLeveler"

# Stop a job or video check that is still running.
pkill -f "AudioLeveler/bin/leveler.py" 2>/dev/null || true
pkill -f "AudioLeveler/bin/probe_videos.py" 2>/dev/null || true

if [ -d "${DATADIR}" ]; then
    rm -rf "${DATADIR}/tmp"
    rm -f "${DATADIR}/cancel" "${DATADIR}/worker.lock" "${DATADIR}/probe.lock" "${DATADIR}/start.lock" "${DATADIR}/autocheck.lock" \
          "${DATADIR}/launch.json" "${DATADIR}"/launch.*.json "${DATADIR}/request.json" "${DATADIR}"/*.tmp \
          "${DATADIR}"/*.tmp.*
fi

# A Reinstall (FPP sets FPP_PLUGIN_REINSTALL=1 from 10.4) keeps everything:
# settings, measurements, per-song fixes and the record of what was leveled.
if [ "${FPP_PLUGIN_REINSTALL:-0}" = "1" ]; then
    exit 0
fi

# A real uninstall puts FPP's audio back as it was if the Audio EQ is on
# (the same as unticking "EQ on"), and removes the temporary preview playlist.
EQFILE="${DATADIR}/eq.json"
if [ -f "${EQFILE}" ]; then
    # Through FPP's own API, as unticking Live does; FPP's files are never
    # written directly. If FPP's web server doesn't answer, the log says what
    # to put back by hand.
    python3 - "${EQFILE}" <<'PY' >>"$PLUGIN_LOG" 2>&1 || true
import json, sys, time, urllib.request
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if not d.get("on"):
    sys.exit(0)
stamp = time.strftime("%Y-%m-%d %H:%M:%S")
def api(method, path, body):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request("http://127.0.0.1/api/" + path, data=data, method=method,
                                 headers={"Content-Type": "application/json" if not isinstance(body, bytes) else "text/plain"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status == 200
    except Exception as e:
        print("%s Audio EQ: %s %s failed: %s" % (stamp, method, path, e))
        return False
prev = d.get("prevGroups")
if isinstance(prev, str):
    try:
        prev = json.loads(prev)
    except Exception:
        prev = None
if not isinstance(prev, dict) or not isinstance(prev.get("groups"), list):
    prev = {"groups": []}
ok = api("POST", "pipewire/audio/groups", prev)
back = d.get("prevBackend") if d.get("prevBackend") in ("pipewire-simple", "pipewire") else "pipewire-simple"
if d.get("switchedBackend"):
    ok = api("PUT", "settings/MediaBackend", back.encode()) and ok
    api("PUT", "settings/rebootFlag", b"1")
else:
    ok = api("POST", "pipewire/audio/groups/apply", {}) and ok
if ok:
    print("%s Audio EQ was live: FPP's audio settings put back as they were" % stamp)
else:
    print("%s Audio EQ was live and FPP couldn't be asked to put its audio back: set FPP Settings > Audio/Video > Media Backend to %s"
          " and remove the EQ from the Audio Output Group" % (stamp, "Simple" if back == "pipewire-simple" else "Advanced"))
PY
    chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
fi
curl -s -m 10 -X DELETE "http://127.0.0.1/api/playlist/AudioLeveler-Preview" >/dev/null 2>&1 || true

# A real uninstall removes the settings and working files, but keeps the
# backed-up originals: they are the only copy of the user's songs as they were
# before leveling. The help page says where they are, to delete when wanted.
rm -f "${MEDIADIR}/config/plugin.AudioLeveler"
if [ -d "${DATADIR}" ]; then
    rm -f "${DATADIR}/analysis.json" "${DATADIR}/leveled.json" "${DATADIR}/choices.json" "${DATADIR}/songinfo.json" "${DATADIR}/songinfo.lock" "${DATADIR}/auto.json" \
          "${DATADIR}/auto.last" "${DATADIR}/videoprobe.json" "${DATADIR}/job.json" "${DATADIR}/eq.json" "${DATADIR}/eq.lock"
    rmdir "${DATADIR}/backups/videos" 2>/dev/null || true
    rmdir "${DATADIR}/backups" 2>/dev/null || true
    if ! rmdir "${DATADIR}" 2>/dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') Uninstalled; original songs and videos kept in ${DATADIR}/backups" >> "$PLUGIN_LOG"
        chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
    fi
fi

exit 0
