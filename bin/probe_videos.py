#!/usr/bin/env python3
# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
"""
Audio Leveler: find out which videos have a sound track.

Started in the background by fppd (the "Audio Leveler: Start Job" command,
Task "Check videos for sound") when the page lists videos it hasn't checked
yet, so the page never waits on it. Each video gets one quick
look at its header with ffprobe (no decoding), two at a time at low priority,
and the answers go into <data>/videoprobe.json keyed by name, with the file's
size and date so a replaced video is checked again. Only one of these runs at
a time (probe.lock); the page picks up the answers as they're saved.
"""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
PREFIX = "videos/"


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            j = json.load(f)
        return j if isinstance(j, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def has_audio(path):
    """True/False, or None when ffprobe can't read the file."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=index", "-of", "csv=p=0", path],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           universal_newlines=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip() != ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--data", required=True)
    args = ap.parse_args()

    lock = open(os.path.join(args.data, "probe.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0  # already running

    cache_path = os.path.join(args.data, "videoprobe.json")
    analysis = read_json(os.path.join(args.data, "analysis.json"))
    cache = read_json(cache_path)

    todo = []
    for f in sorted(os.listdir(args.videos)):
        path = os.path.join(args.videos, f)
        if f.startswith(".") or os.path.splitext(f)[1].lower() not in VIDEO_EXTS or not os.path.isfile(path):
            continue
        st = os.stat(path)
        sig = {"size": st.st_size, "mtime": int(st.st_mtime)}
        name = PREFIX + f
        known = [x for x in (analysis.get(name), cache.get(name))
                 if isinstance(x, dict) and x.get("size") == sig["size"] and x.get("mtime") == sig["mtime"]]
        if not known:
            todo.append((name, path, sig))

    # Drop answers for videos that are gone.
    names = set(PREFIX + f for f in os.listdir(args.videos))
    for k in [k for k in cache if k not in names]:
        del cache[k]

    last_save = time.time()
    with ThreadPoolExecutor(max_workers=2) as pool:
        for (name, path, sig), audio in zip(todo, pool.map(lambda t: has_audio(t[1]), todo)):
            # Unreadable: listed (measuring reports the problem), not checked again until it changes.
            cache[name] = dict(sig, audio=True if audio is None else audio)
            if time.time() - last_save > 1.0:
                save(cache_path, cache)
                last_save = time.time()
    save(cache_path, cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
