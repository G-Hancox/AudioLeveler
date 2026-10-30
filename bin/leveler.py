#!/usr/bin/env python3
"""
Audio Leveler worker for FPP.

Measures the loudness of the songs in FPP's music folder and rewrites them to
a common level with ffmpeg. Runs as a background process started by api.php,
at low CPU/IO priority, one job at a time.

Commands:
    analyze  - measure loudness (EBU R128 integrated loudness + true peak)
    level    - level files to a target loudness
    restore  - put the backed-up originals back

Everything this script keeps lives in <mediadir>/plugindata/AudioLeveler/.
The only files it changes outside that folder are the songs you ask it to
level or restore, and it always writes a new file next to the old one and
swaps it in, so a song is never left half-written.
"""

import argparse
import fcntl
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

PLUGIN = "AudioLeveler"

AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".wav", ".flac"}

# Timing tolerance between the original and leveled file, in seconds. A
# leveled file that differs by more than this is thrown away rather than put
# in place, because sequences are timed to the audio.
MAX_LENGTH_DRIFT = 0.15

# Light compression used by the "compress" mode: gentle 2:1 above -20 dBFS
# with a soft knee, slow enough not to pump on drums.
COMPRESSOR = "acompressor=threshold=-20dB:ratio=2:attack=25:release=250:knee=6:makeup=1"

MODES = ("volume", "limit", "compress")


# --------------------------------------------------------------------------
# Small helpers


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def file_sig(path):
    st = os.stat(path)
    return {"size": st.st_size, "mtime": int(st.st_mtime)}


def same_sig(a, b):
    return a and b and a.get("size") == b.get("size") and a.get("mtime") == b.get("mtime")


def db_to_lin(db):
    return math.pow(10.0, db / 20.0)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def safe_name(name):
    """Song names come from the API; only accept plain names in the music folder."""
    if not name or name != os.path.basename(name) or name.startswith("."):
        return False
    return os.path.splitext(name)[1].lower() in AUDIO_EXTS


# --------------------------------------------------------------------------
# ffmpeg wrappers


def run(cmd, timeout=None):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=timeout)


def probe(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate,sample_fmt:format=bit_rate,duration",
             "-of", "json", path], timeout=120)
    if r.returncode != 0:
        raise RuntimeError("ffprobe could not read this file")
    j = json.loads(r.stdout or "{}")
    streams = j.get("streams") or []
    if not streams:
        raise RuntimeError("no audio stream found")
    s = streams[0]
    fmt = j.get("format") or {}
    br = s.get("bit_rate") or fmt.get("bit_rate") or 0
    return {
        "codec": s.get("codec_name", ""),
        "sr": int(s.get("sample_rate") or 44100),
        "ch": int(s.get("channels") or 2),
        "fmt": s.get("sample_fmt", ""),
        "br": int(int(br) / 1000) if str(br).isdigit() else 0,
    }


_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def decoded_length(stderr):
    """Length ffmpeg actually decoded, from its final progress line."""
    m = None
    for m in _TIME_RE.finditer(stderr):
        pass
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def measure(path, prefilter=None):
    """EBU R128 integrated loudness + true peak via ffmpeg's loudnorm analyser."""
    af = "loudnorm=I=-14:TP=-1:LRA=11:print_format=json"
    if prefilter:
        af = prefilter + "," + af
    r = run(["ffmpeg", "-hide_banner", "-nostdin", "-stats", "-i", path, "-vn",
             "-map", "0:a:0", "-af", af, "-f", "null", "-"])
    if r.returncode != 0:
        raise RuntimeError("ffmpeg could not decode this file")
    err = r.stderr
    start, end = err.rfind("{"), err.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("no loudness measurement returned")
    j = json.loads(err[start:end + 1])

    def num(k):
        v = j.get(k)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        return None if math.isinf(v) or math.isnan(v) else round(v, 2)

    return {
        "I": num("input_i"),
        "TP": num("input_tp"),
        "LRA": num("input_lra"),
        "len": decoded_length(err),
    }


ENCODERS = None


def have_encoder(name):
    global ENCODERS
    if ENCODERS is None:
        r = run(["ffmpeg", "-hide_banner", "-encoders"], timeout=60)
        ENCODERS = r.stdout
    return re.search(r"\s%s\s" % re.escape(name), ENCODERS) is not None


