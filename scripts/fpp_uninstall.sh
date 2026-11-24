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
    python3 - "${EQFILE}" "${MEDIADIR}/config/pipewire-audio-groups.json" <<'PY' 2>>"$PLUGIN_LOG" || true
import json, os, sys, urllib.request
eq_path, groups = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(eq_path))
except Exception:
    sys.exit(0)
if not d.get("on"):
    sys.exit(0)
def api(method, path, body):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request("http://127.0.0.1/api/" + path, data=data, method=method)
    try:
        urllib.request.urlopen(req, timeout=20).read()
        return True
    except Exception as e:
        print("Audio EQ revert: %s %s failed: %s" % (method, path, e), file=sys.stderr)
        return False
def setting(name, value):
    # FPP's web server isn't answering: write FPP's settings file directly.
    if api("PUT", "settings/" + name, value.encode()):
        return
    path = os.path.join(os.path.dirname(os.path.dirname(groups)), "settings")
    try:
        lines = [l for l in open(path).read().splitlines() if l.split("=")[0].strip() != name]
    except FileNotFoundError:
        lines = []
    lines.append('%s = "%s"' % (name, value))
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(path + ".tmp", path)
if d.get("hadGroupsFile") and isinstance(d.get("prevGroups"), str):
    tmp = groups + ".tmp"
    with open(tmp, "w") as f:
        f.write(d["prevGroups"])
    os.replace(tmp, groups)
elif not d.get("hadGroupsFile"):
    try:
        os.unlink(groups)
    except FileNotFoundError:
        pass
if d.get("switchedBackend"):
    setting("MediaBackend", d.get("prevBackend") or "pipewire-simple")
    setting("rebootFlag", "1")
else:
    api("POST", "pipewire/audio/groups/apply", {})
print("Audio EQ was on: FPP's audio settings put back as they were")
PY
fi
curl -s -m 10 -X DELETE "http://127.0.0.1/api/playlist/AudioLeveler-Preview" >/dev/null 2>&1 || true

# A real uninstall removes the settings and working files, but keeps the
# backed-up originals: they are the only copy of the user's songs as they were
# before leveling. The help page says where they are, to delete when wanted.
rm -f "${MEDIADIR}/config/plugin.AudioLeveler"
if [ -d "${DATADIR}" ]; then
    rm -f "${DATADIR}/analysis.json" "${DATADIR}/leveled.json" "${DATADIR}/choices.json" "${DATADIR}/songinfo.json" "${DATADIR}/songinfo.lock" "${DATADIR}/auto.json" \
          "${DATADIR}/auto.last" "${DATADIR}/videoprobe.json" "${DATADIR}/job.json" "${DATADIR}/eq.json"
    rmdir "${DATADIR}/backups/videos" 2>/dev/null || true
    rmdir "${DATADIR}/backups" 2>/dev/null || true
    if ! rmdir "${DATADIR}" 2>/dev/null; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') Uninstalled; original songs and videos kept in ${DATADIR}/backups" >> "$PLUGIN_LOG"
        chown "${FPPUSER:-fpp}:${FPPGROUP:-fpp}" "$PLUGIN_LOG" 2>/dev/null || true
    fi
fi

exit 0
