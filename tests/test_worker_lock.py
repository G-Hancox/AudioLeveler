#!/usr/bin/env python3
# Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
"""
Tests for how the worker (bin/leveler.py) starts a queued job when another
worker holds worker.lock, or when the page has moved on. They run the real
worker as fppd would (python3 bin/leveler.py --launch <file>) against a
temporary data folder; no FPP or ffmpeg needed.

    python3 tests/test_worker_lock.py
"""

import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "bin", "leveler.py")
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import leveler  # noqa: E402  (for the message text)


class WorkerLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, "data")
        self.music = os.path.join(self.tmp.name, "music")
        os.makedirs(self.data)
        os.makedirs(self.music)
        self.job_path = os.path.join(self.data, "job.json")
        self.request = os.path.join(self.data, "request.json")
        with open(self.request, "w") as f:
            json.dump({"files": "all"}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def write_job(self, job):
        with open(self.job_path, "w") as f:
            json.dump(job, f)

    def read_job(self):
        with open(self.job_path) as f:
            return json.load(f)

    def launch(self, token, command="analyze"):
        """Run the worker the way start_job.sh does, from a claimed launch file."""
        path = os.path.join(self.data, "launch.%d.json" % os.getpid())
        with open(path, "w") as f:
            json.dump({"token": token, "argv": [command, "--music", self.music, "--data", self.data,
                                                "--request", self.request]}, f)
        r = subprocess.run([sys.executable, WORKER, "--launch", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertFalse(os.path.exists(path), "the worker should use up its launch file")
        return r

    def hold_lock(self):
        lock = open(os.path.join(self.data, "worker.lock"), "w")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(lock.close)
        return lock

    def test_lock_held_reports_another_job(self):
        """A queued job that can't get the lock says so in job.json."""
        self.write_job({"cmd": "analyze", "state": "starting", "requested": int(time.time()), "token": "T1"})
        self.hold_lock()
        r = self.launch("T1")
        self.assertEqual(r.returncode, 1, r.stderr.decode())
        job = self.read_job()
        self.assertEqual(job["state"], "error")
        self.assertEqual(job["message"], leveler.ANOTHER_JOB_MESSAGE)
        self.assertNotIn(b"Traceback", r.stderr)

    def test_lock_held_leaves_someone_elses_job_alone(self):
        """A worker that loses the lock never writes over a job it doesn't own."""
        running = {"cmd": "level", "state": "running", "done": 3, "total": 10, "results": []}
        self.write_job(running)
        self.hold_lock()
        r = self.launch("T-not-this-one")
        self.assertEqual(r.returncode, 1, r.stderr.decode())
        self.assertEqual(self.read_job(), running)

    def test_auto_worker_losing_lock_leaves_job_alone(self):
        """Automatic leveling (no token) losing the lock leaves the page's job as it is."""
        with open(os.path.join(self.data, "auto.json"), "w") as f:
            json.dump({"enabled": True, "since": int(time.time()), "music": self.music}, f)
        running = {"cmd": "level", "state": "running", "done": 1, "total": 5, "results": []}
        self.write_job(running)
        self.hold_lock()
        r = subprocess.run([sys.executable, WORKER, "auto", "--data", self.data],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(r.returncode, 1, r.stderr.decode())
        self.assertEqual(self.read_job(), running)

    def test_stale_token_does_not_run(self):
        """A worker started after the page moved on (new token) runs nothing."""
        newer = {"cmd": "level", "state": "starting", "requested": int(time.time()), "token": "T2"}
        self.write_job(newer)
        r = self.launch("T1")
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertEqual(self.read_job(), newer)


if __name__ == "__main__":
    unittest.main(verbosity=2)
