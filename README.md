# Audio Leveler for FPP

An FPP plugin that makes every song in your show play at the same loudness, so nothing whispers and nothing blasts.

It measures each song in FPP's music folder (EBU R128 integrated loudness in LUFS, plus true peak), then levels it to a target you choose. Each song gets one of these fixes. Every song starts on **Recommended**, and you can change any song's fix.

| Fix | What it does |
|---|---|
| **Recommended** (every song starts here) | The gentlest fix for each song, chosen after measuring: nothing if it's within 0.5 dB; a plain volume change (lossless for MP3s) whenever that reaches the target, or gets within 1 dB of it, without peaks going over the ceiling; the limiter only when it takes 3 dB or less of peak trimming; otherwise volume only, landing a little under the target rather than squashing the song. Never compresses on its own. |
| **Volume only** | Turns each song up or down. Never changes the sound, but a quiet song with big peaks may stop short of the target instead of clipping. |
| **Limiter** | Turns songs up or down, then a true-peak limiter (4x oversampled) catches anything over the ceiling. Every song reaches the target. |
| **Compression** | Also narrows the gap between a song's quiet and loud parts (2:1 above -20 dBFS). Good outdoors or over FM. |

Target presets are -16, -14 (default), -12 and -10 LUFS, or you can enter a custom value. The peak ceiling defaults to -1 dBTP.

### Per-song fixes

After measuring, a **Fix** column shows what leveling will do to each song (for example `−10.5 dB · lossless`, `+1.3 dB · limiter trims 2.6 dB`, `Fine as is`), with notes for very dynamic songs (compression available) and long tracks (background?). Each song has a dropdown: **Recommended** (where every song starts), **Volume only**, **Limiter**, **Compression**, **Background** or **Skip**. Several songs can be set at once with **Set fix** in the selection bar. It leaves Background and Skip songs alone unless only those are selected. Choices are saved in `plugindata/AudioLeveler/choices.json`.

**Background** levels a song deliberately quieter than the show, 10 dB under the target by default and adjustable. It's meant for ambiance and off-hours tracks that should be heard but sit under everything else. **Skip** leaves a song alone even on *Level all*.

## Sound quality

Each song gets the gentlest treatment that does the job:

- **Already close:** a song within about 0.5 dB of the target is left untouched.
- **Lossless (MP3):** when an MP3 only needs a volume change, the plugin adjusts the `global_gain` stored in every frame, the same technique MP3Gain uses, in 1.505 dB steps. Nothing is decoded or re-encoded, so the result is bit-for-bit the original audio scaled by an exact factor. Tags and the LAME/Xing header, which holds the gapless timing, are copied untouched. Files that can't be edited safely (CRC-protected, free-format or damaged streams) fall back to re-encoding. This is on by default. The song lands within about ¾ dB of the target.
- **Re-encoded at top quality:** anything that needs the limiter or compression, and other formats. MP3 at 320 kbps with `compression_level 0` (LAME -q 0), AAC at 256 kbps or more, FLAC/WAV losslessly with triangular dither for 16-bit. The limiter oversamples 4x through the SoX resampler when ffmpeg has it.

The status column shows which path each song took.

## Safe for a running show

- **Timing is kept.** File names, format and sample rate stay the same. Every leveled file is checked against the original, and if its length differs by more than 0.15 s it is thrown away and the original is kept.
- **It never interrupts the show.** Work runs in the background at the lowest CPU and disk priority, started by fppd (not the web server), so it stops cleanly with fppd. By default it waits until no show is playing, and it never swaps a song while that song is playing.
- **Files are swapped in one step.** The new file is written separately and renamed over the old one only after it has been checked.
- **Originals are backed up** to `plugindata/AudioLeveler/backups/` with one-click restore. Leveling again always starts from the original, so trying different settings doesn't build up encoding loss. Backups are kept on uninstall.

## Using it

**Content Setup → Audio Leveler**

1. **Measure songs** lists each song's loudness and peak. Songs far from the target show in red. Songs whose peaks go over full scale, so they clip when played, are flagged.
2. Check the **Fix** column and change any song's fix if you want something different.
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

Audio Leveler rewrites the files instead (losslessly for MP3s that only need a volume change). That lets it use a true-peak limiter or light compression, so every song can reach the target, including louder targets for FM, with every peak kept under the ceiling. It also works on FPP releases that don't have Normalize. Use one or the other for a given song. FPP skips its own playback gain for any file that has changed since it was normalized, so the two never stack.

## Files

| Path | Purpose |
|---|---|
| `content.php`, `assets/audioleveler.js` | The Content Setup page |
| `api.php` | `/api/plugin/AudioLeveler/...` endpoints |
| `bin/leveler.py` | Background worker that runs ffmpeg |
| `bin/mp3lossless.py` | Lossless MP3 volume change (frame `global_gain` edit, as MP3Gain does) |
| `commands/start_job.sh` | FPP command "Audio Leveler: Start Job": the page asks fppd to run it, and it starts the worker. On its own it does nothing. |
| `callbacks.sh` | Lets fppd load the plugin without a restart, and asks a running job to stop after its current song when fppd stops or unloads the plugin |
| `about.php` | Help page |

The log is `logs/plugin-AudioLeveler.log`.

## License

GPLv2. See `LICENSE`.
