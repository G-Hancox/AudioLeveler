#!/usr/bin/env python3
# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
"""
Audio Leveler worker for FPP.

Measures the loudness of the songs in FPP's music folder (and the sound of
the videos in its videos folder) and levels them to a common loudness. Runs as a background process started by api.php,
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
import logging.handlers
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

# Our own helper module sits next to this script; add the folder explicitly so
# it is found however Python is started (isolated mode drops the script dir).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mp3lossless  # noqa: E402
import id3tags  # noqa: E402

PLUGIN = "AudioLeveler"

AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".wav", ".flac"}

# Videos are named "videos/<file>" everywhere (the page, our JSON files and
# FPP's media_gain.json alike), so they never clash with a song's name.
# ffmpeg's AAC encoder starts every stream with 1024 samples of lead-in.
AAC_LEAD_IN = 1024

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
VIDEO_PREFIX = "videos/"

# Timing tolerance between the original and leveled file, in seconds. A
# leveled file that differs by more than this is thrown away rather than put
# in place, because sequences are timed to the audio.
MAX_LENGTH_DRIFT = 0.15

# A song already within this many dB of the target is left as it is: the
# difference is inaudible and not worth an encode.
NEAR_TARGET_DB = 0.5

# Light compression used by the "compress" mode: gentle 2:1 above -20 dBFS
# with a soft knee, slow enough not to pump on drums.
COMPRESSOR = "acompressor=threshold=-20dB:ratio=2:attack=25:release=250:knee=6:makeup=1"

MODES = ("auto", "volume", "limit", "compress")

# Per-song choices the page can save (choices.json). "default" follows the
# leveling type in the settings.
CHOICES = ("default", "auto", "volume", "limit", "compress", "background", "skip")

# Quality first: the limiter is only recommended when reaching the target
# takes no more than this much peak reduction, which stays inaudible. Beyond
# that the recommendation is a plain volume change that lands a bit quieter.
GENTLE_LIMIT_DB = 3.0

# A plain volume change that lands within this of the target is preferred
# over limiting, and peak readings within this tolerance count as "at" the
# ceiling.
VOLUME_CLOSE_DB = 1.0
PEAK_TOLERANCE_DB = 0.1

# Notes shown with a recommendation (never acted on automatically).
WIDE_DYNAMICS_LU = 15.0     # loudness range above this: compression could help outdoors
LONG_TRACK_SECONDS = 900    # longer than 15 minutes: probably ambiance / background


def recommend(I, TP, target, ceiling):
    """
    The quality-first fix for a song: "none" (close enough), "volume" (a plain
    volume change, lossless for MP3s), or "limit" (gentle peak limiting).
    Compression is never recommended; the user picks it if they want it.
    The page has a JavaScript copy of this for display; keep them in step.
    """
    if I is None:
        return "none"
    gain = target - I
    # How far the peaks would go over the ceiling at the target level. A
    # tenth of a dB is measurement noise.
    over = None if TP is None else TP + gain - ceiling
    if over is None or over <= PEAK_TOLERANCE_DB:
        return "none" if abs(gain) < NEAR_TARGET_DB else "volume"
    # A plain volume change has to stop where the peaks reach the ceiling,
    # 'over' dB short of the target. Close enough: no limiter needed.
    if over <= VOLUME_CLOSE_DB:
        return "volume"
    if over <= GENTLE_LIMIT_DB:
        return "limit"
    return "volume"


# --------------------------------------------------------------------------
# Small helpers


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def read_json(path, default):
    """The file's JSON, or default if it's missing, damaged or the wrong shape
    (PHP writes an empty map as [], for one)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return default
    if isinstance(default, dict) and not isinstance(data, dict):
        return {} if data in ([], None) else default
    return data


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


def is_video(name):
    return name.startswith(VIDEO_PREFIX)


def safe_name(name):
    """
    Names come from the API; only accept a plain name in the music folder, or
    "videos/" + a plain name in the videos folder.
    """
    if not name:
        return False
    exts = AUDIO_EXTS
    if is_video(name):
        name, exts = name[len(VIDEO_PREFIX):], VIDEO_EXTS
    if not name or name != os.path.basename(name) or name.startswith("."):
        return False
    return os.path.splitext(name)[1].lower() in exts


# --------------------------------------------------------------------------
# ffmpeg wrappers


class Cancelled(Exception):
    """The user pressed Cancel; stop the current song right away."""


class NoAudio(Exception):
    """A video with no sound track: nothing to level."""


# Set by the worker: a file whose appearance means "cancel now".
CANCEL_FILE = None


def run(cmd, timeout=None):
    """
    Run a command and collect its output, but stop it within half a second if
    the user cancels: a song can take minutes, and Cancel should not have to
    wait for it. Stopping is always safe: measuring only reads, and leveling
    writes to a temporary file that is only swapped in after it's checked.
    """
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         universal_newlines=True)
    started = time.time()
    out_parts, err_parts = [], []
    while True:
        try:
            out, err = p.communicate(timeout=0.5)
            out_parts.append(out or "")
            err_parts.append(err or "")
            break
        except subprocess.TimeoutExpired:
            if (CANCEL_FILE and os.path.exists(CANCEL_FILE)) or (
                    timeout is not None and time.time() - started > timeout):
                p.kill()
                p.communicate()
                if timeout is not None and time.time() - started > timeout and not (
                        CANCEL_FILE and os.path.exists(CANCEL_FILE)):
                    raise subprocess.TimeoutExpired(cmd, timeout)
                raise Cancelled()
    return subprocess.CompletedProcess(cmd, p.returncode, "".join(out_parts), "".join(err_parts))


def probe(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate,sample_fmt:format=bit_rate,duration",
             "-of", "json", path], timeout=120)
    if r.returncode != 0:
        raise RuntimeError("ffprobe could not read this file")
    j = json.loads(r.stdout or "{}")
    streams = j.get("streams") or []
    if not streams:
        raise NoAudio("no sound track")
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


