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
 *   POST   preview    play a song through the show (only while no show is playing), or stop it   body: {"file", "action": "play"|"stop"}
 *   GET    eq         the Audio EQ tab's state (FPP's equalizer, FPP 10.4+)
 *   POST   eq/on      turn FPP's equalizer on (Advanced audio, EQ on the show's card)   body: {"gains", "preset"}
 *   POST   eq/off     put FPP's audio back exactly as it was
 *   POST   eq/live    change the running EQ at once, unsaved   body: {"gains"}
 *   POST   eq/save    keep the EQ (FPP's group, applied; and remembered here)   body: {"gains", "preset"}
 *   POST   tagsforget stop flagging songs whose uploaded info differs from what was saved   body: {"files": [...]}
 *   POST   gainsize   the worker grew a song's tag: keep FPP's Normalize setting for it   body: {"file", "oldSize"}
 *   POST   cancel     stop the running job after the current song
 *   GET    options    the saved settings (FPP saves them: settings.json + PrintPluginSetting)
 *   POST   settingschanged   the page saved a setting: refresh what background work uses
 *   DELETE backups    delete every backed-up original   body: {"count": <how many the page showed>}
 *
 * The heavy lifting is done by bin/leveler.py, started in the background at
 * low priority so a web request never waits on ffmpeg. fppd starts it, through
 * the plugin's "Audio Leveler: Start Job" command, so a job never runs under
 * the web server; when fppd isn't running, the page says so and nothing starts.
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
        array('method' => 'POST', 'endpoint' => 'tagsforget', 'callback' => 'AudioLevelerTagsForget'),
        array('method' => 'POST', 'endpoint' => 'preview', 'callback' => 'AudioLevelerPreview'),
        array('method' => 'GET', 'endpoint' => 'eq', 'callback' => 'AudioLevelerEqState'),
        array('method' => 'POST', 'endpoint' => 'eq/on', 'callback' => 'AudioLevelerEqOn'),
        array('method' => 'POST', 'endpoint' => 'eq/off', 'callback' => 'AudioLevelerEqOff'),
        array('method' => 'POST', 'endpoint' => 'eq/live', 'callback' => 'AudioLevelerEqLive'),
        array('method' => 'POST', 'endpoint' => 'eq/save', 'callback' => 'AudioLevelerEqSave'),
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
function AudioLevelerPluginsDir()
{
    global $settings;
    if (!empty($settings['pluginDirectory'])) {
        return $settings['pluginDirectory'];
    }
    return (isset($settings['mediaDirectory']) ? $settings['mediaDirectory'] : '/home/fpp/media') . '/plugins';
}

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

// Write a file in one step (written beside it, then renamed), so a reader
// never sees it half written. FPP 10 has WriteFileAtomic(); the fallback is
// the same idea.
function AudioLevelerWriteAtomic($path, $data)
{
    if (function_exists('WriteFileAtomic')) {
        return WriteFileAtomic($path, $data);
    }
    $tmp = $path . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $data) !== strlen($data) || !@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

// True while a worker holds its lock (a job of the page's, or automatic leveling).
function AudioLevelerWorkerRunning()
{
    $fp = @fopen(AudioLevelerDataDir() . '/worker.lock', 'c');
    if (!$fp) {
        return false;
    }
    $free = flock($fp, LOCK_SH | LOCK_NB);
    if ($free) {
        flock($fp, LOCK_UN);
    }
    fclose($fp);
    return !$free;
}

function AudioLevelerStart($command, $request)
{
    if (is_array($request['files']) && count($request['files']) == 0) {
        return AudioLevelerError(400, 'No songs selected.');
    }
    $data = AudioLevelerDataDir();

    // One start at a time: the busy check and the files it leads to are done
    // under one lock, so two clicks (or two browsers) can't both start a job
    // or leave the files out of step.
    $lock = @fopen($data . '/start.lock', 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    try {
        if (AudioLevelerBusy() || AudioLevelerWorkerRunning()) {
            return AudioLevelerError(409, 'A job is already running. Wait for it to finish or cancel it first.');
        }

        // A launch file claimed by fppd but never run (python3 couldn't be
        // started, say) is swept up here rather than left until uninstall.
        foreach (glob($data . '/launch.*.json') ?: array() as $old) {
            if (@filemtime($old) < time() - 600) {
                @unlink($old);
            }
        }

        $reqFile = $data . '/request.json';
        $previousJob = @file_get_contents($data . '/job.json');
        // Ties this request to the job fppd starts for it: start_job.sh only
        // runs a launch file whose token matches the job that is starting, and
        // uses it up, so the command run again (from a playlist, say) or a
        // stale file never starts anything.
        $token = bin2hex(random_bytes(16));
        // The worker's command line, for fppd's Start Job command to run.
        $argv = array($command, '--music', AudioLevelerMusicDir(), '--videos', AudioLevelerVideoDir(), '--data', $data,
            '--log', AudioLevelerLogFile(), '--request', $reqFile);
        @unlink($data . '/cancel');
        $ok = AudioLevelerWriteAtomic($reqFile, json_encode($request))
            && AudioLevelerWriteAtomic($data . '/job.json', json_encode(array(
                'cmd' => $command,
                'state' => 'starting',
                'requested' => time(),
                'token' => $token,
                'done' => 0,
                'total' => 0,
                'results' => array(),
            )))
            && AudioLevelerWriteAtomic($data . '/launch.json', json_encode(array('argv' => $argv, 'token' => $token)));

        if ($ok && AudioLevelerRunCommand('Queued job')) {
            AudioLevelerLog("Started $command job");
            return json(array('status' => 'OK'));
        }
        // All background work runs under fppd, never under the web server.
        // Nothing started: the page goes back to showing the last job.
        @unlink($data . '/launch.json');
        if ($previousJob !== false) {
            AudioLevelerWriteAtomic($data . '/job.json', $previousJob);
        } else {
            @unlink($data . '/job.json');
        }
        if (!$ok) {
            return AudioLevelerError(500, 'Couldn\'t save the job in the plugin\'s data folder. Check the plugin log (Help > FPP Logs).');
        }
        return AudioLevelerError(503, 'FPPD isn\'t running, so the job can\'t start. Start FPPD (top of any FPP page), then try again.');
    } finally {
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
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
    return AudioLevelerFppCommand(AUDIOLEVELER_START_COMMAND, array($task));
}

// Run one of fppd's commands; true when fppd answered 200.
function AudioLevelerFppCommand($command, $args)
{
    $ctx = stream_context_create(array('http' => array(
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode(array_values($args)),
        'timeout' => 10,
        'ignore_errors' => true,
    )));
    // Read the reply as a stream so its status line comes from the stream's
    // metadata: no $http_response_header, which PHP 8.4+ (FPP on Debian
    // Trixie) deprecates, and the same on every PHP version.
    $fp = @fopen('http://127.0.0.1/api/command/' . rawurlencode($command), 'r', false, $ctx);
    $ok = false;
    $headers = array();
    if ($fp) {
        $ok = stream_get_contents($fp);
        $meta = stream_get_meta_data($fp);
        fclose($fp);
        if (isset($meta['wrapper_data']) && is_array($meta['wrapper_data'])) {
            $headers = $meta['wrapper_data'];
        }
    }
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
            $row['dur'] = isset($a['dur']) && $a['dur'] > 0 ? round(floatval($a['dur']), 1) : null;
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
    // These are the only copies of the originals, so the request must say how
    // many it means to delete (the number the page showed when it was
    // confirmed). A request without it, or made when the backups have
    // changed since, deletes nothing.
    $files = AudioLevelerBackupFiles();
    $body = AudioLevelerBody();
    $want = isset($body['count']) && is_int($body['count']) ? $body['count'] : -1;
    $from = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
    if ($want !== count($files)) {
        AudioLevelerLog("Refused to delete backups for $from: asked for " . ($want < 0 ? 'no count' : $want) . ', there are ' . count($files));
        return AudioLevelerError($want < 0 ? 400 : 409, $want < 0
            ? 'Say how many backups to delete ({"count": N}); nothing was deleted.'
            : 'The backups have changed since the page showed them. Reload the page and try again.');
    }
    $n = 0;
    foreach ($files as $f) {
        if (@unlink($f)) {
            $n++;
        }
    }
    AudioLevelerLog("Deleted $n backup(s) for $from");
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

// FPP's PHP has no mbstring, so text is converted by hand.
function AudioLevelerUtf8Char($c)
{
    if ($c < 0x80) {
        return chr($c);
    }
    if ($c < 0x800) {
        return chr(0xC0 | ($c >> 6)) . chr(0x80 | ($c & 0x3F));
    }
    if ($c < 0x10000) {
        return chr(0xE0 | ($c >> 12)) . chr(0x80 | (($c >> 6) & 0x3F)) . chr(0x80 | ($c & 0x3F));
    }
    return chr(0xF0 | ($c >> 18)) . chr(0x80 | (($c >> 12) & 0x3F)) . chr(0x80 | (($c >> 6) & 0x3F)) . chr(0x80 | ($c & 0x3F));
}

function AudioLevelerLatin1ToUtf8($s)
{
    return preg_replace_callback('/[\x80-\xff]/', function ($m) {
        return AudioLevelerUtf8Char(ord($m[0]));
    }, $s);
}

function AudioLevelerUtf16ToUtf8($s, $bigEndian)
{
    $out = '';
    $n = strlen($s) - (strlen($s) % 2);
    for ($i = 0; $i < $n; $i += 2) {
        $u = $bigEndian ? (ord($s[$i]) << 8) | ord($s[$i + 1]) : ord($s[$i]) | (ord($s[$i + 1]) << 8);
        if ($u >= 0xD800 && $u <= 0xDBFF && $i + 3 < $n) {
            $l = $bigEndian ? (ord($s[$i + 2]) << 8) | ord($s[$i + 3]) : ord($s[$i + 2]) | (ord($s[$i + 3]) << 8);
            if ($l >= 0xDC00 && $l <= 0xDFFF) {
                $u = 0x10000 + (($u - 0xD800) << 10) + ($l - 0xDC00);
                $i += 2;
            }
        }
        $out .= ($u >= 0xD800 && $u <= 0xDFFF) ? "\xEF\xBF\xBD" : AudioLevelerUtf8Char($u);
    }
    return $out;
}

function AudioLevelerTagText($data)
{
    if ($data === '' || $data === false) {
        return '';
    }
    $enc = ord($data[0]);
    $raw = substr($data, 1);
    if ($enc === 0) {
        $s = AudioLevelerLatin1ToUtf8($raw);
    } elseif ($enc === 1) {
        $b = substr($raw, 0, 2);
        $s = $b === "\xfe\xff" ? AudioLevelerUtf16ToUtf8(substr($raw, 2), true)
            : AudioLevelerUtf16ToUtf8($b === "\xff\xfe" ? substr($raw, 2) : $raw, false);
    } elseif ($enc === 2) {
        $s = AudioLevelerUtf16ToUtf8($raw, true);
    } elseif ($enc === 3) {
        $s = preg_match('//u', $raw) ? $raw : AudioLevelerLatin1ToUtf8($raw);
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
                return trim(AudioLevelerLatin1ToUtf8($b));
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
    $saved = AudioLevelerReadJson(AudioLevelerDataDir() . '/songinfo.json', array());
    $files = array();
    foreach (is_dir($music) ? scandir($music) : array() as $n) {
        $path = "$music/$n";
        if ($n[0] === '.' || !is_file($path) || !AudioLevelerIsAudio($n)) {
            continue;
        }
        $mp3 = strtolower(pathinfo($n, PATHINFO_EXTENSION)) === 'mp3';
        $t = $mp3 ? AudioLevelerReadTags($path) : null;
        $row = array(
            'name' => $n,
            'mp3' => $mp3,
            'title' => $t ? $t['title'] : '',
            'artist' => $t ? $t['artist'] : '',
            'editable' => $mp3 && $t && $t['editable'],
            'notMp3' => $mp3 && $t && $t['notMp3'],
        );
        // Saved on this tab before, and the file now says something else: an
        // upload (from xLights, say) put the computer's copy's info back.
        if ($row['editable'] && isset($saved[$n]) && is_array($saved[$n])) {
            $st = isset($saved[$n]['title']) ? (string) $saved[$n]['title'] : '';
            $sa = isset($saved[$n]['artist']) ? (string) $saved[$n]['artist'] : '';
            if ($st !== $row['title'] || $sa !== $row['artist']) {
                $row['saved'] = array('title' => $st, 'artist' => $sa);
            }
        }
        $files[] = $row;
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
            return preg_match('/^.{0,250}/us', $v, $m) ? $m[0] : '';
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

// POST /api/plugin/AudioLeveler/tagsforget
// "Keep upload's": the info a song came back with is what's wanted, so stop
// comparing it with what was saved here before.
function AudioLevelerTagsForget()
{
    $body = AudioLevelerBody();
    $names = isset($body['files']) && is_array($body['files']) ? array_filter($body['files'], 'is_string') : array();
    $data = AudioLevelerDataDir();
    $lock = @fopen($data . '/songinfo.lock', 'c');
    if ($lock) {
        flock($lock, LOCK_EX);
    }
    $saved = AudioLevelerReadJson($data . '/songinfo.json', array());
    $n = 0;
    foreach ($names as $name) {
        if (isset($saved[$name])) {
            unset($saved[$name]);
            $n++;
        }
    }
    if ($n) {
        AudioLevelerWriteAtomic($data . '/songinfo.json', json_encode((object) $saved));
    }
    if ($lock) {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    return json(array('status' => 'OK', 'forgotten' => $n));
}

// POST /api/plugin/AudioLeveler/preview
// "Play through the show": plays one song out FPP's own audio (speakers, FM)
// as FPP plays a show, with its Normalize setting applied. A song plays as a
// temporary one-song playlist (AudioLeveler-Preview), so an FM transmitter
// plugin that mutes between playlists (Kulp's K-FMT, say) comes on and sends
// the song's title over RDS; a video's sound plays with fppd's Play Media.
// Only while no show is playing and no scheduled show is due before the song
// would end (FPP gives a hand-started playlist top priority, so a scheduled
// one would otherwise wait for it), checked here for every browser. The
// page stops it if a show starts, and when it leaves.
define('AUDIOLEVELER_PREVIEW_PLAYLIST', 'AudioLeveler-Preview');

function AudioLevelerPreview()
{
    $body = AudioLevelerBody();
    $name = isset($body['file']) && is_string($body['file']) ? $body['file'] : '';
    $action = isset($body['action']) ? $body['action'] : '';
    $isVideo = strpos($name, AUDIOLEVELER_VIDEO_PREFIX) === 0;
    $base = $isVideo ? substr($name, strlen(AUDIOLEVELER_VIDEO_PREFIX)) : $name;
    $dir = $isVideo ? AudioLevelerVideoDir() : AudioLevelerMusicDir();
    if ($action === 'stop') {
        AudioLevelerPreviewStop($base);
        return json(array('status' => 'OK'));
    }
    if ($base === '' || strpos($base, '/') !== false || $base[0] === '.' || !is_file("$dir/$base")) {
        return AudioLevelerError(404, 'That song isn\'t in the folder any more.');
    }
    if ($action !== 'play') {
        return AudioLevelerError(400, 'Say "play" or "stop".');
    }
    $st = AudioLevelerFppStatus();
    if ($st === null) {
        return AudioLevelerError(503, 'FPPD isn\'t running, so nothing can play through the show.');
    }
    if ($st['status_name'] !== 'idle') {
        return AudioLevelerError(409, 'A show is playing, so the preview plays in your browser instead. Stop the show to play through it.');
    }
    $analysis = AudioLevelerReadJson(AudioLevelerDataDir() . '/analysis.json', array());
    $dur = isset($analysis[$name]['dur']) ? floatval($analysis[$name]['dur']) : (isset($body['dur']) ? floatval($body['dur']) : 300);
    $next = isset($st['scheduler']['nextPlaylist']['scheduledStartTime']) ? intval($st['scheduler']['nextPlaylist']['scheduledStartTime']) : 0;
    if ($next > 0 && $next - time() < $dur + 90) {
        return AudioLevelerError(409, 'A scheduled show starts at ' . date('g:i a', $next) . ', before this song would finish, so it plays in your browser instead.');
    }
    if ($isVideo) {
        $ok = AudioLevelerFppCommand('Play Media', array($base, '1', '0'));
    } else {
        $pl = array('name' => AUDIOLEVELER_PREVIEW_PLAYLIST, 'desc' => 'Temporary: Audio Leveler preview (removed when it stops)',
            'repeat' => 0, 'loopCount' => 0, 'random' => 0, 'leadIn' => array(), 'leadOut' => array(),
            'mainPlaylist' => array(array('type' => 'media', 'enabled' => 1, 'playOnce' => 0, 'fileMode' => 'single', 'mediaName' => $base)));
        list($code) = AudioLevelerFppApi('POST', 'playlist/' . rawurlencode(AUDIOLEVELER_PREVIEW_PLAYLIST), $pl);
        $ok = $code === 200 && AudioLevelerFppCommand('Start Playlist', array(AUDIOLEVELER_PREVIEW_PLAYLIST, 'false', 'false', 'false'));
    }
    if (!$ok) {
        AudioLevelerPreviewStop($base);
        return AudioLevelerError(502, 'FPP couldn\'t play it. Check FPP\'s log.');
    }
    AudioLevelerLog("Playing $name through the show (preview)");
    return json(array('status' => 'OK', 'playlist' => $isVideo ? '' : AUDIOLEVELER_PREVIEW_PLAYLIST));
}

// Stop a preview: the temporary playlist (only if it's still the one
// playing) and any Play Media of this file; then remove the playlist.
function AudioLevelerPreviewStop($base)
{
    $st = AudioLevelerFppStatus();
    if ($st && isset($st['current_playlist']['playlist']) && $st['current_playlist']['playlist'] === AUDIOLEVELER_PREVIEW_PLAYLIST) {
        AudioLevelerFppApi('POST', 'playlists/stop');
    }
    if (is_string($base) && $base !== '' && strpos($base, '/') === false) {
        AudioLevelerFppCommand('Stop Media', array($base));
    }
    AudioLevelerFppApi('DELETE', 'playlist/' . rawurlencode(AUDIOLEVELER_PREVIEW_PLAYLIST));
}

/* ---------------- Audio EQ ----------------
 * A friendlier front end for FPP's own equalizer (PipeWire Audio Output
 * Groups, per-card Parametric EQ, FPP 10.4+). Nothing here processes audio:
 * the plugin only saves FPP's own group settings and switches FPP's own
 * Media Backend setting, through FPP's own API, exactly as FPP's settings
 * pages would.
 *
 * Turning the EQ on (from Simple audio): the group Simple mode already uses
 * (one "Default" group, the selected card) is saved as FPP's Advanced group
 * with the EQ on that card, and Media Backend is set to Advanced; FPP
 * applies the group itself and asks for a reboot. Turning it off puts FPP's
 * Advanced group file back exactly as it was (or removes it, when there was
 * none) and sets Media Backend back. The plugin keeps the EQ gains in its
 * own data (eq.json) so they come back next time.
 */

define('AUDIOLEVELER_EQ_BANDS', json_encode(array(
    array('type' => 'bq_lowshelf', 'freq' => 60, 'q' => 0.7),
    array('type' => 'bq_peaking', 'freq' => 250, 'q' => 1.0),
    array('type' => 'bq_peaking', 'freq' => 1000, 'q' => 1.0),
    array('type' => 'bq_peaking', 'freq' => 4000, 'q' => 1.0),
    array('type' => 'bq_highshelf', 'freq' => 12000, 'q' => 0.7),
)));

// FPP's five default EQ bands (its own DefaultEQBands()) with these gains.
function AudioLevelerEqBands($gains)
{
    $bands = json_decode(AUDIOLEVELER_EQ_BANDS, true);
    foreach ($bands as $i => &$b) {
        $g = isset($gains[$i]) && is_numeric($gains[$i]) ? floatval($gains[$i]) : 0.0;
        $b['gain'] = max(-12.0, min(12.0, round($g, 1)));
    }
    return $bands;
}

function AudioLevelerEqData()
{
    $d = AudioLevelerReadJson(AudioLevelerDataDir() . '/eq.json', array());
    $gains = isset($d['gains']) && is_array($d['gains']) ? array_values($d['gains']) : array(0, 0, 0, 0, 0);
    $d['gains'] = array_map(function ($i) use ($gains) {
        return isset($gains[$i]) && is_numeric($gains[$i]) ? max(-12.0, min(12.0, round(floatval($gains[$i]), 1))) : 0.0;
    }, range(0, 4));
    $d['preset'] = isset($d['preset']) && is_string($d['preset']) ? $d['preset'] : 'flat';
    $d['on'] = !empty($d['on']);
    return $d;
}

function AudioLevelerSaveEqData($d)
{
    return AudioLevelerWriteAtomic(AudioLevelerDataDir() . '/eq.json', json_encode($d));
}

function AudioLevelerFppConfigDir()
{
    global $settings;
    $m = isset($settings['mediaDirectory']) ? $settings['mediaDirectory'] : '/home/fpp/media';
    return $m . '/config';
}

// This FPP has the equalizer (Advanced audio groups with per-card EQ).
function AudioLevelerEqSupported()
{
    $fpp = AudioLevelerFppDir();
    $s = @file_get_contents($fpp . '/www/settings.json');
    return $s !== false && strpos($s, '"MediaBackend"') !== false && strpos($s, '"PipeWireAudioGroups"') !== false
        && file_exists($fpp . '/www/api/controllers/pipewire.php');
}

function AudioLevelerMediaBackend()
{
    global $settings;
    return isset($settings['MediaBackend']) && $settings['MediaBackend'] !== '' ? $settings['MediaBackend'] : 'pipewire-simple';
}

// A request to FPP's own API on this player: array(status code, decoded body or raw text).
function AudioLevelerFppApi($method, $path, $body = null, $raw = false)
{
    $opts = array('method' => $method, 'timeout' => 30, 'ignore_errors' => true, 'header' => '');
    if ($body !== null) {
        $opts['header'] = $raw ? "Content-Type: text/plain\r\n" : "Content-Type: application/json\r\n";
        $opts['content'] = $raw ? (string) $body : json_encode($body);
    }
    $fp = @fopen('http://127.0.0.1/api/' . $path, 'r', false, stream_context_create(array('http' => $opts)));
    if (!$fp) {
        return array(0, null);
    }
    $text = stream_get_contents($fp);
    $meta = stream_get_meta_data($fp);
    fclose($fp);
    $code = 0;
    if (isset($meta['wrapper_data'][0]) && preg_match('#^HTTP/\S+\s+(\d+)#', $meta['wrapper_data'][0], $m)) {
        $code = intval($m[1]);
    }
    $j = json_decode((string) $text, true);
    return array($code, $j === null ? $text : $j);
}

// FPP's status, or null when fppd can't be asked.
function AudioLevelerFppStatus()
{
    list($code, $st) = AudioLevelerFppApi('GET', 'fppd/status');
    return $code === 200 && is_array($st) && isset($st['status_name']) ? $st : null;
}

// The sound card the EQ shapes: the one Simple mode plays on (its record),
// else the first member of FPP's own Advanced groups.
function AudioLevelerEqCard($groups = null)
{
    $simple = AudioLevelerReadJson(AudioLevelerFppConfigDir() . '/pipewire-audio-groups-simple.json', array());
    $pick = function ($data) {
        if (!isset($data['groups']) || !is_array($data['groups'])) {
            return null;
        }
        $order = $data['groups'];
        usort($order, function ($a, $b) {
            return (empty($b['activeGroup']) ? 0 : 1) - (empty($a['activeGroup']) ? 0 : 1);
        });
        foreach ($order as $g) {
            if (!empty($g['members']) && is_array($g['members'])) {
                foreach ($g['members'] as $m) {
                    if (!empty($m['cardId']) && empty($m['isAES67'])) {
                        return array('groupId' => intval(isset($g['id']) ? $g['id'] : 1), 'cardId' => (string) $m['cardId'],
                            'channels' => intval(isset($m['channels']) ? $m['channels'] : 2));
                    }
                }
            }
        }
        return null;
    };
    return $groups !== null ? $pick($groups) : $pick($simple);
}

// GET /api/plugin/AudioLeveler/eq
function AudioLevelerEqState()
{
    AudioLevelerNoCache();
    $d = AudioLevelerEqData();
    $out = array('status' => 'OK', 'supported' => AudioLevelerEqSupported(), 'on' => $d['on'], 'gains' => $d['gains'],
        'preset' => $d['preset'], 'backend' => AudioLevelerMediaBackend(), 'kfmt' => is_dir(AudioLevelerPluginsDir() . '/fpp-kfmt'));
    if (!$out['supported']) {
        return json($out);
    }
    global $settings;
    $out['rebootPending'] = isset($settings['rebootFlag']) && intval($settings['rebootFlag']) === 1;
    $card = $d['on'] && isset($d['cardId']) ? array('cardId' => $d['cardId']) : AudioLevelerEqCard();
    if ($card) {
        $out['cardId'] = $card['cardId'];
        $out['cardName'] = $card['cardId'];
        list($code, $cards) = AudioLevelerFppApi('GET', 'pipewire/audio/cards');
        foreach (is_array($cards) ? $cards : array() as $c) {
            if (is_array($c) && isset($c['cardId']) && $c['cardId'] === $card['cardId']) {
                $out['cardName'] = !empty($c['alias']) ? $c['alias'] : (isset($c['cardName']) ? $c['cardName'] : $c['cardId']);
            }
        }
    }
    $st = AudioLevelerFppStatus();
    $out['idle'] = $st !== null && $st['status_name'] === 'idle';
    return json($out);
}

// Turning the EQ on or off restarts FPP's audio: never while a show plays.
function AudioLevelerEqNeedsIdle()
{
    $st = AudioLevelerFppStatus();
    if ($st === null) {
        return AudioLevelerError(503, 'FPPD isn\'t running, so FPP\'s audio can\'t be changed right now.');
    }
    if ($st['status_name'] !== 'idle') {
        return AudioLevelerError(409, 'A show is playing. Turning the EQ on or off restarts FPP\'s audio, so stop the show first.');
    }
    return null;
}

// POST /api/plugin/AudioLeveler/eq/on    body: {"gains": [5 numbers], "preset"}
function AudioLevelerEqOn()
{
    if (!AudioLevelerEqSupported()) {
        return AudioLevelerError(400, 'This FPP has no equalizer (it needs FPP 10.4 or later).');
    }
    if ($e = AudioLevelerEqNeedsIdle()) {
        return $e;
    }
    $body = AudioLevelerBody();
    $d = AudioLevelerEqData();
    if (isset($body['gains']) && is_array($body['gains'])) {
        $d['gains'] = array_map(function ($g) { return max(-12.0, min(12.0, round(floatval($g), 1))); }, array_slice(array_values($body['gains']), 0, 5));
    }
    if (isset($body['preset']) && is_string($body['preset'])) {
        $d['preset'] = substr(preg_replace('/[^a-z]/', '', $body['preset']), 0, 20);
    }
    if ($d['on']) {
        return AudioLevelerError(409, 'The EQ is already on.');
    }
    $groupsFile = AudioLevelerFppConfigDir() . '/pipewire-audio-groups.json';
    $backend = AudioLevelerMediaBackend();
    $wasAdvanced = $backend === 'pipewire';
    $prev = file_exists($groupsFile) ? @file_get_contents($groupsFile) : null;

    if ($wasAdvanced) {
        // FPP is already on Advanced audio (set up by hand): EQ the first card
        // of its own groups and leave everything else as it is.
        $data = json_decode((string) $prev, true);
        $card = is_array($data) ? AudioLevelerEqCard($data) : null;
        if (!$card) {
            return AudioLevelerError(400, 'FPP is on Advanced audio but has no Audio Output Group with a sound card yet. Add one in FPP Settings > Audio/Video first.');
        }
    } else {
        // The exact group Simple mode plays through, now as an Advanced group.
        $data = AudioLevelerReadJson(AudioLevelerFppConfigDir() . '/pipewire-audio-groups-simple.json', array());
        $card = AudioLevelerEqCard($data);
        if (!$card) {
            return AudioLevelerError(400, 'Couldn\'t tell which sound card FPP plays on. Pick one under FPP Settings > Audio/Video > Audio Output Device, then try again.');
        }
    }
    foreach ($data['groups'] as &$g) {
        if (intval(isset($g['id']) ? $g['id'] : 1) !== $card['groupId']) {
            continue;
        }
        foreach ($g['members'] as &$m) {
            if (isset($m['cardId']) && $m['cardId'] === $card['cardId']) {
                $m['eq'] = array('enabled' => true, 'bands' => AudioLevelerEqBands($d['gains']));
            }
        }
        unset($m);
    }
    unset($g);

    list($code, $r) = AudioLevelerFppApi('POST', 'pipewire/audio/groups', $data);
    if ($code !== 200) {
        return AudioLevelerError(502, 'FPP didn\'t save the audio group. Nothing was changed.');
    }
    $d['on'] = true;
    $d['cardId'] = $card['cardId'];
    $d['groupId'] = $card['groupId'];
    $d['channels'] = $card['channels'];
    $d['switchedBackend'] = !$wasAdvanced;
    $d['prevBackend'] = $backend;
    $d['hadGroupsFile'] = $prev !== null;
    $d['prevGroups'] = $prev;
    AudioLevelerSaveEqData($d);

    if ($wasAdvanced) {
        AudioLevelerFppApi('POST', 'pipewire/audio/groups/apply', array());
        AudioLevelerLog('Audio EQ on (FPP was already on Advanced audio; card ' . $card['cardId'] . ')');
        return json(array('status' => 'OK', 'reboot' => false));
    }
    // FPP's own settings save switches the mode and applies the saved group.
    AudioLevelerFppApi('PUT', 'settings/MediaBackend', 'pipewire', true);
    AudioLevelerFppApi('PUT', 'settings/rebootFlag', '1', true);
    AudioLevelerLog('Audio EQ on: Media Backend set to Advanced with the EQ on ' . $card['cardId'] . '; reboot to finish');
    return json(array('status' => 'OK', 'reboot' => true));
}

// POST /api/plugin/AudioLeveler/eq/off
function AudioLevelerEqOff()
{
    $d = AudioLevelerEqData();
    if (!$d['on']) {
        return json(array('status' => 'OK', 'reboot' => false));
    }
    if ($e = AudioLevelerEqNeedsIdle()) {
        return $e;
    }
    $res = AudioLevelerEqRestore($d);
    return json(array('status' => 'OK', 'reboot' => $res));
}

// Put FPP's audio back exactly as it was before the EQ was turned on.
// Returns true when a reboot is needed. (Also used by uninstall.)
function AudioLevelerEqRestore($d)
{
    $groupsFile = AudioLevelerFppConfigDir() . '/pipewire-audio-groups.json';
    if (!empty($d['hadGroupsFile']) && isset($d['prevGroups']) && is_string($d['prevGroups'])) {
        AudioLevelerWriteAtomic($groupsFile, $d['prevGroups']);
    } elseif (empty($d['hadGroupsFile'])) {
        @unlink($groupsFile);
    }
    $reboot = false;
    if (!empty($d['switchedBackend'])) {
        $back = isset($d['prevBackend']) && is_string($d['prevBackend']) ? $d['prevBackend'] : 'pipewire-simple';
        AudioLevelerFppApi('PUT', 'settings/MediaBackend', $back, true);
        AudioLevelerFppApi('PUT', 'settings/rebootFlag', '1', true);
        $reboot = true;
    } else {
        AudioLevelerFppApi('POST', 'pipewire/audio/groups/apply', array());
    }
    $d['on'] = false;
    unset($d['prevGroups'], $d['hadGroupsFile'], $d['switchedBackend'], $d['prevBackend']);
    AudioLevelerSaveEqData($d);
    AudioLevelerLog('Audio EQ off: FPP\'s audio settings put back as they were' . ($reboot ? '; reboot to finish' : ''));
    return $reboot;
}

// POST /api/plugin/AudioLeveler/eq/live   body: {"gains": [5]}
// Changes the running EQ at once (FPP's own live update); nothing is saved.
function AudioLevelerEqLive()
{
    $d = AudioLevelerEqData();
    if (!$d['on']) {
        return AudioLevelerError(409, 'Turn the EQ on first.');
    }
    $body = AudioLevelerBody();
    $gains = isset($body['gains']) && is_array($body['gains']) ? array_values($body['gains']) : $d['gains'];
    list($code, $r) = AudioLevelerFppApi('POST', 'pipewire/audio/eq/update', array(
        'groupId' => isset($d['groupId']) ? $d['groupId'] : 1, 'cardId' => isset($d['cardId']) ? $d['cardId'] : '',
        'channels' => isset($d['channels']) ? $d['channels'] : 2, 'bands' => AudioLevelerEqBands($gains)));
    if (is_array($r) && isset($r['status']) && $r['status'] === 'NOT_RUNNING') {
        return json(array('status' => 'NOT_RUNNING', 'message' => 'The EQ isn\'t running yet: reboot FPP to finish turning it on.'));
    }
    return json(array('status' => $code === 200 ? 'OK' : 'ERROR'));
}

// POST /api/plugin/AudioLeveler/eq/save   body: {"gains": [5], "preset"}
// Remembered here always; when the EQ is on, written into FPP's group and
// applied, so it survives a reboot.
function AudioLevelerEqSave()
{
    $body = AudioLevelerBody();
    $d = AudioLevelerEqData();
    if (!isset($body['gains']) || !is_array($body['gains'])) {
        return AudioLevelerError(400, 'No EQ settings to save.');
    }
    $d['gains'] = array_map(function ($i) use ($body) {
        $g = array_values($body['gains']);
        return isset($g[$i]) ? max(-12.0, min(12.0, round(floatval($g[$i]), 1))) : 0.0;
    }, range(0, 4));
    if (isset($body['preset']) && is_string($body['preset'])) {
        $d['preset'] = substr(preg_replace('/[^a-z]/', '', $body['preset']), 0, 20);
    }
    if (!$d['on']) {
        AudioLevelerSaveEqData($d);
        return json(array('status' => 'OK', 'applied' => false));
    }
    if ($e = AudioLevelerEqNeedsIdle()) {
        return $e;
    }
    list($code, $data) = AudioLevelerFppApi('GET', 'pipewire/audio/groups');
    if ($code !== 200 || !is_array($data) || !isset($data['groups'])) {
        return AudioLevelerError(502, 'Couldn\'t read FPP\'s audio groups.');
    }
    $found = false;
    foreach ($data['groups'] as &$g) {
        if (intval(isset($g['id']) ? $g['id'] : 1) !== intval($d['groupId'])) {
            continue;
        }
        foreach ($g['members'] as &$m) {
            if (isset($m['cardId']) && $m['cardId'] === $d['cardId']) {
                $m['eq'] = array('enabled' => true, 'bands' => AudioLevelerEqBands($d['gains']));
                $found = true;
            }
        }
        unset($m);
    }
    unset($g);
    if (!$found) {
        return AudioLevelerError(409, 'FPP\'s audio groups no longer have the card the EQ was on. Untick and tick the EQ to set it up again.');
    }
    list($code) = AudioLevelerFppApi('POST', 'pipewire/audio/groups', $data);
    if ($code !== 200) {
        return AudioLevelerError(502, 'FPP didn\'t save the EQ.');
    }
    AudioLevelerSaveEqData($d);
    AudioLevelerFppApi('POST', 'pipewire/audio/groups/apply', array());
    AudioLevelerLog('Audio EQ saved: ' . implode(' / ', $d['gains']) . ' dB');
    return json(array('status' => 'OK', 'applied' => true));
}
?>
