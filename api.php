<?php
// Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2.
/*
 * Audio Leveler - HTTP API
 *
 * All endpoints live under /api/plugin/AudioLeveler/...
 *
 *   GET    files      songs in the music folder (and videos, named "videos/<file>") with their measurements
 *   GET    job        progress of the current / last job
 *   POST   analyze    measure loudness            body: {"files": [...]|"all", "scope": "songs"|"videos", "force": bool}
 *   POST   level      level songs                 body: {"files": [...]|"all", "target", "ceiling", "mode", "backup", "waitIdle"}
 *   POST   restore    put originals back          body: {"files": [...]|"all"}
 *   POST   retime     MP3s that play 25 ms late on FPP back in step   body: {"files": [...]|"all"}
 *   GET    tags       each song's Title and Artist (the Song info tab)
 *   POST   tags       change them                 body: {"edits": {"<song>": {"title", "artist"}}}
 *   POST   gainsize   the worker grew a song's tag: keep FPP's Normalize setting for it   body: {"file", "oldSize"}
 *   POST   cancel     stop the running job after the current song
 *   GET    options    the saved settings (FPP saves them: settings.json + PrintPluginSetting)
 *   POST   settingschanged   the page saved a setting: refresh what background work uses
 *   DELETE backups    delete every backed-up original
 *
 * The heavy lifting is done by bin/leveler.py, started in the background at
 * low priority so a web request never waits on ffmpeg. fppd starts it, through
 * the plugin's "Audio Leveler: Start Job" command, so a job never runs under
 * the web server; only when fppd can't be asked is it started from here.
 */

define('AUDIOLEVELER_START_COMMAND', 'Audio Leveler: Start Job');

function getEndpointsAudioLeveler()
{
    return array(
        array('method' => 'GET', 'endpoint' => 'files', 'callback' => 'AudioLevelerFiles'),
        array('method' => 'GET', 'endpoint' => 'job', 'callback' => 'AudioLevelerJob'),
        array('method' => 'POST', 'endpoint' => 'analyze', 'callback' => 'AudioLevelerAnalyze'),
        array('method' => 'POST', 'endpoint' => 'level', 'callback' => 'AudioLevelerLevel'),
        array('method' => 'POST', 'endpoint' => 'restore', 'callback' => 'AudioLevelerRestore'),
        array('method' => 'POST', 'endpoint' => 'retime', 'callback' => 'AudioLevelerRetime'),
        array('method' => 'POST', 'endpoint' => 'cancel', 'callback' => 'AudioLevelerCancel'),
        array('method' => 'GET', 'endpoint' => 'options', 'callback' => 'AudioLevelerGetOptions'),
        array('method' => 'POST', 'endpoint' => 'settingschanged', 'callback' => 'AudioLevelerSettingsChanged'),
        array('method' => 'DELETE', 'endpoint' => 'backups', 'callback' => 'AudioLevelerDeleteBackups'),
        array('method' => 'POST', 'endpoint' => 'choice', 'callback' => 'AudioLevelerSetChoice'),
        array('method' => 'POST', 'endpoint' => 'autocheck', 'callback' => 'AudioLevelerAutoCheck'),
        array('method' => 'GET', 'endpoint' => 'gains', 'callback' => 'AudioLevelerGains'),
        array('method' => 'POST', 'endpoint' => 'checkvideos', 'callback' => 'AudioLevelerCheckVideos'),
        array('method' => 'GET', 'endpoint' => 'tags', 'callback' => 'AudioLevelerTags'),
        array('method' => 'POST', 'endpoint' => 'tags', 'callback' => 'AudioLevelerSetTags'),
        array('method' => 'POST', 'endpoint' => 'gainsize', 'callback' => 'AudioLevelerGainSize'),
    );
}

define('AUDIOLEVELER_PLUGIN', 'AudioLeveler');

// The settings, saved by FPP as AudioLeveler_<name> in config/plugin.AudioLeveler.
// Defaults match settings.json.
function AudioLevelerDefaults()
{
    return array(
        'target' => -14.0,   // LUFS
        'ceiling' => -1.5,   // dBTP; FM-safe, as FPP's Normalize
        'bgOffset' => 10.0,  // dB under the target for songs set to Background
        'backup' => true,
        'waitIdle' => true,
        'lossless' => true,  // change MP3 volume losslessly when no limiting is needed
        'autoLevel' => false, // level new and replaced songs automatically
        'allowLimiter' => false, // where FPP has Normalize: let the limiter rewrite songs Normalize leaves short
        'match' => 'speakers', // speakers (ignore deep bass, as FPP's Normalize) | lufs
    );
}

