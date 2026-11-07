# Audio Leveler for FPP

An FPP plugin that makes every song in your show play at the same loudness, so nothing whispers and nothing blasts.

It measures each song in FPP's music folder (EBU R128 integrated loudness in LUFS, plus true peak), then levels it to a target you choose:

| Leveling type | What it does |
|---|---|
| **Volume only** | Turns each song up or down. Never changes the sound, but a quiet song with big peaks may stop short of the target instead of clipping. |
| **Loudness match + peak limiter** (default) | Turns songs up or down, then a true-peak limiter (4x oversampled) catches anything over the ceiling. Every song reaches the target. |
| **Light compression** | Also narrows the gap between a song's quiet and loud parts (2:1 above -20 dBFS). Good outdoors or over FM. |

Target presets are -16, -14 (default), -12 and -10 LUFS, or you can enter a custom value. The peak ceiling defaults to -1 dBTP.

## Safe for a running show

- **Timing is kept.** File names, format and sample rate stay the same. Every leveled file is checked against the original, and if its length differs by more than 0.15 s it is thrown away and the original is kept.
- **It never interrupts the show.** Work runs in the background at the lowest CPU and disk priority, started by fppd (not the web server), so it stops cleanly with fppd. By default it waits until no show is playing, and it never swaps a song while that song is playing.
- **Files are swapped in one step.** The new file is written separately and renamed over the old one only after it has been checked.
- **Originals are backed up** to `plugindata/AudioLeveler/backups/` with one-click restore. Leveling again always starts from the original, so trying different settings doesn't build up encoding loss. Backups are kept on uninstall.

## Using it

**Content Setup → Audio Leveler**

1. **Measure songs** lists each song's loudness and peak. Songs far from the target show in red. Songs whose peaks go over full scale, so they clip when played, are flagged.
2. Choose a target and leveling type.
3. Press **Level all**, or tick songs and press **Level selected**.
4. Most commercial music is mastered louder than -14 LUFS, so you may need to turn up FPP's volume afterwards.

## Good to know

- **Clipping it can and can't fix.** Leveling brings every peak under the ceiling, so nothing goes over full scale when it plays. Distortion that was recorded or mastered into a song can't be removed by any leveling tool.

- **Leveling is slow on a Pi.** Each song is measured, re-encoded and checked again, which often takes a minute or more per song, so a whole library can take a few hours. It's safe to leave a big job running overnight, because it waits for shows and keeps going with the browser closed. Speed doesn't affect quality.
- **Uploading a song again replaces the leveled copy.** This includes re-uploading after fixing a sequence, or xLights' FPP Connect sending the audio along with a sequence. The plugin flags the song as *Replaced since leveling* (there's a **Replaced** filter for it). Level it again to bring it back on target. The new upload becomes the new original for backups.

## Requirements

`ffmpeg` and `python3`, both included on standard FPP images. `ffmpeg` is declared as a dependency and installed if missing.

## Audio Leveler or FPP's built-in Normalize?

Newer FPP builds include a **Normalize** button in File Manager that stores a per-song gain and applies it at playback without rewriting files. That approach is lossless and covers many shows. It has no limiter, though, so a quiet song can only be raised as far as its peaks allow.

Audio Leveler rewrites the files instead. That lets it use a true-peak limiter or light compression, so every song can reach the target, including louder targets for FM, with every peak kept under the ceiling. It also works on FPP releases that don't have Normalize. Use one or the other for a given song. FPP skips its own playback gain for any file that has changed since it was normalized, so the two never stack.

## Files

| Path | Purpose |
|---|---|
| `content.php`, `assets/audioleveler.js` | The Content Setup page |
| `api.php` | `/api/plugin/AudioLeveler/...` endpoints |
| `bin/leveler.py` | Background worker that runs ffmpeg |
| `commands/start_job.sh` | FPP command "Audio Leveler: Start Job": the page asks fppd to run it, and it starts the worker. On its own it does nothing. |
| `callbacks.sh` | Lets fppd load the plugin without a restart, and asks a running job to stop after its current song when fppd stops or unloads the plugin |
| `about.php` | Help page |

The log is `logs/plugin-AudioLeveler.log`.

## License

GPLv2. See `LICENSE`.
