<div class="mt-2">
    <div class="card mb-3">
        <div class="card-header fw-semibold">Audio Leveler help</div>
        <div class="card-body">
            <p>Audio Leveler makes every song in your show play at the same loudness, so nothing whispers and nothing blasts.
               Open it from <b>Content Setup &rarr; Audio Leveler</b>.</p>

            <h6 class="fw-semibold">Quick start</h6>
            <ol>
                <li>Press <b>Measure songs</b>. Each song's loudness and loudest peak are listed. Songs far from your target are shown in red, and songs that already distort are marked <span class="badge text-bg-danger">clips</span>.</li>
                <li>Pick a target level and leveling type, or keep the defaults (-14 LUFS, loudness match + peak limiter).</li>
                <li>Press <b>Level all</b>, or tick some songs and press <b>Level selected</b>.</li>
                <li>Most songs are mastered louder than -14 LUFS, so after leveling the show may sound quieter overall. Turn FPP's volume up to suit.</li>
            </ol>

            <h6 class="fw-semibold">Leveling types</h6>
            <ul>
                <li><b>Volume only</b>: turns each song up or down and nothing else. If a quiet song has big peaks, it stops short of the target rather than clip.</li>
                <li><b>Loudness match + peak limiter</b>: turns songs up or down, then catches any peaks that would go over the ceiling. Every song reaches the target. This is the best choice for most shows.</li>
                <li><b>Light compression</b>: also narrows the gap between quiet and loud parts of a song (2:1 above -20 dB). Useful outdoors or over an FM transmitter, where soft intros get lost.</li>
            </ul>

            <h6 class="fw-semibold">Choosing a target</h6>
            <p>LUFS measures how loud a song sounds, not just its peaks. -14 LUFS is what streaming services use and leaves room for punchy peaks.
               Go to -12 or -10 for a louder signal into an FM transmitter, or -16 for a quieter, more natural sound.
               All songs end up the same loudness either way; FPP's volume decides how loud the show is.</p>

            <h6 class="fw-semibold">Your sequences stay in sync</h6>
            <p>Songs keep their file names, so sequences and playlists still find them. Each leveled song is checked against the original,
               and if its length differs by more than 0.15 seconds, it isn't used and the original is kept.</p>

            <h6 class="fw-semibold">Safe during a show</h6>
            <p>All work runs in the background at the lowest priority. By default it waits until no show is playing. Even with that turned off,
               a song is never replaced while it is playing. A new file is written next to the old one and swapped in only once it has been checked,
               so a song is never left half-written.</p>

            <h6 class="fw-semibold">Backups and restoring</h6>
            <p>With backups on, the first time a song is leveled, its original is kept in
               <code>plugindata/AudioLeveler/backups/</code>. <b>Restore</b> puts it back exactly as it was.
               Leveling a song again always starts from that original, so you can try different settings without the sound getting worse each time.
               If you upload a new version of a song, it becomes the new original. Use <b>Delete all backups</b> to free up space.
               Backups are kept if you uninstall the plugin so you never lose an original; delete that folder yourself if you no longer want them.</p>

            <h6 class="fw-semibold">Supported files</h6>
            <p>MP3, M4A/AAC, OGG, WAV and FLAC in FPP's music folder. Songs are written back in their own format and sample rate.
               MP3s are written at no less than 192 kbps, so re-encoding doesn't dull them.</p>

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