function AudioLevelerDataDir()
{
    global $settings;
    $dir = $settings['mediaDirectory'] . '/plugindata/' . AUDIOLEVELER_PLUGIN;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

function AudioLevelerMusicDir()
{
    global $settings;
    return rtrim($settings['musicDirectory'], '/');
}

// The videos folder (videos have their own tab).
function AudioLevelerVideoDir()
{
    global $settings;
    $dir = isset($settings['videoDirectory']) ? $settings['videoDirectory'] : $settings['mediaDirectory'] . '/videos';
    return rtrim($dir, '/');
}

function AudioLevelerLogFile()
{
    global $settings;
    return rtrim($settings['logDirectory'], '/') . '/plugin-' . AUDIOLEVELER_PLUGIN . '.log';
}

// FPP versions with File Manager > Normalize turn each song up or down as it
// plays. Where that exists, volume-only fixes go there (exact, lossless, any
// format) instead of into the file. Those gains are FPP's own data: they're
// set and removed only through FPP's Normalize (run_normalize.php, the same
// request the File Manager makes) and read with FPP's own helper, never by
// touching the file they're kept in.
function AudioLevelerFppDir()
{
    global $settings;
    return rtrim(isset($settings['fppDir']) ? $settings['fppDir'] : '/opt/fpp', '/');
}

function AudioLevelerPlaybackGainSupported()
{
    return file_exists(AudioLevelerFppDir() . '/www/run_normalize.php')
        && file_exists(AudioLevelerFppDir() . '/www/common/audioNormalize.inc.php');
}

// {name: {gainDb, size}} for every song ("name") and video ("videos/name")
// FPP applies a gain to, from FPP's helper.
function AudioLevelerLoadGains()
{
    if (!AudioLevelerPlaybackGainSupported()) {
        return array();
    }
    if (!function_exists('AN_LoadGains')) {
        require_once AudioLevelerFppDir() . '/www/common/audioNormalize.inc.php';
    }
    $out = array();
    foreach (AN_LoadGains() as $name => $e) {
        if (is_array($e) && isset($e['gainDb'], $e['size'])) {
            $out[$name] = array('gainDb' => floatval($e['gainDb']), 'size' => intval($e['size']));
        }
    }
    return $out;
}

// What the worker needs to use playback gain (or not).
function AudioLevelerPlaybackGainRequest($opt)
{
    // Where FPP has Normalize, it always does the leveling.
    $on = AudioLevelerPlaybackGainSupported();
    return array(
        'enabled' => $on,
        'supported' => AudioLevelerPlaybackGainSupported(),
    );
}

// GET /api/plugin/AudioLeveler/gains   (for the worker)
function AudioLevelerGains()
{
    AudioLevelerNoCache();
    return json(array('status' => 'OK', 'gains' => (object) AudioLevelerLoadGains()));
}

function AudioLevelerLog($msg)
{
    @file_put_contents(AudioLevelerLogFile(), date('Y-m-d H:i:s') . ' ' . $msg . "\n", FILE_APPEND | LOCK_EX);
}

function AudioLevelerReadJson($path, $default)
{
    if (!file_exists($path)) {
        return $default;
    }
    $j = json_decode(@file_get_contents($path), true);
    return is_array($j) ? $j : $default;
}

define('AUDIOLEVELER_VIDEO_PREFIX', 'videos/');

// A song in the music folder ("name.mp3") or a video in the videos folder
// ("videos/name.mp4", the same key FPP's media_gain.json uses).
function AudioLevelerIsAudio($name)
{
    if (!is_string($name) || $name === '') {
        return false;
    }
    $exts = array('mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav', 'flac');
    if (strpos($name, AUDIOLEVELER_VIDEO_PREFIX) === 0) {
        $name = substr($name, strlen(AUDIOLEVELER_VIDEO_PREFIX));
        $exts = array('mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi');
    }
    if ($name === '' || $name !== basename($name) || $name[0] === '.') {
        return false;
    }
    return in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), $exts);
}

// Progress and song lists change constantly; make sure no browser or proxy
// hands the page an old copy.
function AudioLevelerNoCache()
{
    header('Cache-Control: no-store, max-age=0');
}

function AudioLevelerError($code, $msg)
{
    http_response_code($code);
    return json(array('status' => 'ERROR', 'message' => $msg));
}

function AudioLevelerJobData()
{
    $job = AudioLevelerReadJson(AudioLevelerDataDir() . '/job.json', array());
    // A job that says it is running but whose process is gone was killed
    // (power cut, reboot); report it as stopped rather than spinning forever.
    if (isset($job['state']) && in_array($job['state'], array('running', 'waiting'))) {
        $pid = isset($job['pid']) ? intval($job['pid']) : 0;
        if ($pid <= 0 || !file_exists("/proc/$pid")) {
            $job['state'] = 'error';
            $job['message'] = 'The last job stopped unexpectedly. You can start it again.';
        }
    }
    if (isset($job['state']) && $job['state'] === 'starting') {
        $age = time() - (isset($job['requested']) ? intval($job['requested']) : 0);
        if ($age > 30) {
            $job['state'] = 'error';
            $log = AudioLevelerLogFile();
            if (file_exists($log) && !is_writable($log)) {
                $job['message'] = 'The job did not start because the plugin log is not writable. '
                    . 'Update or reinstall Audio Leveler in the Plugin Manager to fix the file permissions.';
            } else {
                $job['message'] = 'The job did not start. Check the plugin log (Help > FPP Logs).';
            }
        }
    }
    return $job;
}

function AudioLevelerBusy()
{
    $job = AudioLevelerJobData();
    return isset($job['state']) && in_array($job['state'], array('starting', 'running', 'waiting'));
}

function AudioLevelerBody()
{
    $body = json_decode(file_get_contents('php://input'), true);
    return is_array($body) ? $body : array();
}

