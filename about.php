<div class="mt-2">
    <div class="card mb-3">
        <div class="card-header fw-semibold">Audio Leveler help</div>
        <div class="card-body">
            <p>Audio Leveler makes every song in your show play at the same loudness, so nothing whispers and nothing blasts.
               Open it from <b>Content Setup &rarr; Audio Leveler</b>.</p>

            <h6 class="fw-semibold">Quick start</h6>
            <ol>
                <li>Press <b>Measure songs</b>. Each song's loudness and loudest peak are listed. Songs far from your target are shown in red. Songs whose peaks go over full scale, so they clip when played, are marked <span class="badge text-bg-danger">clips</span>. Leveling brings those peaks under the ceiling; distortion recorded into the song itself can't be removed by any leveling tool.</li>
                <li>Check the <b>Fix</b> column: it shows what leveling will do to each song, for example <i>−10.5 dB · lossless</i> or
                    <i>+1.3 dB · limiter trims 2.6 dB</i>. Change any song's fix from its dropdown, or tick several songs and use <b>Set fix</b>.</li>
                <li>Press <b>Level all</b>, or tick some songs and press <b>Level selected</b>.</li>
                <li>Most songs are mastered louder than -14 LUFS, so after leveling the show may sound quieter overall. Turn FPP's volume up to suit.</li>
            </ol>

            <h6 class="fw-semibold">Recommended fixes</h6>
            <p>After measuring, each song gets a recommended fix that puts sound quality first:</p>
            <ul>
                <li><b>Fine as is</b> when it's within half a dB of the target.</li>
                <li><b>Volume only</b> (lossless for MP3s) whenever turning it up or down reaches the target, or gets within 1 dB of it, without peaks going over the ceiling.</li>
                <li><b>Limiter</b> only when it takes 3 dB or less of peak trimming to reach the target, which stays inaudible.</li>
                <li>Otherwise <b>volume only</b>, landing a little under the target rather than squashing the song. The Fix column says where it will end up, so you can pick Limiter for that song if you'd rather have it louder.</li>
            </ul>
            <p>Compression is never chosen automatically. Songs with very wide dynamics get a note that it's available.
               Songs longer than 15 minutes get a hint that they might be background tracks.</p>

            <h6 class="fw-semibold">Choosing a fix per song</h6>
            <ul>
                <li>Every song starts on <b>Recommended</b>, the gentlest fix described above.</li>
                <li><b>Volume only</b>, <b>Limiter</b> or <b>Compression</b> pick that treatment for this song (described below).</li>
                <li><b>Background</b> levels the song deliberately quieter than the show (10 dB under the target by default, set under <i>Background level</i>),
                    for ambiance and off-hours music that should be heard but sit under everything else.</li>
                <li><b>Skip</b> leaves the song alone, even when you press <b>Level all</b>.</li>
            </ul>
            <p>Choices are saved per song and kept until you change them. To change many songs at once, tick them and use <b>Set fix</b>;
               it leaves Background and Skip songs as they are unless only those are selected. The <b>Custom fix</b> filter lists every song
               that isn't on Recommended.</p>

            <h6 class="fw-semibold">The fixes</h6>
            <ul>
                <li><b>Volume only</b>: turns the song up or down and nothing else. If a quiet song has big peaks, it stops short of the target rather than clip.</li>
                <li><b>Limiter</b>: turns the song up or down, then catches any peaks that would go over the ceiling, so it reaches the target.</li>
                <li><b>Compression</b>: also narrows the gap between quiet and loud parts of a song (2:1 above -20 dB). Useful outdoors or over an FM transmitter, where soft intros get lost.</li>
            </ul>

            <h6 class="fw-semibold">Choosing a target</h6>
            <p>LUFS measures how loud a song sounds, not just its peaks. -14 LUFS is what streaming services use and leaves room for punchy peaks.
               Go to -12 or -10 for a louder signal into an FM transmitter, or -16 for a quieter, more natural sound.
               All songs end up the same loudness either way; FPP's volume decides how loud the show is.</p>

            <h6 class="fw-semibold">Your sequences stay in sync</h6>
            <p>Songs keep their file names, so sequences and playlists still find them. Each leveled song is checked against the original,
               and if its length differs by more than 0.15 seconds, it isn't used and the original is kept.</p>

            <h6 class="fw-semibold">Safe during a show</h6>
            <p>All work runs in the background at the lowest priority, started by fppd. (That's what the <b>Audio Leveler: Start Job</b> command in FPP's command lists is for; it does nothing on its own.) By default it waits until no show is playing. Even with that turned off,
               a song is never replaced while it is playing. A new file is written next to the old one and swapped in only once it has been checked,
               so a song is never left half-written.</p>

            <h6 class="fw-semibold">Backups and restoring</h6>
            <p>With backups on, the first time a song is leveled, its original is kept in
               <code>plugindata/AudioLeveler/backups/</code>. <b>Restore</b> puts it back exactly as it was.
               Leveling a song again always starts from that original, so you can try different settings without the sound getting worse each time.
               If you upload a new version of a song, it becomes the new original. Use <b>Delete all backups</b> to free up space.
               Backups are kept if you uninstall the plugin so you never lose an original; delete that folder yourself if you no longer want them.</p>

            <h6 class="fw-semibold">How long it takes</h6>
            <p>Leveling is slow on a Pi: each song is measured, re-encoded and then checked again, which often takes a minute or more per song,
               so a whole library can take a few hours. Measuring alone is quicker. It's safe to start a big job and leave it running overnight;
               it waits for shows and you can close the browser. Speed doesn't affect quality.</p>

            <h6 class="fw-semibold">Automatic leveling</h6>
            <p>Switch on <b>Level new and replaced songs automatically</b> and songs you add or change afterwards, such as uploads from xLights,
               are measured and given their fix without you opening this page. It checks when FPP starts, whenever a playlist stops,
               and when you open this page, and does the work only once no show is playing. Songs set to Skip are left alone, a file
               that changed in the last minute (probably still uploading) waits for the next check, and songs that were already there
               when you switched it on are left for you to level here. It's off until you switch it on.</p>

            <h6 class="fw-semibold">Uploading a song again</h6>
            <p>If you upload a song again with the same name (for example after fixing a sequence, or when xLights' FPP Connect sends the audio
               along with a sequence), the new upload <b>replaces the leveled copy</b>. Audio Leveler notices: the song shows
               <span class="badge text-bg-warning">Replaced since leveling</span> and appears under the <b>Replaced</b> filter.
               Level it again and it's back on target, or switch on automatic leveling to have it done for you. The new upload becomes the new original for backups.</p>

            <h6 class="fw-semibold">Audio Leveler or FPP's Normalize?</h6>
            <p>Newer FPP versions have a <b>Normalize</b> button in File Manager that adjusts each song's volume during playback without changing the file.
               That's lossless and fine for many shows. Audio Leveler rewrites the files instead (losslessly for MP3s that only need a volume change), which lets it use a peak limiter or light compression,
               so quiet songs reach the full target with every peak kept under the ceiling. Use one or the other for a given song;
               FPP ignores its own Normalize setting for a file that has been changed since it was normalized, so they won't stack.</p>

            <h6 class="fw-semibold">Sound quality</h6>
            <p>Each song gets the gentlest treatment that does the job:</p>
            <ul>
                <li><b>Already close:</b> a song within about half a decibel of the target is left untouched.</li>
                <li><b>Lossless (MP3s):</b> when an MP3 only needs turning up or down, its volume is changed the way MP3Gain does it,
                    by adjusting the gain stored in each frame, in 1.5 dB steps. Nothing is re-encoded, so there's no quality loss at all,
                    and the song ends up within about ¾ dB of the target. Turn this off under <b>Lossless volume change for MP3s</b>
                    if you'd rather every song hit the target exactly.</li>
                <li><b>Re-encoded at top quality:</b> songs that need the limiter or compression, and formats other than MP3, are re-encoded:
                    MP3 at 320 kbps with LAME's highest-quality setting, M4A/AAC at 256 kbps or more, FLAC and WAV losslessly
                    (16-bit WAV with dither). The limiter oversamples 4x with a high-quality resampler.</li>
            </ul>
            <p>The status column shows which one each song got: <i>lossless</i>, <i>re-encoded</i> or <i>original kept</i>.</p>

            <h6 class="fw-semibold">Supported files</h6>
            <p>MP3, M4A/AAC, OGG, WAV and FLAC in FPP's music folder. Songs are written back in their own format and sample rate.</p>

            <h6 class="fw-semibold">Log</h6>
            <p>Everything the plugin does is written to <code>logs/plugin-AudioLeveler.log</code>, which you can view under <b>Help &rarr; FPP Logs</b>.</p>
        </div>
    </div>

    <div class="card">
        <div class="card-header fw-semibold">About</div>
        <div class="card-body">
            <a href="https://github.com/G-Hancox/AudioLeveler">Git repository</a> &middot;
            <a href="https://github.com/G-Hancox/AudioLeveler/issues">Report a problem</a>
        </div>
    </div>
</div>
