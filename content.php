<?php
// Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
// Audio Leveler page. The settings are FPP setting rows from settings.json
// (PrintPluginSetting), saved by FPP itself; the song list talks to api.php.
require_once __DIR__ . '/api.php';

// One of this plugin's settings, as an FPP setting row. A target saved before
// the presets (a custom value) is moved to the nearest preset so it shows.
function AudioLevelerPrintSetting($name)
{
    global $pluginSettings;
    if ($name === 'AudioLeveler_target' && isset($pluginSettings[$name]) && $pluginSettings[$name] !== '') {
        $v = floatval($pluginSettings[$name]);
        $presets = array(-18, -16, -14, -12, -10);
        $near = $presets[0];
        foreach ($presets as $p) {
            if (abs($p - $v) < abs($near - $v)) {
                $near = $p;
            }
        }
        if ((string) $near !== (string) $pluginSettings[$name]) {
            WriteSettingToFile($name, (string) $near, AUDIOLEVELER_PLUGIN);
            $pluginSettings[$name] = (string) $near;
        }
    }
    PrintPluginSetting(AUDIOLEVELER_PLUGIN, $name, 'audioLevelerSettingSaved');
}
?>
<div id="audioLeveler" class="mt-2">

    <div id="alNoFfmpeg" class="alert alert-danger d-none" role="alert">
        ffmpeg is not installed on this FPP, so songs can't be measured or leveled.
        Reinstall the plugin from the Plugin Manager to install it.
    </div>

    <div class="row g-3 mx-0">
        <!-- Settings -->
        <div class="col-12 col-xl-4">
            <div class="card h-100">
                <div class="card-header d-flex align-items-center gap-2">
                    <span class="fw-semibold me-auto">Leveling settings</span>
                    <!-- Simple shows the few settings most shows need; Advanced shows all
                         of them. Remembered per browser, like Air Defender's Lite/Detailed. -->
                    <div class="btn-group btn-group-sm" role="group" aria-label="Settings view">
                        <button type="button" class="btn btn-outline-secondary" data-al-view="simple" aria-pressed="true">Simple</button>
                        <button type="button" class="btn btn-outline-secondary" data-al-view="advanced" aria-pressed="false">Advanced</button>
                    </div>
                </div>
                <div class="card-body">
                    <?php if (AudioLevelerPlaybackGainSupported()) { ?>
                    <div class="alert alert-info small py-2 mb-3">Leveling is done by FPP's own <b>Normalize</b>, so your files are never changed.
                        Audio Leveler shows you what it did, suggests what might sound better, and adds what Normalize doesn't:
                        Background levels, automatic leveling of new uploads, and the limiter when you want it.</div>
                    <?php } ?>
                    <!-- Settings are FPP's own setting rows (settings.json), saved as
                         soon as they change; audioLevelerSettingSaved() refreshes the page. -->
                    <div class="settingsTable container-fluid px-0">
                        <?php AudioLevelerPrintSetting('AudioLeveler_target'); ?>
                    </div>

                    <!-- Target advisor: what each target would mean for these songs -->
                    <div id="alAdvisor" class="mb-3 d-none al-adv">
                        <div class="small fw-semibold mb-1">What each target means for your songs</div>
                        <div class="form-text mt-0 mb-1">Tap a level to use it.</div>
                        <div class="table-responsive">
                            <table class="table table-sm small align-middle mb-1">
                                <thead>
                                    <tr>
                                        <th scope="col">LUFS</th>
                                        <th scope="col" class="text-end" title="A plain volume change does it (lossless for MP3s, or FPP's Normalize)">Volume</th>
                                        <th scope="col" class="text-end" title="Needs the gentle limiter: 3 dB or less of peak trimming">Limiter</th>
                                        <th scope="col" class="text-end" title="Would need more trimming, so it lands a little quieter instead">Quieter</th>
                                    </tr>
                                </thead>
                                <tbody id="alAdvisorRows"></tbody>
                            </table>
                        </div>
                        <div id="alAdvisorNote" class="form-text"></div>
                    </div>

                    <div class="settingsTable container-fluid px-0 mb-3 al-adv">
                        <?php
                        AudioLevelerPrintSetting('AudioLeveler_ceiling');
                        AudioLevelerPrintSetting('AudioLeveler_match');
                        AudioLevelerPrintSetting('AudioLeveler_bgOffset');
                        ?>
                    </div>

                    <div class="al-adv">
                    <div class="fw-semibold mb-1">Fixes</div>
                    <div class="form-text mt-0 mb-1">Each song uses the fix shown in its <i>Fix</i> column. Every song starts on <b>Recommended</b>;
                        pick another for any song, or tick several and use <b>Set fix</b>.</div>
                    <ul class="form-text ps-3 mb-3">
                        <li><b>Recommended</b>: the gentlest fix that does the job. A plain volume change (lossless for MP3s) whenever it's enough,
                            the limiter only when it takes 3 dB or less of peak trimming, and otherwise volume only, landing a little quieter
                            rather than squashing the song. Never compresses on its own.</li>
                        <li><b>Volume only</b>: just turns the song up or down. Never changes the sound, but a quiet song with big peaks may not reach the target.</li>
                        <li><b>Limiter</b>: turns the song up or down and gently catches the peaks, so it hits the target without clipping.</li>
                        <li><b>Compression</b>: also evens out quiet intros and loud choruses. Good outdoors or over FM, where quiet parts get lost.</li>
                        <li><b>Background</b>: deliberately under the show, by the Background level above. <b>Skip</b>: left alone.</li>
                    </ul>
                    </div>

                    <div class="settingsTable container-fluid px-0">
                        <?php
                        AudioLevelerPrintSetting('AudioLeveler_autoLevel');
                        AudioLevelerPrintSetting('AudioLeveler_waitIdle');
                        ?>
                    </div>
                    <div class="settingsTable container-fluid px-0 al-adv">
                        <?php
                        // With FPP's Normalize (FPP 10.4+) it does the leveling and files
                        // aren't changed; the limiter is the one thing to opt into. Older
                        // FPP has no Normalize, so files are changed, losslessly for MP3s.
                        if (AudioLevelerPlaybackGainSupported()) {
                            AudioLevelerPrintSetting('AudioLeveler_allowLimiter');
                        } else {
                            AudioLevelerPrintSetting('AudioLeveler_lossless');
                        }
                        AudioLevelerPrintSetting('AudioLeveler_backup');
                        ?>
                    </div>
                    <div class="form-text al-simple-only">More settings (peak ceiling, matching, Background level, the limiter, backups and
                        what each target means for your songs) are under <b>Advanced</b>. The defaults suit most shows, including FM.</div>
                </div>
            </div>
        </div>

        <!-- Songs -->
        <div class="col-12 col-xl-8">
            <div class="card">
                <div class="card-header d-flex flex-wrap gap-2 align-items-end">
                    <span id="alListTitle" class="visually-hidden">Songs</span>
                    <!-- Songs and videos are separate lists; buttons act on the open tab -->
                    <ul id="alTabs" class="nav nav-tabs card-header-tabs me-auto" role="tablist">
                        <li class="nav-item" role="presentation">
                            <button id="alTabSongs" type="button" class="nav-link active" role="tab" aria-selected="true" data-tab="songs">
                                Songs <span class="badge rounded-pill text-bg-secondary fw-normal">0</span></button>
                        </li>
                        <li id="alTabVideosItem" class="nav-item d-none" role="presentation">
                            <button id="alTabVideos" type="button" class="nav-link" role="tab" aria-selected="false" data-tab="videos">
                                Videos <span class="badge rounded-pill text-bg-secondary fw-normal">0</span></button>
                        </li>
                    </ul>
                    <div class="d-flex gap-2 mb-1">
                        <button id="alMeasure" type="button" class="buttons btn btn-outline-secondary">Measure songs</button>
                        <button id="alLevelAll" type="button" class="buttons btn btn-success">Level all</button>
                    </div>
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

                    <p class="small text-body-secondary mb-3">
                        Leveling is slow on a Pi, often a minute or more per song, so a whole library can take a few hours.
                        It's fine to leave it running overnight; it waits for shows. Uploading a song again (including from xLights)
                        replaces the leveled copy, and it's then marked <b>Replaced since leveling</b>. Just level it again.
                    </p>

                    <div id="alSilentNote" class="small text-body-secondary mb-2 d-none"></div>
                    <div id="alLateNote" class="alert alert-warning d-flex flex-wrap align-items-center gap-2 py-2 small d-none">
                        <span class="me-auto"><b id="alLateCount"></b> play about 25 ms late on FPP: ffmpeg made them and labelled their
                            timing tag in a way FPP's player can't read. Fixing it changes only that label; the audio stays exactly the same.</span>
                        <button id="alRetime" type="button" class="buttons btn btn-sm btn-warning">Fix MP3 timing</button>
                    </div>

                    <!-- At-a-glance numbers -->
                    <div id="alStats" class="row g-2 mb-3"></div>

                    <!-- Filters and search -->
                    <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
                        <div id="alFilters" class="d-flex flex-wrap gap-1" role="group" aria-label="Show songs">
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill active" aria-pressed="true" data-filter="all">All</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="off">Off target</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="clip">Clipping</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="leveled">Leveled</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="replaced">Replaced</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="unmeasured">Not measured</button>
                            <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" aria-pressed="false" data-filter="custom">Custom fix</button>
                        </div>
                        <input id="alSearch" type="search" class="form-control form-control-sm w-auto ms-auto" placeholder="Search" aria-label="Search this list">
                    </div>

                    <!-- Selection bar: acts on the ticked songs -->
                    <div class="d-flex flex-wrap gap-2 align-items-center rounded border bg-body-tertiary px-2 py-1 mb-2">
                        <span id="alSelText" class="small text-body-secondary me-auto">No songs selected</span>
                        <button id="alClearSel" type="button" class="btn btn-sm btn-link d-none">Clear</button>
                        <select id="alSetFix" class="form-select form-select-sm w-auto" aria-label="Set the fix for the selected songs" disabled>
                            <option value="">Set fix&hellip;</option>
                            <option value="default">Recommended</option>
                            <option value="volume">Volume only</option>
                            <option value="limit">Limiter</option>
                            <option value="compress">Compression</option>
                            <option value="background">Background</option>
                            <option value="skip">Skip</option>
                        </select>
                        <button id="alLevelSel" type="button" class="buttons btn btn-sm btn-success" disabled>Level selected</button>
                        <button id="alRestoreSel" type="button" class="buttons btn btn-sm btn-outline-secondary" disabled>Restore originals</button>
                    </div>

                    <div class="al-scroll mb-2">
                        <table class="table table-sm table-hover align-middle mb-0">
                            <thead>
                                <tr>
                                    <th scope="col" class="text-center"><input id="alSelectAll" class="form-check-input" type="checkbox" aria-label="Select all shown songs"></th>
                                    <th scope="col"><button type="button" class="al-sort btn btn-link p-0 fw-semibold text-reset text-decoration-none" data-sort="name"><span id="alNameHead">Song</span> <span class="al-sort-icon text-body-secondary"></span></button></th>
                                    <th scope="col" class="text-end"><button type="button" class="al-sort btn btn-link p-0 fw-semibold text-reset text-decoration-none" data-sort="lufs">Loudness <span class="al-sort-icon text-body-secondary"></span></button></th>
                                    <th scope="col" class="text-end d-none d-sm-table-cell"><button type="button" class="al-sort btn btn-link p-0 fw-semibold text-reset text-decoration-none" data-sort="peak">Peak <span class="al-sort-icon text-body-secondary"></span></button></th>
                                    <th scope="col" class="d-none d-lg-table-cell">Status</th>
                                    <th scope="col" class="d-none d-lg-table-cell">Fix</th>
                                    <th scope="col" class="text-end d-none d-sm-table-cell"></th>
                                </tr>
                            </thead>
                            <tbody id="alRows">
                                <tr><td colspan="7" class="text-body-secondary">Loading&hellip;</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="d-flex flex-wrap gap-2 align-items-center">
                        <span id="alBackupInfo" class="small text-body-secondary me-auto"></span>
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
$audioLevelerScript = __DIR__ . '/assets/audioleveler.js';
$audioLevelerVer = file_exists($audioLevelerScript) ? filemtime($audioLevelerScript) : time();
$audioLevelerStyle = __DIR__ . '/assets/audioleveler.css';
$audioLevelerCssVer = file_exists($audioLevelerStyle) ? filemtime($audioLevelerStyle) : time();
?>
<link rel="stylesheet" type="text/css" href="plugin.php?plugin=AudioLeveler&amp;file=assets/audioleveler.css&amp;nopage=1&amp;v=<?php echo $audioLevelerCssVer; ?>">
<script type="text/javascript" src="plugin.php?plugin=AudioLeveler&amp;file=assets/audioleveler.js&amp;nopage=1&amp;v=<?php echo $audioLevelerVer; ?>"></script>