# Speaker matching (as FPP's Normalize does it): outdoor speakers and FM
# barely reproduce deep bass, so a bass-heavy song can read "on target" yet
# sound quieter outside. Its "speaker level" is the median short-term loudness
# with everything under 120 Hz removed, skipping the first 3 s and near
# silence. A song is then aimed SPEAKER_OFFSET_DB under that, but never more
# than SPEAKER_MAX_DEV_DB from where plain LUFS would put it.
SPEAKER_HIGHPASS = "highpass=f=120,highpass=f=120"
SPEAKER_OFFSET_DB = 3.0
SPEAKER_MAX_DEV_DB = 4.0
_SPK_RE = re.compile(r"lavfi\.r128\.S=(-?[\d.]+)")


def speaker_level(stdout):
    vals = []
    for i, v in enumerate(_SPK_RE.findall(stdout or "")):
        if i < 30:
            continue  # first 3 s: the 3 s window isn't full yet
        f = float(v)
        if f > -50:
            vals.append(f)
    if len(vals) < 50:
        return None  # under ~5 s of sound: plain LUFS is used instead
    vals.sort()
    n = len(vals)
    return round(vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2, 2)


def speaker_delta(m):
    """How far speaker matching moves this song's target (0 without a speaker level)."""
    if not m or m.get("spk") is None or m.get("I") is None:
        return 0.0
    return clamp(m["I"] - m["spk"] - SPEAKER_OFFSET_DB, -SPEAKER_MAX_DEV_DB, SPEAKER_MAX_DEV_DB)


def spk_note(delta):
    return " (speaker match %+.1f dB)" % delta if abs(delta) >= 0.05 else ""


_FRAMELOG_OK = True


def measure(path, prefilter=None, speakers=False):
    """
    EBU R128 integrated loudness + true peak via ffmpeg's loudnorm analyser,
    and, with speakers=True, the speaker level from the same decode pass.
    """
    global _FRAMELOG_OK
    af = "loudnorm=I=-14:TP=-1:LRA=11:print_format=json"
    if prefilter:
        af = prefilter + "," + af
    if speakers and not prefilter:
        eb = "ebur128=metadata=1" + (":framelog=verbose" if _FRAMELOG_OK else "")
        graph = ("[0:a:0]asplit=2[m][s];[m]%s[mo];[s]%s,%s,"
                 "ametadata=mode=print:key=lavfi.r128.S:file=-,anullsink" % (af, SPEAKER_HIGHPASS, eb))
        r = run(["ffmpeg", "-hide_banner", "-nostdin", "-stats", "-i", path, "-vn",
                 "-filter_complex", graph, "-map", "[mo]", "-f", "null", "-"])
        if r.returncode != 0 and _FRAMELOG_OK and "framelog" in (r.stderr or ""):
            _FRAMELOG_OK = False
            return measure(path, prefilter, speakers)
    else:
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

    out = {
        "I": num("input_i"),
        "TP": num("input_tp"),
        "LRA": num("input_lra"),
        "len": decoded_length(err),
    }
    if speakers and not prefilter:
        out["spk"] = speaker_level(r.stdout)
    return out


ENCODERS = None


def have_encoder(name):
    global ENCODERS
    if ENCODERS is None:
        r = run(["ffmpeg", "-hide_banner", "-encoders"], timeout=60)
        ENCODERS = r.stdout
    return re.search(r"\s%s\s" % re.escape(name), ENCODERS) is not None


_SOXR = None


def have_soxr():
    """Whether this ffmpeg has the SoX resampler (cleaner than the default)."""
    global _SOXR
    if _SOXR is None:
        r = run(["ffmpeg", "-hide_banner", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=44100",
                 "-t", "0.05", "-af", "aresample=88200:resampler=soxr", "-f", "null", "-"], timeout=60)
        _SOXR = r.returncode == 0
    return _SOXR


def resample(rate):
    if have_soxr():
        return "aresample=%d:resampler=soxr:precision=28" % rate
    return "aresample=%d" % rate


def needs_dither(ext, info):
    """16-bit or 8-bit PCM output gets dither when it's cut down from float."""
    return ext == ".wav" and not info.get("codec", "").startswith(("pcm_s24", "pcm_s32", "pcm_f"))


def codec_args(ext, info):
    """Encoder settings that keep the file's format, sample rate and quality."""
    br = info.get("br") or 0
    if ext == ".mp3":
        # When an MP3 has to be re-encoded, do it at MP3's best: 320 kbps with
        # LAME's most careful (slowest) algorithm, compression_level 0 = lame -q 0.
        return ["-c:a", "libmp3lame", "-b:a", "320k", "-compression_level", "0",
                "-id3v2_version", "3"]
    if ext in (".m4a", ".aac"):
        # ffmpeg's built-in AAC encoder needs a generous bitrate to stay clean.
        kbps = clamp(br or 256, 256, 320)
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