function AudioLevelerCleanFiles($files)
{
    if ($files === 'all' || $files === null) {
        return 'all';
    }
    if (!is_array($files)) {
        return array();
    }
    $out = array();
    foreach ($files as $f) {
        if (AudioLevelerIsAudio($f)) {
            $out[] = $f;
        }
    }
    return $out;
}

// Which list an "all" request covers: the Songs tab or the Videos tab.
function AudioLevelerScope($body)
{
    $scope = isset($body['scope']) ? $body['scope'] : '';
    return in_array($scope, array('songs', 'videos'), true) ? $scope : 'songs';
}

function AudioLevelerStart($command, $request)
{
    if (AudioLevelerBusy()) {
        return AudioLevelerError(409, 'A job is already running. Wait for it to finish or cancel it first.');
    }
    if (is_array($request['files']) && count($request['files']) == 0) {
        return AudioLevelerError(400, 'No songs selected.');
    }

    $data = AudioLevelerDataDir();
    $reqFile = $data . '/request.json';
    $previousJob = @file_get_contents($data . '/job.json');
    file_put_contents($reqFile, json_encode($request));
    @unlink($data . '/cancel');
    file_put_contents($data . '/job.json', json_encode(array(
        'cmd' => $command,
        'state' => 'starting',
        'requested' => time(),
        'done' => 0,
        'total' => 0,
        'results' => array(),
    )));

    // The worker's command line, for fppd's Start Job command to run.
    $argv = array($command, '--music', AudioLevelerMusicDir(), '--videos', AudioLevelerVideoDir(), '--data', $data,
        '--log', AudioLevelerLogFile(), '--request', $reqFile);
    file_put_contents($data . '/launch.json', json_encode(array('argv' => $argv)));

    if (AudioLevelerRunCommand('Queued job')) {
        AudioLevelerLog("Started $command job");
        return json(array('status' => 'OK'));
    }
    // All background work runs under fppd, never under the web server.
    // Nothing started: the page goes back to showing the last job.
    @unlink($data . '/launch.json');
    if ($previousJob !== false) {
        file_put_contents($data . '/job.json', $previousJob);
    } else {
        @unlink($data . '/job.json');
    }
    return AudioLevelerError(503, 'FPPD isn\'t running, so the job can\'t start. Start FPPD (top of any FPP page), then try again.');
}

/* Ask fppd to run the Start Job command with this Task. False if fppd can't be asked or doesn't have the command. */
function AudioLevelerRunCommand($task)
{
    // Looked up first: running a command fppd doesn't have puts a warning on every FPP page.
    $ctx = stream_context_create(array('http' => array('timeout' => 3, 'ignore_errors' => true)));
    $list = json_decode((string) @file_get_contents('http://127.0.0.1/api/commands', false, $ctx), true);
    $known = false;
    foreach (is_array($list) ? $list : array() as $c) {
        if (is_array($c) && isset($c['name']) && $c['name'] === AUDIOLEVELER_START_COMMAND) {
            $known = true;
            break;
        }
    }
    if (!$known) {
        return false;
    }
    $ctx = stream_context_create(array('http' => array(
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode(array($task)),
        'timeout' => 10,
        'ignore_errors' => true,
    )));
    $ok = @file_get_contents('http://127.0.0.1/api/command/' . rawurlencode(AUDIOLEVELER_START_COMMAND), false, $ctx);
    $headers = isset($http_response_header) ? $http_response_header : array();
    return $ok !== false && isset($headers[0]) && preg_match('#^HTTP/\S+\s+200#', $headers[0]);
}

// Whether a video has a sound track: true, false, or null when it hasn't
// been checked yet. Checking (bin/probe_videos.py, one quick ffprobe of the
// header per video) runs in the background, so a folder of hundreds of
// videos never holds up the page; answers land in videoprobe.json.
function AudioLevelerVideoHasAudio($name, $size, $mtime, $analysis, $cache)
{
    if (isset($analysis[$name]) && $analysis[$name]['size'] == $size && $analysis[$name]['mtime'] == $mtime) {
        return empty($analysis[$name]['noAudio']);
    }
    if (isset($cache[$name]) && $cache[$name]['size'] == $size && $cache[$name]['mtime'] == $mtime) {
        return !empty($cache[$name]['audio']);
    }
    return null;
}

// POST /api/plugin/AudioLeveler/checkvideos
// The page asks for this while the list says videos are still unchecked.
// The check (bin/probe_videos.py) runs under fppd; one at a time.
function AudioLevelerCheckVideos()
{
    AudioLevelerWriteAutoSettings(); // the command reads the videos folder from auto.json
    $lock = @fopen(AudioLevelerDataDir() . '/probe.lock', 'c');
    if ($lock) {
        $free = flock($lock, LOCK_EX | LOCK_NB);
        if ($free) {
            flock($lock, LOCK_UN);
        }
        fclose($lock);
        if (!$free) {
            return json(array('status' => 'OK', 'running' => true));
        }
    }
    if (!AudioLevelerRunCommand('Check videos for sound')) {
        return AudioLevelerError(503, 'FPPD isn\'t running, so videos can\'t be checked for sound yet.');
    }
    return json(array('status' => 'OK', 'running' => true));
}