def codec_args(ext, info):
    """Encoder settings that keep the file's format, sample rate and quality."""
    br = info.get("br") or 0
    if ext == ".mp3":
        # 192k minimum: re-encoding a 128k file at 128k audibly dulls it.
        kbps = clamp(br or 320, 192, 320)
        return ["-c:a", "libmp3lame", "-b:a", "%dk" % kbps, "-id3v2_version", "3"]
    if ext in (".m4a", ".aac"):
        kbps = clamp(br or 256, 160, 320)
        args = ["-c:a", "aac", "-b:a", "%dk" % kbps]
        if ext == ".aac":
            args += ["-f", "adts"]
        else:
            args += ["-movflags", "+faststart"]
        return args
    if ext in (".ogg", ".oga"):
        if not have_encoder("libvorbis"):
            raise RuntimeError("this FPP's ffmpeg cannot write Ogg Vorbis")
        return ["-c:a", "libvorbis", "-q:a", "6"]
    if ext == ".flac":
        return ["-c:a", "flac"]
    if ext == ".wav":
        pcm = {"s16": "pcm_s16le", "s16p": "pcm_s16le", "s32": "pcm_s32le",
               "s32p": "pcm_s32le", "flt": "pcm_f32le", "fltp": "pcm_f32le",
               "u8": "pcm_u8"}.get(info.get("fmt"), "pcm_s16le")
        if info.get("codec", "").startswith("pcm_s24"):
            pcm = "pcm_s24le"
        return ["-c:a", pcm]
    raise RuntimeError("unsupported file type")


# --------------------------------------------------------------------------
# FPP status


def fpp_status():
    try:
        with urllib.request.urlopen("http://127.0.0.1/api/fppd/status", timeout=5) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        # fppd not running (or the API not answering) means nothing is playing.
        return {}


def show_running(st):
    return st.get("status_name") not in (None, "", "idle")


def now_playing(st):
    return st.get("current_song") or st.get("media_filename") or ""


# --------------------------------------------------------------------------
# The worker


