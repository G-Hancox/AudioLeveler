<?php
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
 *   POST   cancel     stop the running job after the current song
 *   GET    options    saved defaults for the page
 *   POST   options    save defaults
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
        array('method' => 'POST', 'endpoint' => 'cancel', 'callback' => 'AudioLevelerCancel'),
        array('method' => 'GET', 'endpoint' => 'options', 'callback' => 'AudioLevelerGetOptions'),
        array('method' => 'POST', 'endpoint' => 'options', 'callback' => 'AudioLevelerSetOptions'),
        array('method' => 'DELETE', 'endpoint' => 'backups', 'callback' => 'AudioLevelerDeleteBackups'),
        array('method' => 'POST', 'endpoint' => 'choice', 'callback' => 'AudioLevelerSetChoice'),
        array('method' => 'POST', 'endpoint' => 'autocheck', 'callback' => 'AudioLevelerAutoCheck'),
    );
}

define('AUDIOLEVELER_PLUGIN', 'AudioLeveler');

function AudioLevelerDefaults()
{
    return array(
        'target' => -14.0,   // LUFS
        'ceiling' => -1.0,   // dBTP
        'mode' => 'auto',    // auto (recommended per song) | volume | limit | compress
        'bgOffset' => 10.0,  // dB under the target for songs set to Background
        'backup' => true,
        'waitIdle' => true,
        'lossless' => true,  // change MP3 volume losslessly when no limiting is needed
        'autoLevel' => false, // level new and replaced songs automatically
        'playbackGain' => true, // use FPP's playback gain for volume-only fixes, where FPP has it
        'match' => 'speakers', // speakers (ignore deep bass, as FPP's Normalize) | lufs
        'videos' => true,    // level the sound of the videos in the videos folder too
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

// The videos folder, or '' when videos are switched off (the worker then leaves them out).
function AudioLevelerVideoDir($opt = null)
{
    global $settings;
    if ($opt === null) {
        $opt = AudioLevelerOptions();
    }
    if (empty($opt['videos'])) {
        return '';
    }
    $dir = isset($settings['videoDirectory']) ? $settings['videoDirectory'] : $settings['mediaDirectory'] . '/videos';
    return rtrim($dir, '/');
}

function AudioLevelerLogFile()
{
    global $settings;
    return rtrim($settings['logDirectory'], '/') . '/plugin-' . AUDIOLEVELER_PLUGIN . '.log';
}

function AudioLevelerLogWritable()
{
    $f = AudioLevelerLogFile();
    return file_exists($f) ? is_writable($f) : is_writable(dirname($f));
}

// FPP versions with File Manager > Normalize apply a per-song gain at playback
// from <config>/media_gain.json. Where that exists, volume-only fixes go there
// (exact, lossless, any format) instead of into the file.
function AudioLevelerNormalizeFile()
{
    global $settings;
    $fpp = isset($settings['fppDir']) ? $settings['fppDir'] : '/opt/fpp';
    return $fpp . '/www/common/audioNormalize.inc.php';
}

function AudioLevelerPlaybackGainSupported()
{
    return file_exists(AudioLevelerNormalizeFile());
}

function AudioLevelerGainFile()
{
    global $settings;
    $cfg = isset($settings['configDirectory']) ? $settings['configDirectory'] : $settings['mediaDirectory'] . '/config';
    return rtrim($cfg, '/') . '/media_gain.json';
}

// What the worker needs to use playback gain (or not).
function AudioLevelerPlaybackGainRequest($opt)
{
    global $settings;
    $on = AudioLevelerPlaybackGainSupported() && !empty($opt['playbackGain']);
    // Playback gain for a video's sound came with FPP's Normalize handling videos.
    $videos = $on && strpos((string) @file_get_contents(AudioLevelerNormalizeFile()), "'videos/'") !== false;
    return array(
        'enabled' => $on,
        'videos' => $videos,
        'file' => AudioLevelerPlaybackGainSupported() ? AudioLevelerGainFile() : '',
        'lock' => rtrim($settings['mediaDirectory'], '/') . '/tmp/media_gain.lock',
    );
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

    if (AudioLevelerStartThroughFppd()) {
        AudioLevelerLog("Started $command job");
        return json(array('status' => 'OK'));
    }

    // fppd isn't running, or hasn't loaded the plugin's command yet (FPP 9
    // and older until fppd restarts): start the worker from here instead.
    $script = __DIR__ . '/bin/leveler.py';
    $prio = 'nice -n 19';
    if (trim(shell_exec('command -v ionice 2>/dev/null')) !== '') {
        $prio .= ' ionice -c 3';
    }
    $cmd = sprintf(
        'nohup %s python3 %s %s --music %s --videos %s --data %s --log %s --request %s > /dev/null 2>> %s &',
        $prio,
        escapeshellarg($script),
        escapeshellarg($command),
        escapeshellarg(AudioLevelerMusicDir()),
        escapeshellarg(AudioLevelerVideoDir()),
        escapeshellarg($data),
        escapeshellarg(AudioLevelerLogFile()),
        escapeshellarg($reqFile),
        // Anything the worker prints before its own logging is up (a Python
        // error, a missing tool) goes to the plugin log when we can write it.
        AudioLevelerLogWritable() ? escapeshellarg(AudioLevelerLogFile()) : '/dev/null'
    );
    exec($cmd);
    AudioLevelerLog("Started $command job (fppd could not start it)");
    return json(array('status' => 'OK'));
}

/* Ask fppd to run the Start Job command. False if fppd can't be asked or doesn't have the command. */
function AudioLevelerStartThroughFppd()
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
        'content' => '[]',
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

// Start the background check unless it's already running.
function AudioLevelerStartVideoProbe($videoDir)
{
    $data = AudioLevelerDataDir();
    $lock = @fopen($data . '/probe.lock', 'c');
    if ($lock) {
        $free = flock($lock, LOCK_EX | LOCK_NB);
        if ($free) {
            flock($lock, LOCK_UN);
        }
        fclose($lock);
        if (!$free) {
            return;
        }
    }
    $prio = 'nice -n 19';
    if (trim(shell_exec('command -v ionice 2>/dev/null')) !== '') {
        $prio .= ' ionice -c 3';
    }
    exec(sprintf('nohup %s python3 %s --videos %s --data %s > /dev/null 2>&1 &', $prio,
        escapeshellarg(__DIR__ . '/bin/probe_videos.py'), escapeshellarg($videoDir), escapeshellarg($data)));
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
    $gains = AudioLevelerPlaybackGainSupported() ? AudioLevelerReadJson(AudioLevelerGainFile(), array()) : array();
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
            $row['pbSource'] = (isset($gains[$name]['source']) && $gains[$name]['source'] === 'AudioLeveler') ? 'plugin' : 'fpp';
        }
        $files[] = $row;
    }

    if ($checking) {
        AudioLevelerStartVideoProbe($videoDir);
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
        'playbackGainVideos' => AudioLevelerPlaybackGainRequest(AudioLevelerOptions())['videos'],
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
    $opt = array_merge(AudioLevelerOptions(), $body);
    // Songs without a fix of their own always use the recommendation. (An
    // older saved 'mode' setting from before per-song fixes is ignored.)
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
            $opt[$k] = floatval($saved);
        } else {
            $opt[$k] = $saved;
        }
    }
    return $opt;
}