// True if FPP (GStreamer) plays this MP3's encoder lead-in, about 25 ms,
// because ffmpeg labelled its gapless tag "Lavc"/"Lavf" instead of "LAME"
// (GStreamer only reads a LAME one). Reads just the start of the file.
// Mirrors plays_late_on_fpp() in bin/mp3lossless.py.
function AudioLevelerMp3PlaysLate($path)
{
    $fh = @fopen($path, 'rb');
    if (!$fh) {
        return false;
    }
    $head = fread($fh, 10);
    $pos = 0;
    if (strlen($head) === 10 && substr($head, 0, 3) === 'ID3') {
        $size = 0;
        for ($i = 6; $i < 10; $i++) {
            $size = ($size << 7) | (ord($head[$i]) & 0x7f);
        }
        $pos = 10 + $size + ((ord($head[5]) & 0x10) ? 10 : 0);
    }
    fseek($fh, $pos);
    $d = fread($fh, 400);
    fclose($fh);
    if (strlen($d) < 200) {
        return false;
    }
    $h = unpack('N', substr($d, 0, 4))[1];
    if ((($h >> 21) & 0x7ff) !== 0x7ff || (($h >> 17) & 3) !== 1) {
        return false; // not an MPEG layer III frame
    }
    $mpeg1 = (($h >> 19) & 3) === 3;
    $mono = (($h >> 6) & 3) === 3;
    $side = $mpeg1 ? ($mono ? 17 : 32) : ($mono ? 9 : 17);
    $x = 4 + $side;
    $id = substr($d, $x, 4);
    if ($id !== 'Info' && $id !== 'Xing') {
        return false;
    }
    $flags = unpack('N', substr($d, $x + 4, 4))[1];
    $tag = $x + 8 + (($flags & 1) ? 4 : 0) + (($flags & 2) ? 4 : 0) + (($flags & 4) ? 100 : 0) + (($flags & 8) ? 4 : 0);
    $label = substr($d, $tag, 4);
    return $label === 'Lavc' || $label === 'Lavf';
}

// GET /api/plugin/AudioLeveler/files
function AudioLevelerFiles()
{
    AudioLevelerNoCache();
    $music = AudioLevelerMusicDir();
    $data = AudioLevelerDataDir();
    $analysis = AudioLevelerReadJson($data . '/analysis.json', array());
    $leveled = AudioLevelerReadJson($data . '/leveled.json', array());
    $choices = AudioLevelerReadJson($data . '/choices.json', array());
    $gains = AudioLevelerLoadGains();
    $backupDir = $data . '/backups';

    $files = array();
    $silentVideos = 0;
    $checking = 0;
    $probe = AudioLevelerReadJson($data . '/videoprobe.json', array());
    $names = array();
    foreach (is_dir($music) ? scandir($music) : array() as $n) {
        $names[$n] = "$music/$n";
    }
    $videoDir = AudioLevelerVideoDir();
    if ($videoDir !== '' && is_dir($videoDir)) {
        foreach (scandir($videoDir) as $n) {
            $names[AUDIOLEVELER_VIDEO_PREFIX . $n] = "$videoDir/$n";
        }
    }
    foreach ($names as $name => $path) {
        if (!AudioLevelerIsAudio($name) || !is_file($path)) {
            continue;
        }
        $size = filesize($path);
        $mtime = filemtime($path);
        $row = array('name' => $name, 'size' => $size, 'mtime' => $mtime);
        // An MP3 whose gapless tag FPP can't read plays 25 ms late.
        if (strtolower(substr($name, -4)) === '.mp3') {
            $row['lateTag'] = AudioLevelerMp3PlaysLate($path);
        }
        if (strpos($name, AUDIOLEVELER_VIDEO_PREFIX) === 0) {
            // Videos without sound have nothing to level: left off the list,
            // as are ones not checked yet (they appear as the check gets to them).
            $audio = AudioLevelerVideoHasAudio($name, $size, $mtime, $analysis, $probe);
            if ($audio === null) {
                $checking++;
                continue;
            }
            if (!$audio) {
                $silentVideos++;
                continue;
            }
            $row['video'] = true;
        }

        $a = isset($analysis[$name]) ? $analysis[$name] : null;
        if ($a && $a['size'] == $size && $a['mtime'] == $mtime) {
            $row['lufs'] = isset($a['I']) ? $a['I'] : null;
            $row['peak'] = isset($a['TP']) ? $a['TP'] : null;
            $row['lra'] = isset($a['LRA']) ? $a['LRA'] : null;
            $row['length'] = isset($a['len']) ? $a['len'] : null;
            $row['spk'] = isset($a['spk']) ? $a['spk'] : null;
            $row['hasSpk'] = array_key_exists('spk', $a);
            $row['measured'] = true;

            if (!empty($a['noAudio'])) {
                $row['noAudio'] = true;
            }
        } else {
            $row['measured'] = false;
        }

        $l = isset($leveled[$name]) ? $leveled[$name] : null;
        if ($l) {
            if ($l['size'] == $size && $l['mtime'] == $mtime) {
                $row['leveled'] = array(
                    'target' => $l['target'],
                    'mode' => $l['mode'],
                    'gain' => $l['gain'],
                    'limited' => !empty($l['limited']),
                    'method' => isset($l['method']) ? $l['method'] : 'encoded',
                    'at' => $l['at'],
                );
            } else {
                $row['changedSinceLeveled'] = true;
            }
        }
        $row['backup'] = file_exists("$backupDir/$name");
        $row['choice'] = isset($choices[$name]) ? $choices[$name] : 'default';
        // A playback gain fppd will apply (ours, or one FPP's Normalize set):
        // only while the entry still matches this exact file.
        if (isset($gains[$name]) && is_array($gains[$name]) && isset($gains[$name]['gainDb'], $gains[$name]['size'])
            && intval($gains[$name]['size']) === $size) {
            $row['pbGain'] = floatval($gains[$name]['gainDb']);
            // Ours when this plugin leveled this exact file with a playback gain.
            $row['pbSource'] = ($l && isset($l['method']) && $l['method'] === 'playback'
                && $l['size'] == $size && $l['mtime'] == $mtime) ? 'plugin' : 'fpp';
        }
        $files[] = $row;
    }


    $backupBytes = 0;
    $backupCount = 0;
    foreach (AudioLevelerBackupFiles() as $b) {
        $backupBytes += filesize($b);
        $backupCount++;
    }

    return json(array(
        'status' => 'OK',
        'files' => $files,
        'silentVideos' => $silentVideos,
        'videosChecking' => $checking,
        'backups' => array('count' => $backupCount, 'bytes' => $backupBytes),
        'freeBytes' => @disk_free_space($music),
        'haveFfmpeg' => trim(shell_exec('command -v ffmpeg 2>/dev/null')) !== '',
        'playbackGainSupported' => AudioLevelerPlaybackGainSupported(),
        'playbackGainVideos' => AudioLevelerPlaybackGainSupported(),
    ));
}