def video_codec_args(ext, info):
    """
    For a video: the picture (and subtitles) are copied untouched; only the
    sound is re-encoded, at a generous bitrate, in a codec the container takes.
    """
    br = info.get("br") or 0
    if ext == ".webm":
        if have_encoder("libopus"):
            return ["-c:a:0", "libopus", "-b:a:0", "%dk" % clamp(br or 192, 192, 320)]
        if have_encoder("libvorbis"):
            return ["-c:a:0", "libvorbis", "-q:a:0", "7"]
        raise RuntimeError("this FPP's ffmpeg cannot write WebM sound")
    if ext == ".avi":
        return ["-c:a:0", "libmp3lame", "-b:a:0", "320k", "-compression_level", "0"]
    args = ["-c:a:0", "aac", "-b:a:0", "%dk" % clamp(br or 256, 256, 320)]
    if ext in (".mp4", ".m4v", ".mov"):
        args += ["-movflags", "+faststart"]
    return args


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
        self.videos = (getattr(args, "videos", None) or "").rstrip("/")
        self.data = args.data.rstrip("/")
        self.backups = os.path.join(self.data, "backups")
        self.tmpdir = os.path.join(self.data, "tmp")
        for d in (self.data, self.backups, os.path.join(self.backups, "videos"), self.tmpdir):
            os.makedirs(d, exist_ok=True)
        self.analysis_path = os.path.join(self.data, "analysis.json")
        self.leveled_path = os.path.join(self.data, "leveled.json")
        self.job_path = os.path.join(self.data, "job.json")
        self.cancel_path = os.path.join(self.data, "cancel")
        global CANCEL_FILE
        CANCEL_FILE = self.cancel_path
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
        announced = False
        while True:
            if self.cancelled():
                return False
            wait = self.wait_idle_now()
            st = fpp_status()
            playing = now_playing(st)
            here = os.path.basename(name)
            if not show_running(st):
                break
            if not wait and playing != os.path.basename(name):
                break
            if not announced:
                why = ("this song is playing right now" if playing == here
                       else "a show is playing")
                logging.info("Waiting: %s", why)
                announced = True
            msg = "Paused until the show stops (%s)." % (
                "this song is playing" if playing == here else "a show is playing")
            if wait and self.cmd != "auto":
                msg += " Untick \u201cWait until no show is playing\u201d to carry on now."
            self.save_job(state="waiting", message=msg)
            time.sleep(5)
        if self.job.get("state") == "waiting":
            self.save_job(state="running", message="")
        return True

    def wait_idle_now(self):
        """
        Whether to wait for the show to end, as the setting is right now: the
        page saves it to auto.json the moment it changes, so unticking it
        while a job waits lets the job carry on. Automatic leveling always
        waits.
        """
        if self.cmd == "auto":
            return True
        saved = read_json(os.path.join(self.data, "auto.json"), {})
        if "waitIdle" in saved:
            return bool(saved["waitIdle"])
        return self.req.get("waitIdle", True)

    # -- per-file bookkeeping --------------------------------------------

    def path_of(self, name):
        if is_video(name):
            return os.path.join(self.videos, name[len(VIDEO_PREFIX):])
        return os.path.join(self.music, name)

    def all_media(self):
        """Every song, then every video (when videos are included), by name."""
        out = sorted(f for f in os.listdir(self.music) if safe_name(f)
                     and os.path.isfile(os.path.join(self.music, f)))
        if self.videos and os.path.isdir(self.videos):
            vids = sorted(VIDEO_PREFIX + f for f in os.listdir(self.videos)
                          if safe_name(VIDEO_PREFIX + f) and os.path.isfile(os.path.join(self.videos, f)))
            out += [v for v in vids if not self.known_silent(v)]
        return out

    def known_silent(self, name):
        """A video already found to have no sound track (by the page or a measurement): skipped."""
        sig = file_sig(self.path_of(name))
        a = self.analysis.get(name)
        if a and same_sig(a, sig):
            return bool(a.get("noAudio"))
        p = read_json(os.path.join(self.data, "videoprobe.json"), {}).get(name)
        return bool(p and same_sig(p, sig) and not p.get("audio"))

    def in_scope(self, name):
        """An "all" request covers one list: songs (the default) or videos."""
        scope = self.req.get("scope")
        if scope not in ("songs", "videos"):
            return True  # automatic leveling: songs and videos alike
        return is_video(name) == (scope == "videos")

    def files_requested(self):
        listed = self.all_media()
        want = self.req.get("files", "all")
        if want == "all" or not isinstance(want, list):
            return [f for f in listed if self.in_scope(f)]
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
        path = self.path_of(name)
        bpath = self.backup_path(name)
        rec = self.leveled.get(name)
        if os.path.exists(bpath) and rec and same_sig(rec, file_sig(path)):
            return bpath, True
        return path, False

    # -- FPP's playback gain (File Manager > Normalize) -------------------
    #
    # FPP versions with File Manager > Normalize turn each song up or down as
    # it plays, by a gain FPP keeps per song. Where that exists, a song that
    # only needs a volume change is leveled there instead of in the file:
    # exact, lossless, any format, and the file stays as uploaded.
    #
    # Those gains are FPP's data, so this plugin never touches the file they
    # live in. They're set and removed by FPP's own Normalize (the same request
    # its File Manager makes, run_normalize.php), and read through this
    # plugin's API, which asks FPP's own helper (api.php, GET gains).

    NORMALIZE_BUSY_WAIT = 300   # seconds to wait for a Normalize someone else started

    def playback_gain_on(self):
        return bool((self.req.get("playbackGain") or {}).get("enabled"))

    def gains(self, refresh=False):
        """{name: {"gainDb", "size"}} for every song and video FPP applies a gain to."""
        if refresh or getattr(self, "_gains", None) is None:
            self._gains = {}
            if (self.req.get("playbackGain") or {}).get("supported"):
                try:
                    # This plugin's own API on this FPP, which asks FPP's helper.
                    with urllib.request.urlopen("http://127.0.0.1/api/plugin/AudioLeveler/gains", timeout=20) as r:
                        j = json.loads(r.read().decode("utf-8", "replace"))
                    if isinstance(j.get("gains"), dict):
                        self._gains = j["gains"]
                except Exception as ex:
                    logging.warning("Could not read FPP's playback gains: %s", ex)
        return self._gains

    def current_gain(self, name, path):
        """The playback gain fppd would apply to this file now (ours or FPP Normalize's), or 0."""
        e = self.gains().get(name)
        try:
            if isinstance(e, dict) and int(e.get("size", -1)) == os.path.getsize(path):
                return clamp(float(e.get("gainDb", 0)), -30.0, 20.0)
        except (OSError, TypeError, ValueError):
            pass
        return 0.0

    def normalize(self, name, action, target=None, ceiling=None):
        """
        Ask FPP's Normalize to set (action "normalize") or remove a gain for one
        song or video. Returns its output text; raises RuntimeError on failure.
        """
        body = {"files": [os.path.basename(name)], "dir": "Videos" if is_video(name) else "Music",
                "action": action}
        if action == "normalize":
            body.update(target=round(target, 1), peak=round(ceiling, 1),
                        match="speakers" if self.speakers() else "lufs")
        waited = 0
        while True:
            # FPP's own Normalize on this FPP (the request File Manager makes).
            req = urllib.request.Request("http://127.0.0.1/run_normalize.php", data=json.dumps(body).encode("utf-8"),
                                         headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=1800) as r:
                    text = r.read().decode("utf-8", "replace")
            except Exception as ex:
                raise RuntimeError("FPP's Normalize could not be reached (%s)" % ex)
            if "Another normalize is already running" in text and waited < self.NORMALIZE_BUSY_WAIT:
                # Someone is normalizing from the File Manager: wait our turn.
                if self.cancelled():
                    raise Cancelled()
                time.sleep(10)
                waited += 10
                continue
            break
        self._gains = None  # changed: read again next time
        fail = re.search(r"FAILED: (.*)", text)
        if fail:
            raise RuntimeError("FPP's Normalize: " + fail.group(1).strip())
        if "Another normalize is already running" in text:
            raise RuntimeError("FPP's Normalize is busy with another run")
        return text

    def set_gain(self, name, target, ceiling):
        """Have FPP's Normalize measure the song and set its gain for this target. Returns the gain."""
        text = self.normalize(name, "normalize", target, ceiling)
        if "no audio track" in text:
            raise NoAudio("no sound track")
        m = re.search(r"plays at ([+-]?\d+(?:\.\d+)?) dB", text)
        if not m:
            raise RuntimeError("FPP's Normalize gave no gain for it")
        return float(m.group(1))

    def clear_gain(self, name):
        """Remove a playback gain FPP has for this song, if there is one."""
        if name in self.gains():
            try:
                self.normalize(name, "remove")
            except RuntimeError as ex:
                logging.warning("%s: could not remove its playback gain: %s", name, ex)

    def speakers(self):
        return self.req.get("match") == "speakers"

    def measurement_ok(self, c):
        """A saved measurement has what's needed (the speaker level, when matching by speakers)."""
        if c and c.get("noAudio"):
            return True
        return bool(c) and c.get("I") is not None and c.get("len") and (not self.speakers() or "spk" in c)

    def saved_measurement(self, name, src, from_backup):
        """The Measure step's numbers for the song as it is now, if still valid."""
        if from_backup:
            return None
        c = self.analysis.get(name)
        if c and same_sig(c, file_sig(src)) and self.measurement_ok(c) and not c.get("noAudio"):
            return {k: c.get(k) for k in ("I", "TP", "LRA", "len", "spk")}
        return None

    def analyze_one(self, name, force=False):
        path = self.path_of(name)
        sig = file_sig(path)
        cached = self.analysis.get(name)
        if not force and cached and same_sig(cached, sig) and self.measurement_ok(cached):
            return cached
        try:
            info = probe(path)
        except NoAudio:
            if not is_video(name):
                raise
            entry = dict(sig, noAudio=True, I=None, TP=None, LRA=None, len=None, measured=now())
            self.analysis[name] = entry
            write_json(self.analysis_path, self.analysis)
            return entry
        m = measure(path, speakers=self.speakers())
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
                            if e.get("I") is not None else
                            "no sound track" if e.get("noAudio") else "silent")
            except Cancelled:
                break
            except Exception as ex:
                self.result(name, False, str(ex))
            self.save_job(done=i + 1)
        self.save_job(done=len(self.job.get("results", [])) if self.cancelled() else len(files),
                      stoppedAt="" if not self.cancelled() else self.job.get("current", ""))

    def plan_gain(self, I, TP, target, ceiling, mode):
        """Gain in dB, and whether a limiter is needed to keep peaks under the ceiling."""
        gain = target - I
        if mode == "volume":
            if TP is not None and TP + gain > ceiling + PEAK_TOLERANCE_DB:
                return ceiling - TP, False
            return gain, False
        need_limit = TP is not None and TP + gain > ceiling + PEAK_TOLERANCE_DB
        return gain, need_limit

    def build_filter(self, gain, limit, ceiling, sr, mode, dither=False):
        parts = []
        if mode == "compress":
            parts.append(COMPRESSOR)
        parts.append("volume=%.2fdB" % gain)
        if limit:
            # Oversample 4x so the limiter catches peaks between samples
            # (true peak), then come back to the file's own sample rate.
            lin = clamp(db_to_lin(ceiling - 0.1), 0.0625, 1.0)
            parts.append(resample(sr * 4))
            parts.append("alimiter=limit=%.4f:attack=5:release=60:level=0:latency=1" % lin)
            parts.append(resample(sr))
        if dither:
            parts.append("aresample=osf=s16:dither_method=triangular")
        return ",".join(parts)

    def level_one(self, name, target, ceiling, mode, keep_backup):
        path = self.path_of(name)
        ext = os.path.splitext(name)[1].lower()
        src, from_backup = self.original_for(name)
        video = is_video(name)

        try:
            info = probe(src)
        except NoAudio:
            if video:
                return True, "no sound track, nothing to level"
            raise
        # Reuse the Measure step's numbers when they belong to this exact
        # file, so songs that are already fine are passed over instantly.
        saved = self.saved_measurement(name, src, from_backup)
        base = saved or measure(src, speakers=self.speakers())
        if base["I"] is None:
            return False, "skipped: song is silent or too short to measure"
        # Matching by speakers moves this song's own target (bass-heavy songs
        # up, thin ones down, at most 4 dB); everything below aims for it.
        delta = speaker_delta(base) if self.speakers() else 0.0
        target = target + delta
        if mode == "auto":
            mode = recommend(base["I"], base["TP"], target, ceiling)
            if mode == "none":
                mode = "volume"  # within half a dB: the near-target rule below leaves it be
            # Where FPP's Normalize does the leveling, the file is never
            # rewritten unless the user allows the limiter: a song whose peaks
            # hold it back simply lands a little short, as in Normalize.
            if mode == "limit" and self.playback_gain_on() and not self.req.get("allowLimiter"):
                mode = "volume"
        pre = COMPRESSOR if mode == "compress" else None
        m = measure(src, pre) if pre else base
        before = base["I"]
        if m["I"] is None:
            return False, "skipped: song is silent or too short to measure"

        gain, limit = self.plan_gain(m["I"], m["TP"], target, ceiling, mode)
        tmp = os.path.join(self.tmpdir, "leveling" + ext)
        out = None
        method = None
        note = ""

        # 1. Close enough already: leave the song alone (or, when we're working
        #    from the backup, put the untouched original back).
        if mode != "compress" and not limit and abs(gain) < NEAR_TARGET_DB:
            if not from_backup:
                if self.current_gain(name, path):
                    self.clear_gain(name)  # the song itself is on target: play it as is
                return True, "already within %.1f dB of the target (%.1f LUFS), left as is" % (
                    NEAR_TARGET_DB, m["I"])
            shutil.copyfile(src, tmp)
            out, method, gain = dict(m), "original", 0.0

        # 2a. Only a volume change, on an FPP that applies playback gain: have
        #     FPP's own Normalize set it. Exact, lossless for every format, and
        #     the file is left as it is (a file we rewrote earlier gets its
        #     original back first). FPP's Normalize works out the same gain
        #     (same measurement, speaker matching and peak rule) from the
        #     song's target before speaker matching.
        if (method is None and mode == "volume" and self.playback_gain_on()
                and -30.0 <= target - delta <= -5.0):
            if not self.wait_for_idle(name):
                return False, "cancelled"
            if from_backup:
                shutil.copy2(src, path + ".restoring")
                os.replace(path + ".restoring", path)
            try:
                gain = self.set_gain(name, target - delta, ceiling)
                pb_error = None
            except NoAudio:
                return True, "no sound track, nothing to level"
            except RuntimeError as ex:
                pb_error = str(ex)
            if pb_error is None:
                sig = file_sig(path)
                self.leveled[name] = dict(sig, target=target, ceiling=ceiling, mode=mode,
                                          gain=round(gain, 1), limited=False, at=now(),
                                          method="playback", backup=os.path.exists(self.backup_path(name)))
                write_json(self.leveled_path, self.leveled)
                entry = dict(sig)
                entry.update(probe(path))
                entry.update(m)
                entry["measured"] = now()
                self.analysis[name] = entry
                write_json(self.analysis_path, self.analysis)
                after = m["I"] + gain
                held = m["TP"] is not None and m["TP"] + (target - m["I"]) > ceiling + 0.05
                return True, "%.1f -> %.1f LUFS, %+.1f dB, playback gain set by FPP's Normalize (file untouched)%s%s" % (
                    m["I"], after, gain, spk_note(delta),
                    " (held back by peaks, ends %.1f dB under the target)" % (target - after)
                    if held and target - after > 0.3 else "")
            # FPP's Normalize couldn't do it: level the file instead.
            logging.warning("%s: playback gain not set (%s); leveling the file instead", name, pb_error)
            note = "; file leveled because " + pb_error
            if from_backup:
                src, from_backup = path, False  # the original is back in place now

        # 2b. MP3 that only needs a volume change: change it losslessly, the way
        #     MP3Gain does, in 1.5 dB steps. Nothing is re-encoded.
        if method is None and ext == ".mp3" and mode != "compress" and self.req.get("lossless", True):
            steps, why = self.lossless_steps(gain, m, target, ceiling, mode)
            if steps == 0 and not from_backup:
                # Within half a lossless step (~0.75 dB): not worth any change.
                return True, "already within 0.8 dB of the target (%.1f LUFS), left as is" % m["I"]
            if steps is not None:
                try:
                    mp3lossless.apply(src, tmp, steps)
                    # An MP3 that ffmpeg made earlier carries a "Lavc" gapless
                    # tag, which FPP (GStreamer) can't read, so it plays 25 ms
                    # late. Relabelling it puts the song back in step with the
                    # sequence; a file without such a tag is left as it is.
                    try:
                        mp3lossless.label_lame_tag(tmp)
                    except RuntimeError:
                        pass
                    out = measure(tmp, speakers=self.speakers())
                    if out["TP"] is not None and out["TP"] > ceiling + 0.3:
                        raise mp3lossless.NotLossless("peaks came out above the ceiling")
                    method, gain, limit = ("lossless" if steps else "original"), steps * mp3lossless.STEP_DB, False
                except mp3lossless.NotLossless as ex:
                    why = str(ex)
                    if os.path.exists(tmp):
                        os.remove(tmp)
                    out = None
            if method is None and why and "limiter" not in why:
                note = "; re-encoded because " + why

        # 3. Everything else: re-encode at the best quality the format allows.
        if method is None:
            method = "encoded"
            expected = target if mode != "volume" else m["I"] + gain
            dither = needs_dither(ext, info)
            for attempt in (1, 2):
                af = self.build_filter(gain, limit, ceiling, info["sr"], mode, dither)
                if video:
                    # Picture, subtitles and any other sound tracks are copied
                    # as they are; only the first sound track is leveled. The
                    # filter ends at the track's own sample rate.
                    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", src,
                           "-map", "0:v?", "-map", "0:a", "-map", "0:s?", "-map_metadata", "0",
                           "-c", "copy", "-filter:a:0", af, "-ac:a:0", str(info["ch"])] + \
                        video_codec_args(ext, info) + [tmp]
                else:
                    if ext == ".aac":
                        # A raw AAC stream can't record the encoder's 1024-sample
                        # lead-in, so every player plays it: start the input that
                        # much later and the song stays where it was in time.
                        af = "atrim=start_sample=%d,asetpts=PTS-STARTPTS," % AAC_LEAD_IN + af
                    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", src, "-vn",
                           "-map", "0:a:0", "-map_metadata", "0", "-af", af,
                           "-ar", str(info["sr"]), "-ac", str(info["ch"])] + codec_args(ext, info) + [tmp]
                r = run(cmd)
                if r.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
                    tail = (r.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
                    if os.path.exists(tmp):
                        os.remove(tmp)
                    return False, "ffmpeg failed: " + tail[0]
                if ext == ".mp3" and not video:
                    # Without this, FPP (GStreamer) plays the encoder's lead-in
                    # and the song lands 25 ms late against its sequence.
                    try:
                        mp3lossless.label_lame_tag(tmp)
                    except RuntimeError as ex:
                        os.remove(tmp)
                        return False, "kept the original: couldn't keep the new MP3 in sync (%s)" % ex
                # Check the new file before it goes anywhere near the show.
                out = measure(tmp, speakers=self.speakers())
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
            os.makedirs(os.path.dirname(bpath), exist_ok=True)
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

        # The file itself is leveled now: any playback gain for it would stack.
        self.clear_gain(name)
        sig = file_sig(path)
        self.leveled[name] = dict(sig, target=target, ceiling=ceiling, mode=mode,
                                  gain=round(gain, 2), limited=limit, at=now(),
                                  method=method, backup=os.path.exists(bpath))
        write_json(self.leveled_path, self.leveled)
        entry = dict(sig)
        entry.update(probe(path))
        entry.update(out)
        entry["measured"] = now()
        self.analysis[name] = entry
        write_json(self.analysis_path, self.analysis)

        before = "%.1f" % before if before is not None else "?"
        after = out["I"] if out["I"] is not None else target
        how = {"lossless": "lossless", "original": "original restored", "encoded": "re-encoded"}[method]
        held = (mode == "volume" and m["TP"] is not None
                and m["TP"] + (target - m["I"]) > ceiling + 0.05)
        if held and target - after > 0.3 and method != "original":
            note = " (held back by peaks, ends %.1f dB under the target; the limiter could go louder)" % (
                target - after) + note
        elif limit:
            note = " (limiter caught the peaks)" + note
        return True, "%s -> %.1f LUFS, %+.1f dB, %s%s%s" % (before, after, gain, how, note, spk_note(delta))

    def lossless_steps(self, gain, m, target, ceiling, mode):
        """
        Whole 1.5 dB steps for a lossless MP3 change, or (None, reason) when a
        lossless change wouldn't do the job and the song should be re-encoded.
        """
        step = mp3lossless.STEP_DB
        steps = int(round(gain / step))
        # Never push peaks over the ceiling: that needs the limiter.
        while steps > 0 and m["TP"] is not None and m["TP"] + steps * step > ceiling:
            steps -= 1
        miss = gain - steps * step
        if mode == "limit" and miss > step / 2:
            return None, "it needed the limiter to reach the target"
        if abs(miss) > step / 2 + 0.05:
            # The peaks leave less room than one lossless step, so whole steps
            # can't get within half a step of the right level: do it exactly.
            return None, "the peaks left less room than one lossless 1.5 dB step"
        return steps, None

    def cmd_level(self):
        target = clamp(float(self.req.get("target", -14)), -30.0, -6.0)
        ceiling = clamp(float(self.req.get("ceiling", -1.5)), -6.0, 0.0)
        mode = self.req.get("mode", "auto")
        if mode not in MODES:
            mode = "auto"
        keep = bool(self.req.get("backup", True))
        bg_offset = clamp(float(self.req.get("bgOffset", 10)), 3.0, 30.0)
        choices = read_json(os.path.join(self.data, "choices.json"), {})
        files = self.files_requested()
        self.save_job(total=len(files), target=target, ceiling=ceiling, mode=mode)
        logging.info("Leveling %d file(s) to %.1f LUFS, ceiling %.1f dBTP, mode %s, backups %s, lossless MP3 %s",
                     len(files), target, ceiling, mode, "on" if keep else "off",
                     "on" if self.req.get("lossless", True) else "off")
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            if not self.wait_for_idle(name) and self.cancelled():
                break
            choice = choices.get(name, "default")
            if choice not in CHOICES:
                choice = "default"
            song_mode, song_target = mode, target
            if choice == "skip":
                self.result(name, True, "skipped (set to Skip)")
                continue
            if choice == "background":
                song_mode, song_target = "volume", max(-40.0, target - bg_offset)
            elif choice != "default":
                song_mode = choice
            path = self.path_of(name)
            # Fine as is: the song as it stands is already within half a dB of
            # its target with peaks under the ceiling, exactly what the page
            # shows as "Fine as is". Leave it alone, however it got there.
            # (Compression is a deliberate change, so it's never skipped.)
            if song_mode != "compress":
                cur = self.saved_measurement(name, path, False) if os.path.exists(path) else None
                # An MP3 changed losslessly can only land to within half a 1.5 dB
                # step, so for those "fine" means within that half step.
                fine_db = NEAR_TARGET_DB
                if name.lower().endswith(".mp3") and self.req.get("lossless", True):
                    fine_db = mp3lossless.STEP_DB / 2 + 0.03
                fine_target = song_target
                if cur:
                    if self.speakers():
                        fine_target = song_target + speaker_delta(cur)
                    g = self.current_gain(name, path)
                    cur = dict(cur, I=cur["I"] + g, TP=None if cur["TP"] is None else cur["TP"] + g)
                    if g:
                        fine_db = NEAR_TARGET_DB
                if (cur and abs(cur["I"] - fine_target) < fine_db
                        and (cur["TP"] is None or cur["TP"] <= ceiling + PEAK_TOLERANCE_DB)):
                    self.result(name, True, "fine as is (%.1f LUFS%s), left alone" % (
                        cur["I"], ", speaker matched" if fine_target != song_target else ""))
                    self.save_job(done=i + 1)
                    continue
            # Already leveled with exactly these settings (say, before a job
            # was cancelled): nothing to redo, so carry on where it stopped.
            rec = self.leveled.get(name)
            if (rec and os.path.exists(path) and same_sig(rec, file_sig(path))
                    and rec.get("asked") == song_mode and rec.get("askedTarget", rec.get("target")) == song_target
                    and rec.get("match", "lufs") == self.req.get("match", "lufs")
                    and rec.get("ceiling") == ceiling
                    and rec.get("losslessOpt", True) == bool(self.req.get("lossless", True))):
                self.result(name, True, "already leveled with these settings")
                self.save_job(done=i + 1)
                continue
            try:
                ok, msg = self.level_one(name, song_target, ceiling, song_mode, keep)
                if ok and choice == "background":
                    msg += " (background, %g dB under the show)" % bg_offset
                if ok and name in self.leveled and self.leveled[name].get("at") and (
                        same_sig(self.leveled[name], file_sig(path))):
                    self.leveled[name]["asked"] = song_mode
                    self.leveled[name]["askedTarget"] = song_target
                    self.leveled[name]["match"] = self.req.get("match", "lufs")
                    self.leveled[name]["losslessOpt"] = bool(self.req.get("lossless", True))
                    write_json(self.leveled_path, self.leveled)
            except Cancelled:
                break
            except Exception as ex:
                ok, msg = False, str(ex)
            self.result(name, ok, msg)
            self.save_job(done=i + 1)
        self.save_job(done=len(self.job.get("results", [])) if self.cancelled() else len(files),
                      stoppedAt="" if not self.cancelled() else self.job.get("current", ""))

    # -- automatic leveling of new and replaced songs ---------------------

    # A file that changed this recently may still be uploading; it's picked
    # up by the next check instead.
    AUTO_SETTLE_SECONDS = 60

    def auto_candidates(self):
        """
        Songs uploaded or changed since automatic leveling was switched on,
        that the plugin hasn't measured as they are now, and that aren't set to
        Skip or still being uploaded. Songs that were already there when it was
        switched on are left for you to level from the page.
        """
        choices = read_json(os.path.join(self.data, "choices.json"), {})
        since = float(self.req.get("since") or 0)
        out = []
        for name in self.all_media():
            path = self.path_of(name)
            if choices.get(name) == "skip":
                continue
            st = os.stat(path)
            if time.time() - st.st_mtime < self.AUTO_SETTLE_SECONDS:
                continue
            if st.st_mtime < since:
                continue
            a = self.analysis.get(name)
            if a and same_sig(a, file_sig(path)):
                continue
            out.append(name)
        return out

    def cmd_auto(self):
        files = self.req.get("files") or []
        logging.info("Auto-leveling %d new or replaced song(s): %s", len(files), ", ".join(files[:10]) +
                     (" ..." if len(files) > 10 else ""))
        # Measure first (so 'fine as is' is judged on the new file), then level.
        for i, name in enumerate(files):
            if self.cancelled():
                return
            self.save_job(current=name, done=0, total=len(files))
            try:
                self.analyze_one(name, True)
            except Cancelled:
                return
            except Exception as ex:
                logging.warning("%s: could not measure: %s", name, ex)
        self.cmd_level()

    def cmd_retime(self):
        """
        Put MP3s that play about 25 ms late on FPP back in step with their
        sequences: relabel the gapless tag ffmpeg wrote so GStreamer reads it
        (see mp3lossless.label_lame_tag). Only those 9 bytes and the tag's
        checksum change; the audio, the size and the file date stay the same,
        so measurements and FPP's Normalize settings for it stay valid.
        """
        files = [f for f in self.files_requested() if f.lower().endswith(".mp3") and not is_video(f)]
        self.save_job(total=len(files))
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            path = self.path_of(name)
            if not mp3lossless.plays_late_on_fpp(path):
                self.result(name, True, "already plays on time")
                continue
            if not self.wait_for_idle(name):
                break
            st = os.stat(path)
            tmp = os.path.join(self.tmpdir, "retime.mp3")
            try:
                if self.req.get("backup", True):
                    bpath = self.backup_path(name)
                    if not os.path.exists(bpath):
                        os.makedirs(os.path.dirname(bpath), exist_ok=True)
                        shutil.copy2(path, bpath + ".part")
                        os.replace(bpath + ".part", bpath)
                shutil.copy2(path, tmp)
                mp3lossless.label_lame_tag(tmp)
                os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
                os.replace(tmp, path)
            except (OSError, RuntimeError) as ex:
                if os.path.exists(tmp):
                    os.remove(tmp)
                self.result(name, False, "left as it was: %s" % ex)
                continue
            self.result(name, True, "now in step with its sequence (played 25 ms late on FPP)")
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def cmd_tags(self):
        """
        Change songs' Title and Artist (the Song info tab). Only the tag is
        rewritten (bin/id3tags.py checks the audio is untouched before it
        replaces a file), the file name and date stay the same, and a playing
        song keeps playing: the new file takes its place in one step. When the
        tag had to grow, what was recorded against the old size (measurements,
        FPP's Normalize setting) moves to the new size, since the sound is the
        same. A backed-up original gets the same info, so Restore keeps it.
        """
        edits = self.req.get("edits") or {}
        files = [f for f in self.files_requested() if f in edits and f.lower().endswith(".mp3") and not is_video(f)]
        self.save_job(total=len(files))
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            e = edits.get(name) or {}
            title, artist = str(e.get("title") or ""), str(e.get("artist") or "")
            path = self.path_of(name)
            try:
                old = file_sig(path)
                now_tags = id3tags.read_tags(path)
                if now_tags["title"] == title.strip() and now_tags["artist"] == artist.strip():
                    self.result(name, True, "already had this info")
                    continue
                r = id3tags.write_tags(path, title, artist, os.path.join(self.tmpdir, "tagging.mp3"))
            except (OSError, id3tags.TagError) as ex:
                self.result(name, False, "left as it was: %s" % ex)
                continue
            if r["resized"]:
                new = file_sig(path)
                for store, spath in ((self.analysis, self.analysis_path), (self.leveled, self.leveled_path)):
                    rec = store.get(name)
                    if isinstance(rec, dict) and same_sig(rec, old):
                        rec.update(new)
                        write_json(spath, store)
                self.move_gain(name, old["size"])
            bpath = self.backup_path(name)
            if os.path.exists(bpath):
                try:
                    id3tags.write_tags(bpath, title, artist, os.path.join(self.tmpdir, "tagging.mp3"))
                except (OSError, id3tags.TagError) as ex:
                    logging.warning("%s: couldn't update the backed-up original's info: %s", name, ex)
            self.result(name, True, "info updated")
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def move_gain(self, name, old_size):
        """Keep FPP's Normalize setting for a song whose tag grew (see api.php gainsize)."""
        body = json.dumps({"file": name, "oldSize": old_size}).encode("utf-8")
        req = urllib.request.Request("http://127.0.0.1/api/plugin/AudioLeveler/gainsize", data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                r.read()
        except Exception as ex:
            logging.warning("%s: couldn't carry its Normalize setting over to the new size: %s", name, ex)

    def cmd_restore(self):
        files = [f for f in self.files_requested_or_backups()]
        self.save_job(total=len(files))
        for i, name in enumerate(files):
            if self.cancelled():
                break
            self.save_job(current=name, done=i)
            bpath = self.backup_path(name)
            if not os.path.exists(bpath):
                # Leveled by playback gain only: the file was never changed,
                # so restoring is just removing that gain.
                if name in self.our_gains():
                    self.normalize(name, "remove")
                    self.leveled.pop(name, None)
                    write_json(self.leveled_path, self.leveled)
                    self.result(name, True, "playback gain removed; plays as recorded")
                else:
                    self.result(name, False, "no backup to restore")
                continue
            if not self.wait_for_idle(name):
                break
            path = self.path_of(name)
            shutil.copy2(bpath, path + ".restoring")
            os.replace(path + ".restoring", path)
            self.leveled.pop(name, None)
            self.clear_gain(name)  # "the original" means as recorded, no playback gain
            write_json(self.leveled_path, self.leveled)
            self.analysis.pop(name, None)
            try:
                self.analyze_one(name, True)
            except Exception:
                pass
            self.result(name, True, "original restored")
        self.save_job(done=len(files) if not self.cancelled() else self.job.get("done", 0))

    def our_gains(self):
        """Songs and videos this plugin leveled with a playback gain that FPP still has."""
        ours = set(k for k, v in self.leveled.items() if isinstance(v, dict) and v.get("method") == "playback")
        return ours & set(self.gains())

    def files_requested_or_backups(self):
        have = set(f for f in os.listdir(self.backups) if safe_name(f))
        vb = os.path.join(self.backups, "videos")
        if os.path.isdir(vb):
            have |= set(VIDEO_PREFIX + f for f in os.listdir(vb) if safe_name(VIDEO_PREFIX + f))
        have = sorted(have | self.our_gains())
        want = self.req.get("files", "all")
        if want == "all" or not isinstance(want, list):
            return [f for f in have if self.in_scope(f)]
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
        except Cancelled:
            self.save_job(state="cancelled", current="", message="",
                          done=len(self.job.get("results", [])), finished=now())
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
    # Started by fppd through the "Audio Leveler: Start Job" command: the page
    # left the full command line in a launch file.
    if len(sys.argv) == 3 and sys.argv[1] == "--launch":
        launch = read_json(sys.argv[2], {})
        argv = launch.get("argv")
        if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
            return 1
        sys.argv = [sys.argv[0]] + argv

    ap = argparse.ArgumentParser(description="FPP Audio Leveler worker")
    ap.add_argument("command", choices=("analyze", "level", "restore", "retime", "tags", "auto"))
    ap.add_argument("--music", help="FPP music folder (auto: taken from auto.json)")
    ap.add_argument("--videos", help="FPP videos folder; videos are left out without it")
    ap.add_argument("--data", required=True, help="plugindata folder for this plugin")
    ap.add_argument("--log", help="log file (defaults to stderr)")
    ap.add_argument("--request", help="JSON file with the job options")
    args = ap.parse_args()
    auto_settings = None
    if args.command == "auto":
        # Started by a lifecycle/playlist callback or the page: the settings
        # the page last saved live in auto.json. Off unless switched on there.
        auto_settings = read_json(os.path.join(args.data, "auto.json"), {})
        if not auto_settings.get("enabled"):
            return 0
        args.music = args.music or auto_settings.get("music")
        args.videos = args.videos or auto_settings.get("videos")
        args.log = args.log or auto_settings.get("log")
    if not args.music:
        ap.error("--music is required")
    args.auto_settings = auto_settings

    log_problem = None
    try:
        # WatchedFileHandler reopens the log after FPP rotates it (a job can
        # run for hours), so nothing is written into the rotated copy.
        handlers = [logging.handlers.WatchedFileHandler(args.log)] if args.log else None
        logging.basicConfig(handlers=handlers, level=logging.INFO,
                            format="%(asctime)s %(levelname)s %(message)s")
    except OSError as ex:
        # Can't write the log (e.g. it was created by root). Keep working and
        # report through job.json instead, so the page still shows progress.
        log_problem = "can't write the plugin log (%s)" % ex.strerror
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    try:
        return run_job(args, log_problem)
    except Exception as ex:
        logging.exception("Audio Leveler worker failed to start")
        try:
            write_json(os.path.join(args.data, "job.json"),
                       {"cmd": args.command, "state": "error", "finished": now(), "results": [],
                        "message": "The worker could not start: %s" % ex})
        except Exception:
            pass
        return 1


def run_job(args, log_problem):
    if log_problem:
        logging.warning("Audio Leveler %s", log_problem)
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

    w = Worker(args)
    if args.command == "auto":
        w.req = dict(args.auto_settings)
        if not w.req.get("since"):
            return 0  # never switched on from the page
        files = w.auto_candidates()
        if not files:
            return 0  # nothing new: leave the page's last job result alone
        w.req = dict(args.auto_settings, files=files, waitIdle=True, mode="auto")
    w.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