// GET /api/plugin/AudioLeveler/options
function AudioLevelerGetOptions()
{
    AudioLevelerNoCache();
    return json(array('status' => 'OK', 'options' => AudioLevelerOptions()));
}

// POST /api/plugin/AudioLeveler/options
function AudioLevelerSetOptions()
{
    $body = AudioLevelerBody();
    $defaults = AudioLevelerDefaults();
    foreach ($defaults as $k => $v) {
        if (!array_key_exists($k, $body)) {
            continue;
        }
        $val = $body[$k];
        if ($k === 'mode' && !in_array($val, array('auto', 'volume', 'limit', 'compress'))) {
            continue;
        }
        if ($k === 'match' && !in_array($val, array('speakers', 'lufs'), true)) {
            continue;
        }
        if ($k === 'target') {
            $val = max(-30, min(-6, floatval($val)));
        }
        if ($k === 'ceiling') {
            $val = max(-6, min(0, floatval($val)));
        }
        if ($k === 'bgOffset') {
            $val = max(3, min(30, floatval($val)));
        }
        if (is_bool($v)) {
            $val = $val ? '1' : '0';
        }
        // Automatic leveling only handles songs added or changed after it was
        // switched on, so switching it on never sweeps a whole library.
        if ($k === 'autoLevel' && $val === '1' && !AudioLevelerOptions()['autoLevel']) {
            WriteSettingToFile('AudioLeveler_autoSince', (string) time(), AUDIOLEVELER_PLUGIN);
        }
        WriteSettingToFile('AudioLeveler_' . $k, (string) $val, AUDIOLEVELER_PLUGIN);
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
        'since' => intval(ReadSettingFromFile('AudioLeveler_autoSince', AUDIOLEVELER_PLUGIN)),
        'playbackGain' => AudioLevelerPlaybackGainRequest($opt),
        'match' => $opt['match'] === 'lufs' ? 'lufs' : 'speakers',
        'music' => AudioLevelerMusicDir(),
        'videos' => AudioLevelerVideoDir($opt),
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
    global $settings;
    AudioLevelerWriteAutoSettings();
    if (!AudioLevelerOptions()['autoLevel'] || AudioLevelerBusy()) {
        return json(array('status' => 'OK', 'started' => false));
    }
    $script = __DIR__ . '/bin/auto_check.sh';
    exec('MEDIADIR=' . escapeshellarg(rtrim($settings['mediaDirectory'], '/')) . ' ' .
        escapeshellarg($script) . ' > /dev/null 2>&1');
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
    fwrite($fp, json_encode($choices, JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return json(array('status' => 'OK', 'count' => count($files)));
}
?>