// Every backed-up original: songs in backups/, videos in backups/videos/.
function AudioLevelerBackupFiles()
{
    $dir = AudioLevelerDataDir() . '/backups';
    $out = array();
    foreach (array('' => $dir, AUDIOLEVELER_VIDEO_PREFIX => "$dir/videos") as $prefix => $d) {
        if (!is_dir($d)) {
            continue;
        }
        foreach (scandir($d) as $f) {
            if (AudioLevelerIsAudio($prefix . $f) && is_file("$d/$f")) {
                $out[] = "$d/$f";
            }
        }
    }
    return $out;
}

// GET /api/plugin/AudioLeveler/job
function AudioLevelerJob()
{
    AudioLevelerNoCache();
    $job = AudioLevelerJobData();
    $job['status'] = 'OK';
    return json($job);
}

// POST /api/plugin/AudioLeveler/analyze
function AudioLevelerAnalyze()
{
    $body = AudioLevelerBody();
    return AudioLevelerStart('analyze', array(
        'files' => AudioLevelerCleanFiles(isset($body['files']) ? $body['files'] : 'all'),
        'scope' => AudioLevelerScope($body),
        'force' => !empty($body['force']),
        'match' => AudioLevelerOptions()['match'] === 'lufs' ? 'lufs' : 'speakers',
    ));
}

// POST /api/plugin/AudioLeveler/level
function AudioLevelerLevel()
{
    $body = AudioLevelerBody();
    $opt = AudioLevelerOptions();
    // Songs without a fix of their own always use the recommendation.
    $mode = 'auto';
    return AudioLevelerStart('level', array(
        'files' => AudioLevelerCleanFiles(isset($body['files']) ? $body['files'] : 'all'),
        'scope' => AudioLevelerScope($body),
        'target' => max(-30, min(-6, floatval($opt['target']))),
        'ceiling' => max(-6, min(0, floatval($opt['ceiling']))),
        'mode' => $mode,
        'backup' => (bool) $opt['backup'],
        'waitIdle' => (bool) $opt['waitIdle'],
        'lossless' => (bool) $opt['lossless'],
        'bgOffset' => max(3, min(30, floatval($opt['bgOffset']))),
        'playbackGain' => AudioLevelerPlaybackGainRequest($opt),
        'allowLimiter' => AudioLevelerPlaybackGainSupported() && !empty($opt['allowLimiter']),
        'match' => $opt['match'] === 'lufs' ? 'lufs' : 'speakers',
    ));
}

// POST /api/plugin/AudioLeveler/restore
function AudioLevelerRestore()
{
    $body = AudioLevelerBody();
    $opt = AudioLevelerOptions();
    return AudioLevelerStart('restore', array(
        'files' => AudioLevelerCleanFiles(isset($body['files']) ? $body['files'] : 'all'),
        'scope' => AudioLevelerScope($body),
        'waitIdle' => (bool) $opt['waitIdle'],
        'playbackGain' => AudioLevelerPlaybackGainRequest($opt),
        'allowLimiter' => AudioLevelerPlaybackGainSupported() && !empty($opt['allowLimiter']),
        'match' => $opt['match'] === 'lufs' ? 'lufs' : 'speakers',
    ));
}

// POST /api/plugin/AudioLeveler/retime
// Put MP3s that play 25 ms late on FPP back in step (relabels their gapless tag).
function AudioLevelerRetime()
{
    $body = AudioLevelerBody();
    $opt = AudioLevelerOptions();
    return AudioLevelerStart('retime', array(
        'files' => AudioLevelerCleanFiles(isset($body['files']) ? $body['files'] : 'all'),
        'scope' => 'songs',
        'waitIdle' => (bool) $opt['waitIdle'],
        'backup' => (bool) $opt['backup'],
        'playbackGain' => AudioLevelerPlaybackGainRequest($opt),
        'match' => $opt['match'] === 'lufs' ? 'lufs' : 'speakers',
    ));
}