class Worker:
    def __init__(self, args):
        self.music = args.music.rstrip("/")
        self.data = args.data.rstrip("/")
        self.backups = os.path.join(self.data, "backups")
        self.tmpdir = os.path.join(self.data, "tmp")
        for d in (self.data, self.backups, self.tmpdir):
            os.makedirs(d, exist_ok=True)
        self.analysis_path = os.path.join(self.data, "analysis.json")
        self.leveled_path = os.path.join(self.data, "leveled.json")
        self.job_path = os.path.join(self.data, "job.json")
        self.cancel_path = os.path.join(self.data, "cancel")
        self.analysis = read_json(self.analysis_path, {})
        self.leveled = read_json(self.leveled_path, {})
        self.job = read_json(self.job_path, {})
        self.req = read_json(args.request, {}) if args.request else {}
        self.cmd = args.command

    # -- job status shown on the page ------------------------------------

    def save_job(self, **kw):
        self.job.update(kw)
        self.job["updated"] = now()
        write_json(self.job_path, self.job)

    def result(self, name, ok, msg):
        self.job.setdefault("results", []).append({"file": name, "ok": ok, "msg": msg})
        (logging.info if ok else logging.warning)("%s: %s", name, msg)

    def cancelled(self):
        return os.path.exists(self.cancel_path)

    def wait_for_idle(self, name):
        """Hold off while a show is playing, unless the user said not to."""
        wait = self.req.get("waitIdle", True)
        announced = False
        while True:
            if self.cancelled():
                return False
            st = fpp_status()
            playing = now_playing(st)
            if not show_running(st):
                break
            if not wait and playing != name:
                break
            if not announced:
                why = ("this song is playing right now" if playing == name
                       else "a show is playing")
                logging.info("Waiting: %s", why)
                announced = True
            self.save_job(state="waiting",
                          message="Paused until the show stops (%s)." %
                          ("this song is playing" if playing == name else "a show is playing"))
            time.sleep(15)
        if self.job.get("state") == "waiting":
            self.save_job(state="running", message="")
        return True

    # -- per-file bookkeeping --------------------------------------------

    def files_requested(self):
        listed = sorted(f for f in os.listdir(self.music) if safe_name(f)
                        and os.path.isfile(os.path.join(self.music, f)))
        want = self.req.get("files", "all")
        if want == "all" or not isinstance(want, list):
            return listed
        have = set(listed)
        return [f for f in want if f in have]

    def backup_path(self, name):
        return os.path.join(self.backups, name)

    def original_for(self, name):
        """
        The best source to level from. If we leveled this song before and it is
        still our file, start again from the backed-up original so repeated runs
        never stack up encoding loss. If the song was replaced since (a new
        upload), the current file is the new original.
        """
        path = os.path.join(self.music, name)
        bpath = self.backup_path(name)
        rec = self.leveled.get(name)
        if os.path.exists(bpath) and rec and same_sig(rec, file_sig(path)):
            return bpath, True
        return path, False

    def analyze_one(self, name, force=False):
        path = os.path.join(self.music, name)
        sig = file_sig(path)
        cached = self.analysis.get(name)
        if not force and cached and same_sig(cached, sig) and cached.get("I") is not None:
            return cached
        info = probe(path)
        m = measure(path)
        entry = dict(sig)
        entry.update(info)
        entry.update(m)
        entry["measured"] = now()
        self.analysis[name] = entry
        write_json(self.analysis_path, self.analysis)
        return entry

    # -- commands --------------------------------------------------------

    def cmd_analyze(self):
        files = self.files_requested()
        force = bool(self.req.get("force"))
        self.save_job(total=len(files))
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            try:
                e = self.analyze_one(name, force)
                self.result(name, True, "%.1f LUFS, peak %.1f dBTP" % (e["I"], e["TP"])
                            if e.get("I") is not None else "silent")
            except Exception as ex:
                self.result(name, False, str(ex))
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def plan_gain(self, I, TP, target, ceiling, mode):
        """Gain in dB, and whether a limiter is needed to keep peaks under the ceiling."""
        gain = target - I
        if mode == "volume":
            if TP is not None and TP + gain > ceiling:
                return ceiling - TP, False
            return gain, False
        need_limit = TP is not None and TP + gain > ceiling
        return gain, need_limit

    def build_filter(self, gain, limit, ceiling, sr, mode):
        parts = []
        if mode == "compress":
            parts.append(COMPRESSOR)
        parts.append("volume=%.2fdB" % gain)
        if limit:
            # Oversample 4x so the limiter catches peaks between samples
            # (true peak), then come back to the file's own sample rate.
            lin = clamp(db_to_lin(ceiling - 0.1), 0.0625, 1.0)
            parts.append("aresample=%d" % (sr * 4))
            parts.append("alimiter=limit=%.4f:attack=5:release=60:level=0:latency=1" % lin)
            parts.append("aresample=%d" % sr)
        return ",".join(parts)

    def level_one(self, name, target, ceiling, mode, keep_backup):
        path = os.path.join(self.music, name)
        ext = os.path.splitext(name)[1].lower()
        src, from_backup = self.original_for(name)

        info = probe(src)
        pre = COMPRESSOR if mode == "compress" else None
        m = measure(src, pre)
        before = m["I"] if not pre else measure(src)["I"]
        if m["I"] is None:
            return False, "skipped: song is silent or too short to measure"

        gain, limit = self.plan_gain(m["I"], m["TP"], target, ceiling, mode)
        if abs(gain) < 0.1 and not limit and mode != "compress":
            if not from_backup:
                return True, "already at %.1f LUFS, left as is" % m["I"]

        tmp = os.path.join(self.tmpdir, "leveling" + ext)
        expected = target if mode != "volume" else m["I"] + gain
        out = None
        for attempt in (1, 2):
            af = self.build_filter(gain, limit, ceiling, info["sr"], mode)
            cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", src, "-vn",
                   "-map", "0:a:0", "-map_metadata", "0", "-af", af,
                   "-ar", str(info["sr"]), "-ac", str(info["ch"])] + codec_args(ext, info) + [tmp]
            r = run(cmd)
            if r.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
                tail = (r.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
                if os.path.exists(tmp):
                    os.remove(tmp)
                return False, "ffmpeg failed: " + tail[0]
            # Check the new file before it goes anywhere near the show.
            out = measure(tmp)
            miss = None if out["I"] is None else expected - out["I"]
            # The encoder or limiter can shift loudness a little; one corrective
            # pass brings it back on target. Volume-only mode can't go up past
            # its peak headroom, so it only ever corrects downward.
            if attempt == 2 or miss is None or abs(miss) <= 0.3:
                break
            if mode == "volume" and miss > 0:
                break
            gain += miss
            if mode != "volume":
                limit = m["TP"] is not None and m["TP"] + gain > ceiling
        if m["len"] and out["len"] and abs(out["len"] - m["len"]) > MAX_LENGTH_DRIFT:
            os.remove(tmp)
            return False, ("not changed: the leveled file came out %.2fs %s, which "
                           "would throw off the sequence timing" %
                           (abs(out["len"] - m["len"]),
                            "longer" if out["len"] > m["len"] else "shorter"))

        # Don't swap a song while it's playing.
        if not self.wait_for_idle(name):
            os.remove(tmp)
            return False, "cancelled"

        # Keep the original the first time we touch this song.
        bpath = self.backup_path(name)
        if keep_backup and not from_backup:
            shutil.copy2(path, bpath + ".part")
            os.replace(bpath + ".part", bpath)

        st = os.stat(path)
        try:
            os.replace(tmp, path)
        except OSError:
            # Different filesystem (media on USB): copy then rename in place.
            shutil.copyfile(tmp, path + ".leveling")
            os.replace(path + ".leveling", path)
            os.remove(tmp)
        try:
            os.chmod(path, st.st_mode & 0o777)
            if os.geteuid() == 0:
                os.chown(path, st.st_uid, st.st_gid)
        except OSError:
            pass

        sig = file_sig(path)
        self.leveled[name] = dict(sig, target=target, ceiling=ceiling, mode=mode,
                                  gain=round(gain, 2), limited=limit, at=now(),
                                  backup=os.path.exists(bpath))
        write_json(self.leveled_path, self.leveled)
        entry = dict(sig)
        entry.update(probe(path))
        entry.update(out)
        entry["measured"] = now()
        self.analysis[name] = entry
        write_json(self.analysis_path, self.analysis)

        before = "%.1f" % before if before is not None else "?"
        note = ""
        if mode == "volume" and target - (out["I"] if out["I"] is not None else target) > 0.3:
            note = " (held back by peaks; try the limiter mode to go louder)"
        elif limit:
            note = " (limiter caught the peaks)"
        return True, "%s -> %.1f LUFS, %+.1f dB%s" % (before, out["I"] if out["I"] is not None else target,
                                                     gain, note)

    def cmd_level(self):
        target = clamp(float(self.req.get("target", -14)), -30.0, -6.0)
        ceiling = clamp(float(self.req.get("ceiling", -1)), -6.0, 0.0)
        mode = self.req.get("mode", "limit")
        if mode not in MODES:
            mode = "limit"
        keep = bool(self.req.get("backup", True))
        files = self.files_requested()
        self.save_job(total=len(files), target=target, ceiling=ceiling, mode=mode)
        logging.info("Leveling %d file(s) to %.1f LUFS, ceiling %.1f dBTP, mode %s, backups %s",
                     len(files), target, ceiling, mode, "on" if keep else "off")
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            if not self.wait_for_idle(name) and self.cancelled():
                break
            try:
                ok, msg = self.level_one(name, target, ceiling, mode, keep)
            except Exception as ex:
                ok, msg = False, str(ex)
            self.result(name, ok, msg)
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def cmd_restore(self):
        files = [f for f in self.files_requested_or_backups()]
        self.save_job(total=len(files))
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            bpath = self.backup_path(name)
            if not os.path.exists(bpath):
                self.result(name, False, "no backup to restore")
                continue
            if not self.wait_for_idle(name):
                break
            path = os.path.join(self.music, name)
            shutil.copy2(bpath, path + ".restoring")
            os.replace(path + ".restoring", path)
            self.leveled.pop(name, None)
            write_json(self.leveled_path, self.leveled)
            self.analysis.pop(name, None)
            try:
                self.analyze_one(name, True)
            except Exception:
                pass
            self.result(name, True, "original restored")
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def files_requested_or_backups(self):
        have = sorted(f for f in os.listdir(self.backups) if safe_name(f))
        want = self.req.get("files", "all")
        if want == "all" or not isinstance(want, list):
            return have
        return [f for f in want if f in have]

    def run(self):
        if os.path.exists(self.cancel_path):
            os.remove(self.cancel_path)
        self.job = {"cmd": self.cmd, "state": "running", "started": now(), "done": 0,
                    "total": 0, "current": "", "message": "", "results": [], "pid": os.getpid()}
        self.save_job()
        try:
            getattr(self, "cmd_" + self.cmd)()
            state = "cancelled" if self.cancelled() else "done"
            self.save_job(state=state, current="", message="", finished=now())
        except Exception as ex:
            logging.exception("Job failed")
            self.save_job(state="error", message=str(ex), finished=now())
        finally:
            for f in os.listdir(self.tmpdir):
                try:
                    os.remove(os.path.join(self.tmpdir, f))
                except OSError:
                    pass
            if os.path.exists(self.cancel_path):
                os.remove(self.cancel_path)


def main():
    ap = argparse.ArgumentParser(description="FPP Audio Leveler worker")
    ap.add_argument("command", choices=("analyze", "level", "restore"))
    ap.add_argument("--music", required=True, help="FPP music folder")
    ap.add_argument("--data", required=True, help="plugindata folder for this plugin")
    ap.add_argument("--log", help="log file (defaults to stderr)")
    ap.add_argument("--request", help="JSON file with the job options")
    args = ap.parse_args()

    logging.basicConfig(filename=args.log, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    os.makedirs(args.data, exist_ok=True)
    lock = open(os.path.join(args.data, "worker.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        logging.warning("Another Audio Leveler job is already running; not starting a second one.")
        return 1

    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            write_json(os.path.join(args.data, "job.json"),
                       {"cmd": args.command, "state": "error", "finished": now(),
                        "message": "%s is not installed on this FPP." % tool, "results": []})
            logging.error("%s not found", tool)
            return 1

    Worker(args).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
