<div id="audioLeveler" class="mt-2">

    <div id="alNoFfmpeg" class="alert alert-danger d-none" role="alert">
        ffmpeg is not installed on this FPP, so songs can't be measured or leveled.
        Reinstall the plugin from the Plugin Manager to install it.
    </div>

    <div class="row g-3 mx-0">
        <!-- Settings -->
        <div class="col-12 col-xl-4">
            <div class="card h-100">
                <div class="card-header fw-semibold">Leveling settings</div>
                <div class="card-body">
                    <label for="alTargetPreset" class="form-label fw-semibold mb-1">Target level</label>
                    <div class="input-group mb-1">
                        <select id="alTargetPreset" class="form-select">
                            <option value="-16">-16 LUFS &middot; quieter, more headroom</option>
                            <option value="-14">-14 LUFS &middot; recommended</option>
                            <option value="-12">-12 LUFS &middot; louder</option>
                            <option value="-10">-10 LUFS &middot; loud, for FM transmitters</option>
                            <option value="custom">Custom&hellip;</option>
                        </select>
                        <input id="alTargetCustom" type="number" class="form-control d-none" min="-30" max="-6" step="0.5" aria-label="Custom target in LUFS">
                    </div>
                    <div class="form-text mb-3">Every song is brought to this loudness. Use FPP's volume to set how loud the show plays overall.</div>

                    <label for="alCeiling" class="form-label fw-semibold mb-1">Peak ceiling</label>
                    <select id="alCeiling" class="form-select mb-1">
                        <option value="-0.5">-0.5 dBTP</option>
                        <option value="-1">-1 dBTP &middot; recommended</option>
                        <option value="-2">-2 dBTP &middot; extra safe for FM</option>
                    </select>
                    <div class="form-text mb-3">The loudest peak allowed, so nothing clips or distorts.</div>

                    <div class="fw-semibold mb-1">Leveling type</div>
                    <div class="form-check mb-2">
                        <input class="form-check-input" type="radio" name="alMode" id="alModeVolume" value="volume">
                        <label class="form-check-label" for="alModeVolume">
                            <span class="fw-semibold">Volume only</span><br>
                            <span class="form-text">Just turns each song up or down. Never changes the sound, but a quiet song with big peaks may not reach the target.</span>
                        </label>
                    </div>
                    <div class="form-check mb-2">
                        <input class="form-check-input" type="radio" name="alMode" id="alModeLimit" value="limit">
                        <label class="form-check-label" for="alModeLimit">
                            <span class="fw-semibold">Loudness match + peak limiter</span> <span class="badge text-bg-secondary">default</span><br>
                            <span class="form-text">Turns songs up or down and gently catches the peaks, so every song hits the target without clipping.</span>
                        </label>
                    </div>
                    <div class="form-check mb-3">
                        <input class="form-check-input" type="radio" name="alMode" id="alModeCompress" value="compress">
                        <label class="form-check-label" for="alModeCompress">
                            <span class="fw-semibold">Light compression</span><br>
                            <span class="form-text">Also evens out quiet intros and loud choruses. Good outdoors or over FM, where quiet parts get lost.</span>
                        </label>
                    </div>

                    <div class="form-check form-switch mb-2">
                        <input class="form-check-input" type="checkbox" role="switch" id="alBackup">
                        <label class="form-check-label" for="alBackup">Keep the original of each song so it can be restored</label>
                    </div>
                    <div class="form-check form-switch">
                        <input class="form-check-input" type="checkbox" role="switch" id="alWaitIdle">
                        <label class="form-check-label" for="alWaitIdle">Wait until no show is playing before working</label>
                    </div>
                    <div class="form-text">When off, work runs at low priority during the show, but a song is never replaced while it is playing.</div>
                </div>
            </div>
        </div>

        <!-- Songs -->
        <div class="col-12 col-xl-8">
            <div class="card">
                <div class="card-header d-flex flex-wrap gap-2 align-items-center">
                    <span class="fw-semibold me-auto">Songs</span>
                    <button id="alMeasure" type="button" class="buttons btn btn-outline-secondary">Measure songs</button>
                    <button id="alLevelSel" type="button" class="buttons btn btn-success" disabled>Level selected</button>
                    <button id="alLevelAll" type="button" class="buttons btn btn-outline-success">Level all</button>
                </div>
                <div class="card-body">
                    <div id="alJob" class="d-none mb-3">
                        <div class="d-flex flex-wrap align-items-center gap-2 mb-1">
                            <span id="alJobText" class="me-auto"></span>
                            <button id="alCancel" type="button" class="buttons btn btn-sm btn-outline-danger">Cancel</button>
                        </div>
                        <div class="progress" role="progressbar" aria-label="Job progress">
                            <div id="alJobBar" class="progress-bar progress-bar-striped progress-bar-animated" style="width: 0%"></div>
                        </div>
                        <div id="alJobMsg" class="form-text"></div>
                    </div>
                    <div id="alResult" class="d-none mb-3"></div>

                    <div id="alSummary" class="mb-2"></div>

                    <div class="table-responsive">
                        <table class="table table-sm table-hover align-middle mb-2">
                            <thead>
                                <tr>
                                    <th scope="col" class="text-center"><input id="alSelectAll" class="form-check-input" type="checkbox" aria-label="Select all songs"></th>
                                    <th scope="col">Song</th>
                                    <th scope="col" class="text-end">Loudness</th>
                                    <th scope="col" class="text-end d-none d-sm-table-cell">Peak</th>
                                    <th scope="col" class="d-none d-md-table-cell">Status</th>
                                    <th scope="col" class="text-end"></th>
                                </tr>
                            </thead>
                            <tbody id="alRows">
                                <tr><td colspan="6" class="text-body-secondary">Loading&hellip;</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="d-flex flex-wrap gap-2 align-items-center">
                        <button id="alRestoreSel" type="button" class="buttons btn btn-outline-secondary btn-sm" disabled>Restore originals of selected</button>
                        <span id="alBackupInfo" class="form-text me-auto"></span>
                        <button id="alDeleteBackups" type="button" class="buttons btn btn-outline-danger btn-sm" disabled>Delete all backups</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<?php
// FPP serves plugin files with a one-year browser cache, so a fixed script
// address would keep running an old copy after an update. The file's
// modification time in the address makes each new version load by itself.
// (Kept outside js/, which FPP would also auto-include without a version.)
$alScript = __DIR__ . '/assets/audioleveler.js';
$alVer = file_exists($alScript) ? filemtime($alScript) : time();
?>
<script type="text/javascript" src="plugin.php?plugin=AudioLeveler&amp;file=assets/audioleveler.js&amp;nopage=1&amp;v=<?php echo $alVer; ?>"></script>