// POST /api/plugin/AudioLeveler/cancel
function AudioLevelerCancel()
{
    if (AudioLevelerBusy()) {
        touch(AudioLevelerDataDir() . '/cancel');
        AudioLevelerLog('Cancel requested');
    }
    return json(array('status' => 'OK'));
}

function AudioLevelerOptions()
{
    $opt = AudioLevelerDefaults();
    foreach ($opt as $k => $v) {
        $saved = ReadSettingFromFile('AudioLeveler_' . $k, AUDIOLEVELER_PLUGIN);
        if ($saved === false || $saved === '' || $saved === null) {
            continue;
        }
        if (is_bool($v)) {
            $opt[$k] = ($saved === '1' || $saved === 'true');
        } elseif (is_float($v)) {
            $f = floatval($saved);
            $opt[$k] = is_finite($f) ? $f : $v;
        } else {
            $opt[$k] = $saved;
        }
    }
    // Saved values can come from anyone on the network (FPP's settings API
    // has no login by default): keep them in range here, where they're used.
    // The worker clamps to the same ranges.
    $opt['target'] = max(-30.0, min(-6.0, $opt['target']));
    $opt['ceiling'] = max(-6.0, min(0.0, $opt['ceiling']));
    $opt['bgOffset'] = max(3.0, min(30.0, $opt['bgOffset']));
    if (!in_array($opt['match'], array('speakers', 'lufs'), true)) {
        $opt['match'] = 'speakers';
    }
    return $opt;
}

// GET /api/plugin/AudioLeveler/options
function AudioLevelerGetOptions()
{
    AudioLevelerNoCache();
    return json(array('status' => 'OK', 'options' => AudioLevelerOptions()));
}

// POST /api/plugin/AudioLeveler/settingschanged
// FPP saved one of the settings (the page's setting rows call this after each
// save). Automatic leveling only handles files added or changed after it was
// switched on, so switching it on never sweeps a whole library: note when.
function AudioLevelerSettingsChanged()
{
    $opt = AudioLevelerOptions();
    $since = ReadSettingFromFile('AudioLeveler_autoSince', AUDIOLEVELER_PLUGIN);
    if ($opt['autoLevel'] && !$since) {
        WriteSettingToFile('AudioLeveler_autoSince', (string) time(), AUDIOLEVELER_PLUGIN);
    } elseif (!$opt['autoLevel'] && $since) {
        WriteSettingToFile('AudioLeveler_autoSince', '', AUDIOLEVELER_PLUGIN);
    }
    AudioLevelerWriteAutoSettings();
    return json(array('status' => 'OK', 'options' => AudioLevelerOptions()));
}

// The settings automatic leveling uses, for the worker started from fppd's
// callbacks (which can't read the page's settings): plugindata/.../auto.json.
function AudioLevelerWriteAutoSettings()
{
    $opt = AudioLevelerOptions();
    $auto = array(
        'enabled' => (bool) $opt['autoLevel'],
        'target' => max(-30, min(-6, floatval($opt['target']))),
        'ceiling' => max(-6, min(0, floatval($opt['ceiling']))),
        'bgOffset' => max(3, min(30, floatval($opt['bgOffset']))),
        'lossless' => (bool) $opt['lossless'],
        'backup' => (bool) $opt['backup'],
        // A job waiting for the show to end re-reads this, so unticking
        // "Wait until no show is playing" lets it carry on at once.
        'waitIdle' => (bool) $opt['waitIdle'],
        'since' => intval(ReadSettingFromFile('AudioLeveler_autoSince', AUDIOLEVELER_PLUGIN)),
        'playbackGain' => AudioLevelerPlaybackGainRequest($opt),
        'allowLimiter' => AudioLevelerPlaybackGainSupported() && !empty($opt['allowLimiter']),
        'match' => $opt['match'] === 'lufs' ? 'lufs' : 'speakers',
        'music' => AudioLevelerMusicDir(),
        'videos' => AudioLevelerVideoDir(),
        'log' => AudioLevelerLogFile(),
    );
    $path = AudioLevelerDataDir() . '/auto.json';
    $json = json_encode($auto, JSON_PRETTY_PRINT);
    if (!file_exists($path) || @file_get_contents($path) !== $json) {
        @file_put_contents($path . '.tmp', $json);
        @rename($path . '.tmp', $path);
    }
}

// POST /api/plugin/AudioLeveler/autocheck
// The page asks for a check when it opens. Does nothing unless automatic
// leveling is on; returns at once (the worker finds and levels new songs in
// the background, waiting for any show to end).
function AudioLevelerAutoCheck()
{
    AudioLevelerWriteAutoSettings();
    if (!AudioLevelerOptions()['autoLevel'] || AudioLevelerBusy()) {
        return json(array('status' => 'OK', 'started' => false));
    }
    if (!AudioLevelerRunCommand('Level new uploads')) {
        return json(array('status' => 'OK', 'started' => false));
    }
    return json(array('status' => 'OK', 'started' => true));
}

