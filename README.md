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
- **It never interrupts the show.** Work runs in the background at the lowest CPU and disk priority. By default it waits until no show is playing, and it never swaps a song while that song is playing.
- **Files are swapped in one step.** The new file is written separately and renamed over the old one only after it has been checked.
- **Originals are backed up** to `plugindata/AudioLeveler/backups/` with one-click restore. Leveling again always starts from the original, so trying different settings doesn't build up encoding loss. Backups are kept on uninstall.

## Using it

**Content Setup → Audio Leveler**

1. **Measure songs** lists each song's loudness and peak. Songs far from the target show in red, and songs that already distort are flagged as clipping.
2. Choose a target and leveling type.
3. Press **Level all**, or tick songs and press **Level selected**.
4. Most commercial music is mastered louder than -14 LUFS, so you may need to turn up FPP's volume afterwards.

## Requirements

`ffmpeg` and `python3`, both included on standard FPP images. `ffmpeg` is declared as a dependency and installed if missing.

## Relation to FPP's built-in Normalize

Newer FPP builds include a Normalize button in File Manager that stores a per-song gain and applies it at playback without rewriting files. That approach is lossless, but there is no limiter, so songs can only be raised as far as their peaks allow. This plugin rewrites the files instead, which lets it limit or compress so songs can reach louder targets. It also works on older FPP versions. FPP skips its own playback gain for any file whose size has changed, so the two never stack.

## Files

| Path | Purpose |
|---|---|
| `content.php`, `assets/audioleveler.js` | The Content Setup page |
| `api.php` | `/api/plugin/AudioLeveler/...` endpoints |
| `bin/leveler.py` | Background worker that runs ffmpeg |
| `about.php` | Help page |

The log is `logs/plugin-AudioLeveler.log`.

## License

GPLv2. See `LICENSE`.