// DELETE /api/plugin/AudioLeveler/backups
function AudioLevelerDeleteBackups()
{
    if (AudioLevelerBusy()) {
        return AudioLevelerError(409, 'Wait for the running job to finish first.');
    }
    $n = 0;
    foreach (AudioLevelerBackupFiles() as $f) {
        if (@unlink($f)) {
            $n++;
        }
    }
    AudioLevelerLog("Deleted $n backup(s)");
    return json(array('status' => 'OK', 'deleted' => $n));
}

// POST /api/plugin/AudioLeveler/choice   body: {"files": [...], "choice": "background"}
// Saves how each song should be leveled. "default" follows the settings.
function AudioLevelerSetChoice()
{
    $body = AudioLevelerBody();
    $choice = isset($body['choice']) ? $body['choice'] : '';
    $allowed = array('default', 'auto', 'volume', 'limit', 'compress', 'background', 'skip');
    if (!in_array($choice, $allowed, true)) {
        return AudioLevelerError(400, 'Unknown choice.');
    }
    $files = AudioLevelerCleanFiles(isset($body['files']) ? $body['files'] : array());
    if (!is_array($files) || count($files) == 0) {
        return AudioLevelerError(400, 'No songs given.');
    }
    $path = AudioLevelerDataDir() . '/choices.json';
    $fp = fopen($path, 'c+');
    if (!$fp) {
        return AudioLevelerError(500, 'Could not save the choice.');
    }
    flock($fp, LOCK_EX);
    $choices = json_decode(stream_get_contents($fp), true);
    if (!is_array($choices)) {
        $choices = array();
    }
    foreach ($files as $f) {
        if ($choice === 'default') {
            unset($choices[$f]);
        } else {
            $choices[$f] = $choice;
        }
    }
    ftruncate($fp, 0);
    rewind($fp);
    // (object): with no choices left this must still be {} and not [].
    fwrite($fp, json_encode((object) $choices, JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return json(array('status' => 'OK', 'count' => count($files)));
}

/* ---------------- Song info (Title and Artist) ----------------
 * Read here for the Song info tab (a few small reads per song, skipping cover
 * art); changed by the worker (bin/id3tags.py), which checks every change.
 */

function AudioLevelerSyncsafe($b)
{
    return ((ord($b[0]) & 0x7f) << 21) | ((ord($b[1]) & 0x7f) << 14) | ((ord($b[2]) & 0x7f) << 7) | (ord($b[3]) & 0x7f);
}

function AudioLevelerTagText($data)
{
    if ($data === '' || $data === false) {
        return '';
    }
    $enc = ord($data[0]);
    $raw = substr($data, 1);
    if ($enc === 0) {
        $s = mb_convert_encoding($raw, 'UTF-8', 'ISO-8859-1');
    } elseif ($enc === 1) {
        $b = substr($raw, 0, 2);
        $s = $b === "\xfe\xff" ? mb_convert_encoding(substr($raw, 2), 'UTF-8', 'UTF-16BE')
            : mb_convert_encoding($b === "\xff\xfe" ? substr($raw, 2) : $raw, 'UTF-8', 'UTF-16LE');
    } elseif ($enc === 2) {
        $s = mb_convert_encoding($raw, 'UTF-8', 'UTF-16BE');
    } elseif ($enc === 3) {
        $s = mb_convert_encoding($raw, 'UTF-8', 'UTF-8');
    } else {
        return '';
    }
    $parts = array_values(array_filter(array_map('trim', explode("\0", $s)), 'strlen'));
    return implode(' / ', $parts);
}

// Title and Artist the way FPP reads them: the ID3v2 tag first, then ID3v1.
// 'editable' is false for tags the worker won't rewrite (ID3v2.2, or stored unsynchronised).
function AudioLevelerReadTags($path)
{
    $out = array('title' => '', 'artist' => '', 'editable' => true, 'notMp3' => false);
    $fh = @fopen($path, 'rb');
    if (!$fh) {
        return null;
    }
    $h = fread($fh, 10);
    // MPEG audio must follow the tag: an M4A renamed .mp3 is left alone.
    $audioAt = (strlen($h) === 10 && substr($h, 0, 3) === 'ID3') ? 10 + AudioLevelerSyncsafe(substr($h, 6, 4)) +
        ((ord($h[3]) === 4 && (ord($h[5]) & 0x10)) ? 10 : 0) : 0;
    fseek($fh, $audioAt);
    $d = ltrim((string) fread($fh, 4096), "\0");
    if (strlen($d) < 4 || ord($d[0]) !== 0xFF || (ord($d[1]) & 0xE0) !== 0xE0 || ((ord($d[1]) >> 1) & 3) === 0) {
        $out['editable'] = false;
        $out['notMp3'] = true;
    }
    fseek($fh, 10);
    if (strlen($h) === 10 && substr($h, 0, 3) === 'ID3' && in_array(ord($h[3]), array(2, 3, 4), true)) {
        $major = ord($h[3]);
        $flags = ord($h[5]);
        $end = 10 + AudioLevelerSyncsafe(substr($h, 6, 4));
        if ($major === 2 || ($flags & 0x80)) {
            $out['editable'] = false;
        }
        $pos = 10;
        if (($flags & 0x40) && $major >= 3) {
            $x = fread($fh, 4);
            $pos += $major === 4 ? AudioLevelerSyncsafe($x) : 4 + unpack('N', $x)[1];
        }
        $want = $major === 2 ? array('TT2' => 'title', 'TP1' => 'artist') : array('TIT2' => 'title', 'TPE1' => 'artist');
        $hl = $major === 2 ? 6 : 10;
        $found = 0;
        while (!($flags & 0x80) && $pos + $hl <= $end && $found < 2) {
            fseek($fh, $pos);
            $fr = fread($fh, $hl);
            if (strlen($fr) < $hl || $fr[0] === "\0") {
                break;
            }
            $id = substr($fr, 0, $hl === 6 ? 3 : 4);
            if ($major === 2) {
                $n = (ord($fr[3]) << 16) | (ord($fr[4]) << 8) | ord($fr[5]);
            } elseif ($major === 4) {
                $n = AudioLevelerSyncsafe(substr($fr, 4, 4));
            } else {
                $n = unpack('N', substr($fr, 4, 4))[1];
            }
            if ($n <= 0 || $pos + $hl + $n > $end) {
                break;
            }
            if (isset($want[$id]) && $out[$want[$id]] === '' && $n < 4096 &&
                !($major === 4 && (ord($fr[9]) & 0x0f))) {
                $out[$want[$id]] = AudioLevelerTagText(fread($fh, $n));
                $found++;
            }
            $pos += $hl + $n;
        }
    }
    if (fseek($fh, -128, SEEK_END) === 0) {
        $t = fread($fh, 128);
        if (substr($t, 0, 3) === 'TAG') {
            $clean = function ($b) {
                $b = explode("\0", $b)[0];
                return trim(mb_convert_encoding($b, 'UTF-8', 'ISO-8859-1'));
            };
            if ($out['title'] === '') {
                $out['title'] = $clean(substr($t, 3, 30));
            }
            if ($out['artist'] === '') {
                $out['artist'] = $clean(substr($t, 33, 30));
            }
        }
    }
    fclose($fh);
    return $out;
}

// GET /api/plugin/AudioLeveler/tags
function AudioLevelerTags()
{
    AudioLevelerNoCache();
    $music = AudioLevelerMusicDir();
    $files = array();
    foreach (is_dir($music) ? scandir($music) : array() as $n) {
        $path = "$music/$n";
        if ($n[0] === '.' || !is_file($path) || !AudioLevelerIsAudio($n)) {
            continue;
        }
        $mp3 = strtolower(pathinfo($n, PATHINFO_EXTENSION)) === 'mp3';
        $t = $mp3 ? AudioLevelerReadTags($path) : null;
        $files[] = array(
            'name' => $n,
            'mp3' => $mp3,
            'title' => $t ? $t['title'] : '',
            'artist' => $t ? $t['artist'] : '',
            'editable' => $mp3 && $t && $t['editable'],
            'notMp3' => $mp3 && $t && $t['notMp3'],
        );
    }
    return json(array('status' => 'OK', 'files' => $files));
}

// POST /api/plugin/AudioLeveler/tags
function AudioLevelerSetTags()
{
    $body = AudioLevelerBody();
    $edits = isset($body['edits']) && is_array($body['edits']) ? $body['edits'] : array();
    $clean = array();
    foreach ($edits as $name => $e) {
        if (!is_string($name) || strpos($name, AUDIOLEVELER_VIDEO_PREFIX) === 0 || !AudioLevelerIsAudio($name) ||
            strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'mp3' || !is_array($e)) {
            continue;
        }
        $one = function ($k) use ($e) {
            $v = isset($e[$k]) && is_string($e[$k]) ? trim(preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $e[$k])) : '';
            return mb_substr($v, 0, 250);
        };
        $clean[$name] = array('title' => $one('title'), 'artist' => $one('artist'));
    }
    if (!count($clean)) {
        return AudioLevelerError(400, 'No song info to change.');
    }
    return AudioLevelerStart('tags', array('files' => array_keys($clean), 'edits' => $clean, 'scope' => 'songs'));
}

// POST /api/plugin/AudioLeveler/gainsize
// Changing a song's info can grow its tag, and FPP only applies a Normalize
// setting while the file is the size it was measured at. The sound didn't
// change, so the setting moves to the new size. Only done when the entry still
// has the old size and the new size is the file's real size.
function AudioLevelerGainSize()
{
    $body = AudioLevelerBody();
    $name = isset($body['file']) ? $body['file'] : '';
    $old = isset($body['oldSize']) ? intval($body['oldSize']) : -1;
    if (!is_string($name) || !AudioLevelerIsAudio($name) || strpos($name, AUDIOLEVELER_VIDEO_PREFIX) === 0 ||
        !AudioLevelerPlaybackGainSupported()) {
        return json(array('status' => 'OK', 'changed' => false));
    }
    clearstatcache();
    $new = @filesize(AudioLevelerMusicDir() . '/' . $name);
    if ($new === false) {
        return json(array('status' => 'OK', 'changed' => false));
    }
    if (!function_exists('AN_UpdateGains')) {
        require_once AudioLevelerFppDir() . '/www/common/audioNormalize.inc.php';
    }
    $changed = false;
    AN_UpdateGains(function (&$all) use ($name, $old, $new, &$changed) {
        if (isset($all[$name]['size']) && intval($all[$name]['size']) === $old) {
            $all[$name]['size'] = $new;
            $changed = true;
        }
        return $changed;
    }, false);
    return json(array('status' => 'OK', 'changed' => $changed));
}
?>
