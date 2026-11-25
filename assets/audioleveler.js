/* Audio Leveler - Copyright (C) 2026 G Hancox. Created by G Hancox, built with Claude. Licensed under the GNU GPL v2. */
/* Audio Leveler - Content Setup page */
(function () {
    'use strict';

    var API = '/api/plugin/AudioLeveler/';
    var files = [];
    var options = null;
    var selected = {};
    var pollTimer = null;
    var lastJobState = null;
    var pgVideos = false;      // ...and to a video's sound too
    var pgSupported = false;   // this FPP applies playback gain (File Manager > Normalize exists)
    var shown = [];          // songs currently listed, after filter/search/sort
    var filter = 'all';
    // Songs and videos are two separate lists, one tab each: 'files' is the
    // current tab's list, and every button acts on that tab only.
    var allFiles = [];
    var probeTimer = null;
    var tab = 'songs';
    try { if (localStorage.getItem('audioLeveler.tab') === 'videos') { tab = 'videos'; } } catch (e) { /* no storage */ }
    function noun(n) { return tab === 'videos' ? (n === 1 ? 'video' : 'videos') : (n === 1 ? 'song' : 'songs'); }
    function inTab(f) { return !!f.video === (tab === 'videos'); }
    // A job's files by name ("videos/..." for videos): what to call them.
    function jobNoun(names, n) {
        var v = names.filter(function (x) { return String(x).indexOf('videos/') === 0; }).length;
        var one = n === 1;
        if (names.length && v === names.length) { return one ? 'video' : 'videos'; }
        if (v) { return one ? 'file' : 'songs and videos'; }
        return one ? 'song' : 'songs';
    }
    function shortName(name) { return String(name).replace(/^videos\//, ''); }
    var search = '';
    var sortKey = 'name';
    var sortDir = 1;
    var lastDone = -1;       // songs finished at the last poll, to refresh the list as each one completes
    var workingOn = '';      // song the running job is on right now
    var workingCmd = '';
    var jobProgress = { cmd: '', done: 0, total: 0 };   // for the "totals are updating" note
    var deleteArmed = false;

    function $id(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function toast(msg, ok) {
        if (window.jQuery && jQuery.jGrowl) {
            jQuery.jGrowl(msg, { themeState: ok === false ? 'danger' : 'success' });
        }
    }

    function api(method, path, body) {
        // Never reuse a stored reply: progress and song lists change every few
        // seconds, and a cached copy makes the page look frozen.
        var init = { method: method, headers: {}, cache: 'no-store' };
        if (method === 'GET') {
            path += (path.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
        }
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        return fetch(API + path, init).then(function (r) {
            return r.json().catch(function () {
                // A reply that isn't JSON (a PHP warning printed in front of
                // it, say) is a problem to show, not an empty answer.
                if (r.ok) { throw new Error('FPP sent back something Audio Leveler couldn\'t read. Check the plugin log (Help > FPP Logs).'); }
                return {};
            }).then(function (j) {
                if (!r.ok) {
                    throw new Error(j.message || ('Request failed (' + r.status + ')'));
                }
                return j;
            });
        });
    }

    function fmtBytes(n) {
        if (!n) { return '0 MB'; }
        if (n > 1e9) { return (n / 1e9).toFixed(1) + ' GB'; }
        return Math.max(1, Math.round(n / 1e6)) + ' MB';
    }

    var MODE_NAMES = { auto: 'recommended', volume: 'volume only', limit: 'limiter', compress: 'compression' };
    var CHOICE_NAMES = {
        'default': 'Recommended', volume: 'Volume only', limit: 'Limiter',
        compress: 'Compression', background: 'Background', skip: 'Skip'
    };

    /* ---------------- per-song recommendation (display copy) ----------------
       Mirrors recommend() in bin/leveler.py, which is what the worker uses;
       keep the two in step. Quality first: a plain volume change whenever
       it's enough, the limiter only for gentle trims, never compression. */

    var NEAR_TARGET_DB = 0.5, GENTLE_LIMIT_DB = 3.0, LOSSLESS_STEP = 1.505;
    var VOLUME_CLOSE_DB = 1.0, PEAK_TOLERANCE_DB = 0.1;
    var WIDE_DYNAMICS_LU = 15, LONG_TRACK_SECONDS = 900;

    // Names that suggest a track is meant to sit under the show.
    var AMBIANCE_NAME = /ambien|ambiance|background|off.?hours|intermission|\bloop\b|\bbgm\b|soundscape/i;

    function recommendMode(I, TP, target, ceiling) {
        var gain = target - I;
        var over = (TP === null || TP === undefined) ? null : TP + gain - ceiling;
        if (over === null || over <= PEAK_TOLERANCE_DB) {
            return Math.abs(gain) < NEAR_TARGET_DB ? 'none' : 'volume';
        }
        if (over <= VOLUME_CLOSE_DB) { return 'volume'; }
        return over <= GENTLE_LIMIT_DB ? 'limit' : 'volume';
    }

    // Speaker matching (as FPP's Normalize does it): each song's own target
    // moves by how loud it is with the deep bass removed, at most 4 dB.
    // Mirrors speaker_delta() in bin/leveler.py.
    var SPEAKER_OFFSET_DB = 3.0, SPEAKER_MAX_DEV_DB = 4.0;
    function speakerDelta(f) {
        if (!options || options.match === 'lufs' || f.spk === null || f.spk === undefined) { return 0; }
        var I = f.rawLufs !== undefined ? f.rawLufs : f.lufs;   // both raw: playback gain cancels out
        return Math.max(-SPEAKER_MAX_DEV_DB, Math.min(SPEAKER_MAX_DEV_DB, I - f.spk - SPEAKER_OFFSET_DB));
    }
    function songTarget(f) { return options.target + speakerDelta(f); }
    // Where this song is meant to end up: its target, under the show if it's Background.
    function intendedTarget(f) {
        return songTarget(f) - (f.choice === 'background' ? (options.bgOffset || 10) : 0);
    }

    function dB(v) { return (v > 0 ? '+' : (v < 0 ? '−' : '±')) + Math.abs(v).toFixed(1) + ' dB'; }

    // What leveling would do to this song now: {text, note, rec}
    function planFor(f) {
        if (f.noAudio) { return { text: 'Nothing to level', note: '' }; }
        if (!hasLufs(f)) { return { text: 'Measure first', note: '' }; }
        // Every song starts on Recommended ('default'); an older saved
        // 'auto' choice means the same thing.
        var choice = (!f.choice || f.choice === 'auto') ? 'default' : f.choice;
        var mode = choice === 'default' ? 'auto' : choice;
        var target = songTarget(f), ceiling = options.ceiling;
        var I = f.lufs, TP = (f.peak === null || f.peak === undefined) ? null : f.peak;
        // On an FPP with playback gain, volume-only fixes go there: exact and
        // lossless for every format, no lossless-step rounding.
        // Where FPP has Normalize it does the leveling (files never change).
        var playback = pgSupported && (!f.video || pgVideos);
        var mp3Lossless = !playback && /\.mp3$/i.test(f.name) && options.lossless !== false;
        var note = [];
        if (f.lra !== null && f.lra !== undefined && f.lra > WIDE_DYNAMICS_LU && mode !== 'compress') {
            note.push('Wide dynamics (' + f.lra.toFixed(0) + ' LU); compression is an option if quiet parts get lost');
        }
        if (f.length && f.length > LONG_TRACK_SECONDS && choice !== 'background' && choice !== 'skip') {
            note.push('Long track. Background?');
        }
        if (choice === 'skip') { return { text: 'Skipped', note: '' }; }
        if (choice === 'background') { mode = 'volume'; target = target - (options.bgOffset || 10); }
        var delta = speakerDelta(f);
        if (Math.abs(delta) >= 0.5) {
            note.unshift('Speaker match: aims ' + Math.abs(delta).toFixed(1) + ' dB ' + (delta > 0 ? 'louder' : 'quieter') +
                ' (' + (delta > 0 ? 'bass-heavy' : 'carries well') + ' on outdoor speakers)');
        }
        if (options.match !== 'lufs' && hasLufs(f) && !f.hasSpk) {
            note.push('Measure again for speaker matching');
        }
        var rec = mode === 'auto';
        if (rec) {
            mode = recommendMode(I, TP, target, ceiling);
            if (mode === 'none') { return { text: 'Fine as is', note: note.join(' · '), rec: true }; }
            // Normalize never rewrites a file: unless the limiter is allowed, a
            // song whose peaks hold it back lands a little short (the worker
            // does the same).
            if (mode === 'limit' && playback && !options.allowLimiter) {
                mode = 'volume';
                var shortBy = TP === null ? 0 : TP + (target - I) - ceiling;
                note.unshift('Its peaks hold it ' + shortBy.toFixed(1) + ' dB short. Pick Limiter in Fix to bring it all the way up (rewrites the file)');
            }
        }
        if (AMBIANCE_NAME.test(f.name) && choice !== 'background' && choice !== 'skip') {
            note.push('Sounds like ambiance: Background keeps it under the show');
        }
        if (f.lateTag) {
            note.push('Plays 25 ms late on FPP: use Fix MP3 timing');
        }
        var gain = target - I;
        // Same rule as the worker: an MP3 changed losslessly lands to within
        // half a step, so for those "fine" means within that half step.
        var fineDb = mp3Lossless ? LOSSLESS_STEP / 2 + 0.03 : NEAR_TARGET_DB;
        var text;
        if (mode === 'compress') {
            text = 'Compression, then to ' + target + ' LUFS · re-encode';
        } else if (mode === 'limit') {
            var trim = TP === null ? 0 : TP + gain - ceiling;
            if (Math.abs(gain) < fineDb && (TP === null || TP <= ceiling + PEAK_TOLERANCE_DB)) {
                return { text: 'Fine as is', note: note.join(' · '), rec: rec };
            }
            if (trim <= PEAK_TOLERANCE_DB) {
                text = dB(gain) + (mp3Lossless ? ' · lossless' : ' · re-encode');
                // (The worker treats a limiter fix that needs no limiting as a
                // plain volume change, so it's a playback gain where available.)
                if (playback) { text = dB(gain) + ' · FPP Normalize'; }
            } else {
                text = dB(gain) + ' · limiter trims ' + trim.toFixed(1) + ' dB · re-encode';
            }
        } else { // volume
            if (TP !== null && TP + gain > ceiling + PEAK_TOLERANCE_DB) { gain = ceiling - TP; }
            if (Math.abs(target - I) < fineDb && !(TP !== null && TP > ceiling + PEAK_TOLERANCE_DB)) {
                return { text: choice === 'background' ? 'Already at background level' : 'Fine as is', note: note.join(' · '), rec: rec };
            }
            var lossless = false;
            if (mp3Lossless) {
                var steps = Math.round(gain / LOSSLESS_STEP);
                while (steps > 0 && TP !== null && TP + steps * LOSSLESS_STEP > ceiling) { steps--; }
                // Same rule as the worker: whole steps must land within half a step.
                if (Math.abs(gain - steps * LOSSLESS_STEP) <= LOSSLESS_STEP / 2 + 0.05) {
                    lossless = true;
                    gain = steps * LOSSLESS_STEP;
                }
            }
            if (lossless && Math.abs(gain) < 0.01) {
                text = 'Fine as is';
            } else {
                text = dB(gain) + (playback ? ' · FPP Normalize' : lossless ? ' · lossless' : ' · re-encode');
            }
            var lands = I + gain;
            if (lands < target - 0.8) {
                text += ' · ends at ' + lands.toFixed(1) + ' LUFS';
            }
        }
        return { text: text, note: note.join(' · '), rec: rec };
    }

    function fixHtml(f, i) {
        if (f.noAudio) { return '<span class="small text-body-secondary">Nothing to level</span>'; }
        var choice = (!f.choice || f.choice === 'auto') ? 'default' : f.choice;
        var opts = Object.keys(CHOICE_NAMES).map(function (k) {
            var label = CHOICE_NAMES[k];
            return '<option value="' + k + '"' + (k === choice ? ' selected' : '') + '>' + esc(label) + '</option>';
        }).join('');
        var plan = planFor(f);
        return '<select class="form-select form-select-sm al-fix" data-i="' + i + '" aria-label="Fix for ' + esc(f.name) + '">' + opts + '</select>' +
            '<div class="small mt-1">' + esc(plan.text) + '</div>' +
            (plan.note ? '<div class="small text-body-secondary">' + esc(plan.note) + '</div>' : '');
    }

    /* ---------------- options ---------------- */

    // The settings are FPP setting rows (settings.json): FPP saves each one as
    // it changes, then calls audioLevelerSettingSaved(). The page keeps its own
    // copy (from the API) for the plan, the stats and the advisor.
    function showOptions(o) {
        options = o;
        renderRows();
    }

    window.audioLevelerSettingSaved = function (name) {
        api('POST', 'settingschanged').then(function (j) {
            var wasOn = options && options.autoLevel;
            showOptions(j.options);
            // Automatic leveling switched on: look for new uploads straight away.
            if (name === 'AudioLeveler_autoLevel' && j.options.autoLevel && !wasOn) {
                setTimeout(autoCheck, 800);
            }
        }).catch(function (e) { toast(e.message, false); });
    };

    /* ---------------- songs table ---------------- */

    function lufsClass(f) {
        if (!f.measured || f.lufs === null || f.lufs === undefined) { return ''; }
        var d = Math.abs(f.lufs - (options ? intendedTarget(f) : -14));
        if (d <= 1) { return 'text-success'; }
        if (d <= 4) { return 'text-warning-emphasis'; }
        return 'text-danger';
    }

    var WORKING_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', tags: 'Saving song info for', auto: 'Auto-leveling new uploads' };

    function statusHtml(f) {
        var clip = f.measured && f.peak !== null && f.peak !== undefined && f.peak > 0
            ? ' <span class="badge text-bg-danger" title="Peaks go over full scale, so this song clips when played. Leveling brings them under the ceiling. Distortion recorded into the song itself can\'t be removed.">clips</span>' : '';
        return statusText(f) + clip;
    }

    function statusText(f) {
        if (busy() && workingOn && f.name === workingOn) {
            return '<span class="badge text-bg-primary"><span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' +
                esc(WORKING_NAMES[workingCmd] || 'Working') + '…</span>';
        }
        if (f.pbGain !== undefined && f.pbSource === 'fpp') {
            return '<span class="badge text-bg-info">FPP Normalize</span> <span class="small text-body-secondary">' +
                esc(dB(f.pbGain) + ' at playback') + '</span>';
        }
        if (f.leveled) {
            var l = f.leveled;
            return '<span class="badge text-bg-success">Leveled</span> <span class="small text-body-secondary">' +
                esc((Math.round(l.target * 10) / 10) + ' LUFS, ' + (l.method === 'playback' ? 'FPP Normalize ' + dB(f.pbGain || l.gain)
                    : l.method === 'lossless' ? 'lossless'
                    : l.method === 'original' ? 'original kept'
                    : (MODE_NAMES[l.mode] || l.mode) + ', re-encoded')) + '</span>';
        }
        if (f.changedSinceLeveled) {
            return '<span class="badge text-bg-warning">Replaced since leveling</span>';
        }
        if (!f.measured) {
            return '<span class="small text-body-secondary">Not measured yet</span>';
        }
        if (f.noAudio) {
            return '<span class="small text-body-secondary">No sound track</span>';
        }
        return '<span class="small text-body-secondary">Original</span>';
    }

    function hasLufs(f) { return f.measured && f.lufs !== null && f.lufs !== undefined; }
    function clips(f) { return f.measured && f.peak !== null && f.peak !== undefined && f.peak > 0; }
    function offTarget(f) {
        return hasLufs(f) && !!options && f.choice !== 'skip' && Math.abs(f.lufs - intendedTarget(f)) > 1;
    }

    function stat(value, label, cls) {
        // Greyed out while a job is running: the totals are mid-update.
        return '<div class="col-6 col-md-3"><div class="h-100 border rounded bg-body-tertiary px-3 py-2' +
            (busy() ? ' opacity-50' : '') + '">' +
            '<div class="fs-5 fw-semibold ' + (cls || '') + '">' + value + '</div>' +
            '<div class="small text-body-secondary">' + label + '</div></div></div>';
    }

    function renderStats() {
        var el = $id('alStats');
        if (!files.length) {
            el.innerHTML = '<div class="col-12 text-body-secondary">No ' + noun(2) + ' found in the ' + (tab === 'videos' ? 'videos' : 'music') + ' folder.</div>';
            return;
        }
        var measured = files.filter(hasLufs);
        // Spread of the show songs around where each is meant to be: Background
        // and Skip songs, and speaker-matching offsets, are deliberate.
        var show = measured.filter(function (f) { return f.choice !== 'background' && f.choice !== 'skip'; });
        var dev = show.map(function (f) { return f.lufs - speakerDelta(f); });
        var spread = '&ndash;', spreadCls = '', spreadLbl = 'loudness spread';
        if (dev.length > 1) {
            var lo = Math.min.apply(null, dev);
            var hi = Math.max.apply(null, dev);
            spread = (hi - lo).toFixed(1) + ' <small class="fw-normal">dB</small>';
            spreadCls = hi - lo <= 2 ? 'text-success' : (hi - lo <= 6 ? 'text-warning-emphasis' : 'text-danger');
            spreadLbl = 'spread of show ' + noun(2) + (options.match === 'lufs' ? ', ' + lo.toFixed(1) + ' to ' + hi.toFixed(1) + ' LUFS' : ', speaker matched');
        }
        var clipN = measured.filter(clips).length;
        var offN = measured.filter(offTarget).length;
        var notM = files.filter(function (f) { return !f.measured; }).length;
        // While a job runs these totals are a mix of old and new numbers, so
        // grey them out and say so, rather than let them look final.
        var stale = busy();
        var verb = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', tags: 'Saving song info for', auto: 'Auto-leveling new uploads' }[jobProgress.cmd] || 'Working';
        el.innerHTML =
            (stale ? '<div class="col-12 small text-body-secondary">' +
                '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' +
                esc(verb + '…' + (jobProgress.total ? ' ' + jobProgress.done + ' of ' + jobProgress.total + ' done.' : '') +
                    ' These totals will update when it finishes.') + '</div>' : '') +
            stat(files.length, notM ? notM + ' not measured yet' : noun(files.length) + ', all measured') +
            stat(spread, esc(spreadLbl), spreadCls) +
            stat(clipN, 'clipping', clipN ? 'text-danger' : 'text-success') +
            stat(offN, 'more than 1 dB off their target', offN ? 'text-warning-emphasis' : 'text-success');
    }

    // Meter range in LUFS: quiet end to loud end.
    var METER_LO = -30, METER_HI = -3;

    function meterHtml(f) {
        if (!hasLufs(f)) { return ''; }
        var pos = function (v) { return Math.max(0, Math.min(100, 100 * (v - METER_LO) / (METER_HI - METER_LO))); };
        var d = Math.abs(f.lufs - intendedTarget(f));
        var bg = d <= 1 ? 'bg-success' : (d <= 4 ? 'bg-warning' : 'bg-danger');
        return '<div class="al-meter" aria-hidden="true">' +
            '<div class="al-meter-fill ' + bg + '" style="width:' + pos(f.lufs).toFixed(1) + '%"></div>' +
            '<div class="al-meter-target" style="left:' + pos(intendedTarget(f)).toFixed(1) + '%"></div></div>';
    }

    // A video shows by its file name, marked as a video.
    function displayName(f) { return f.video ? f.name.slice(7) : f.name; }
    function songName(f) {
        return esc(displayName(f));
    }

    // Sort songs by title, not raw file name: skip a leading track number
    // ("01 - ", "13 ", "07."), ignore case, and order numbers naturally.
    // A name that merely starts with a digit (like "2WEI ...") is left alone.
    function titleKey(name) {
        return name.replace(/^\s*\d{1,3}(?:\s*[-_.)]\s*|\s+)(?=\S)/, '');
    }

    function byTitle(a, b) {
        return titleKey(displayName(a)).localeCompare(titleKey(displayName(b)), undefined, { sensitivity: 'base', numeric: true }) ||
            a.name.localeCompare(b.name, undefined, { numeric: true });
    }

    function visibleFiles() {
        var q = search.trim().toLowerCase();
        var list = files.filter(function (f) {
            if (q && f.name.toLowerCase().indexOf(q) < 0) { return false; }
            switch (filter) {
                case 'off': return offTarget(f);
                case 'clip': return clips(f);
                case 'leveled': return !!f.leveled;
                case 'replaced': return !!f.changedSinceLeveled;
                case 'custom': return !!f.choice && f.choice !== 'default' && f.choice !== 'auto';
                case 'unmeasured': return !f.measured || (!hasLufs(f) && !f.noAudio);
                default: return true;
            }
        });
        list.sort(function (a, b) {
            if (sortKey === 'name') { return sortDir * byTitle(a, b); }
            var av = sortKey === 'lufs' ? (hasLufs(a) ? a.lufs : null) : (a.measured ? a.peak : null);
            var bv = sortKey === 'lufs' ? (hasLufs(b) ? b.lufs : null) : (b.measured ? b.peak : null);
            if (av === null || av === undefined) { return (bv === null || bv === undefined) ? byTitle(a, b) : 1; }
            if (bv === null || bv === undefined) { return -1; }
            return sortDir * (av - bv) || byTitle(a, b);
        });
        return list;
    }

    function renderSortIcons() {
        Array.prototype.forEach.call(document.querySelectorAll('#audioLeveler .al-sort'), function (b) {
            var k = b.getAttribute('data-sort');
            b.querySelector('.al-sort-icon').textContent = k === sortKey ? (sortDir > 0 ? '▲' : '▼') : '';
            b.closest('th').setAttribute('aria-sort', k === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
        });
    }

    /* ---------------- target advisor ----------------
       For each target, how the show songs would be fixed (by the same
       recommendation the worker uses), and the loudest target every one of
       them can reach with a plain volume change. Background and Skip songs
       aren't counted: they don't follow the show's target. */

    var ADVISOR_TARGETS = [-18, -16, -14, -12, -10];

    function renderAdvisor() {
        var box = $id('alAdvisor');
        var show = files.filter(function (f) {
            return hasLufs(f) && f.choice !== 'background' && f.choice !== 'skip';
        });
        if (show.length < 2 || !options) { box.classList.add('d-none'); return; }
        box.classList.remove('d-none');
        var ceiling = options.ceiling;
        var targets = ADVISOR_TARGETS.slice();
        if (targets.indexOf(options.target) < 0) { targets.push(options.target); targets.sort(function (a, b) { return a - b; }); }
        // Raw loudness/peak (a playback gain is part of how the song is played
        // now, not of the song) and each song's speaker-matching offset.
        function raw(f) {
            var g = f.pbGain || 0;
            return { I: (f.rawLufs !== undefined ? f.rawLufs : f.lufs), TP: (f.peak === null || f.peak === undefined) ? null : f.peak - g };
        }
        $id('alAdvisorRows').innerHTML = targets.map(function (t) {
            var vol = 0, lim = 0, held = 0;
            show.forEach(function (f) {
                var r = raw(f);
                var rec = recommendMode(r.I, r.TP, t + speakerDelta(f), ceiling);
                // With FPP's Normalize and no limiter allowed, those land a little quieter.
                if (rec === 'limit') { if (pgSupported && !options.allowLimiter) { held++; } else { lim++; } }
                else if (rec === 'volume' && r.TP !== null && r.TP + (t + speakerDelta(f) - r.I) - ceiling > VOLUME_CLOSE_DB) { held++; }
                else { vol++; }
            });
            var current = t === options.target;
            return '<tr' + (current ? ' class="table-active"' : '') + '>' +
                // The target itself is the button that switches to it.
                '<td class="text-nowrap">' + (current
                    ? '<span class="fw-semibold">' + t + '</span> <span class="small text-body-secondary">now</span>'
                    : '<button type="button" class="btn btn-sm btn-link p-0 al-use-target" data-t="' + t + '" title="Use ' + t + ' LUFS">' + t + '</button>') + '</td>' +
                '<td class="text-end">' + vol + '</td>' +
                '<td class="text-end">' + (lim || '–') + '</td>' +
                '<td class="text-end' + (held ? ' text-warning-emphasis' : '') + '">' + (held || '–') + '</td>' +
                '</tr>';
        }).join('');
        // The loudest target every show song reaches with no limiting at all.
        var limit = Infinity, by = null;
        show.forEach(function (f) {
            var r = raw(f);
            if (r.TP === null) { return; }
            var t = ceiling - r.TP + r.I - speakerDelta(f);
            if (t < limit) { limit = t; by = displayName(f); }
        });
        // One short line; the rest is in the note's own tip.
        var note = $id('alAdvisorNote');
        note.textContent = isFinite(limit)
            ? 'Every song fits with just volume up to ' + (Math.floor(limit * 2) / 2).toFixed(1) + ' LUFS.'
            : '';
        note.title = isFinite(limit)
            ? (by ? 'The first song to need help above that is ' + by + '. ' : '') +
              'Above it, a song a little short of headroom is left up to 1 dB quieter instead of limited. Counts use each song\'s recommended fix' +
              (options.match !== 'lufs' ? ' and speaker matching' : '') + '.'
            : '';
    }

    function renderRows() {
        renderStats();
        renderAdvisor();
        renderSortIcons();
        var tb = $id('alRows');
        shown = visibleFiles();
        if (!files.length) {
            tb.innerHTML = '<tr><td colspan="7" class="text-body-secondary py-3 text-center">No ' + noun(2) + ' in the ' + (tab === 'videos' ? 'videos' : 'music') + ' folder.</td></tr>';
        } else if (!shown.length) {
            tb.innerHTML = '<tr><td colspan="7" class="text-body-secondary py-3 text-center">No ' + noun(2) + ' match this filter.</td></tr>';
        } else {
            tb.innerHTML = shown.map(function (f, i) {
                var lufs = hasLufs(f) ? f.lufs.toFixed(1) : '&ndash;';
                var peak = f.measured && f.peak !== null && f.peak !== undefined ? f.peak.toFixed(1) : '&ndash;';
                var restore = f.canRestore
                    ? '<button type="button" class="buttons btn btn-sm btn-outline-secondary al-restore" data-i="' + i + '" title="Put the original back">Restore</button>'
                    : '';
                return '<tr' + (selected[f.name] ? ' class="table-active"' : '') + '>' +
                    '<td class="text-center"><input class="form-check-input al-sel" type="checkbox" data-i="' + i + '"' +
                    (selected[f.name] ? ' checked' : '') + ' aria-label="Select ' + esc(f.name) + '"></td>' +
                    '<td class="text-break al-song">' + playButtonHtml(f.name) + songName(f) +
                    '<div class="d-lg-none mt-1">' + statusHtml(f) + '</div>' +
                    '<div class="d-lg-none mt-1 al-fix-cell">' + fixHtml(f, i) + '</div>' +
                    (restore ? '<div class="d-sm-none mt-1">' + restore + '</div>' : '') + '</td>' +
                    '<td class="text-end text-nowrap ' + lufsClass(f) + '">' + lufs + meterHtml(f) + '</td>' +
                    '<td class="text-end text-nowrap d-none d-sm-table-cell">' + peak + '</td>' +
                    '<td class="d-none d-lg-table-cell text-nowrap">' + statusHtml(f) + '</td>' +
                    '<td class="d-none d-lg-table-cell al-fix-cell">' + fixHtml(f, i) + '</td>' +
                    '<td class="text-end d-none d-sm-table-cell">' + restore + '</td>' +
                    '</tr>';
            }).join('');
        }
        updateButtons();
    }

    function selectedNames() {
        return files.filter(function (f) { return selected[f.name]; }).map(function (f) { return f.name; });
    }

    function busy() {
        return lastJobState === 'starting' || lastJobState === 'running' || lastJobState === 'waiting';
    }

    function updateButtons() {
        var sel = selectedNames();
        var b = busy();
        // MP3s whose gapless tag FPP can't read play 25 ms late: offer the fix.
        var late = tab === 'songs' ? files.filter(function (f) { return f.lateTag; }) : [];
        $id('alLateNote').classList.toggle('d-none', !late.length);
        $id('alLateCount').textContent = late.length + ' song' + (late.length === 1 ? '' : 's');
        $id('alRetime').disabled = b;
        $id('alMeasure').disabled = b || !files.length;
        $id('alLevelAll').disabled = b || !files.length;
        $id('alLevelSel').disabled = b || !sel.length;
        var selWithBackup = files.filter(function (f) { return selected[f.name] && f.canRestore; }).length;
        $id('alRestoreSel').disabled = b || !selWithBackup;
        // Show the selected songs' fix: one name when they all share it,
        // "Mixed fixes" when they don't.
        var sf = $id('alSetFix'), have = {};
        files.forEach(function (f) { if (selected[f.name]) { have[f.choice || 'default'] = true; } });
        var common = Object.keys(have);
        sf.disabled = !sel.length;
        sf.options[0].textContent = common.length > 1 ? 'Mixed fixes' : 'Set fix\u2026';
        if (document.activeElement !== sf || !sel.length) { sf.value = common.length === 1 ? common[0] : ''; }
        $id('alSelText').textContent = sel.length
            ? sel.length + ' ' + noun(sel.length) + ' selected' +
              (selWithBackup ? ' · ' + selWithBackup + ' with an original to restore' : '')
            : 'No ' + noun(2) + ' selected. Tick ' + noun(2) + ' to level or restore just those.';
        $id('alClearSel').classList.toggle('d-none', !sel.length);
        $id('alMeasure').textContent = sel.length ? 'Measure selected' : 'Measure ' + noun(2);
        if (!scanning) { $id('alScan').textContent = 'Scan for ' + noun(2); }
        var all = $id('alSelectAll');
        var shownSel = shown.filter(function (f) { return selected[f.name]; }).length;
        all.checked = shown.length > 0 && shownSel === shown.length;
        all.indeterminate = shownSel > 0 && shownSel < shown.length;
    }

    // If automatic leveling is on, look for new or replaced songs now (the
    // worker exits at once when there are none). A job it starts shows up in
    // the progress bar through the normal polling.
    function autoCheck() {
        if (!options || !options.autoLevel || busy()) { return; }
        api('POST', 'autocheck').then(function (j) {
            if (j.started) { setTimeout(poll, 1500); }
        }).catch(function () {});
    }

    // Save how the given songs should be leveled, and show the new plan at once.
    function setChoice(names, choice) {
        if (!names.length) { return; }
        files.forEach(function (f) { if (names.indexOf(f.name) >= 0) { f.choice = choice; } });
        renderRows();
        api('POST', 'choice', { files: names, choice: choice }).then(function () {
            if (names.length > 1) {
                toast(names.length + ' ' + noun(names.length) + ' set to ' + CHOICE_NAMES[choice] + '.');
            }
        }).catch(function (e) {
            toast(e.message, false);
            loadFiles();
        });
    }

    // Switch between the Songs and Videos lists. The selection and filter
    // start fresh: each tab is its own list.
    function setTab(name, quiet) {
        if (tab === 'eq' && name !== 'eq') { eqLeave(); }
        tab = name;
        if (name !== 'info' && name !== 'eq') {
            try { localStorage.setItem('audioLeveler.tab', name); } catch (e) { /* no storage */ }
        }
        $id('audioLeveler').classList.toggle('al-tab-info', name === 'info');
        $id('audioLeveler').classList.toggle('al-tab-eq', name === 'eq');
        if (name === 'info') { renderInfo(); loadTags(); }
        if (name === 'eq') { renderEq(); loadEq(); eqStartPolling(); startMeter(); }
        applyEqToPlayer();
        [['songs', 'alTabSongs'], ['videos', 'alTabVideos'], ['info', 'alTabInfo'], ['eq', 'alTabEq']].forEach(function (t) {
            var on = t[0] === name;
            $id(t[1]).classList.toggle('active', on);
            $id(t[1]).setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $id('alListTitle').textContent = name === 'videos' ? 'Videos' : 'Songs';
        $id('alNameHead').textContent = name === 'videos' ? 'Video' : 'Song';
        $id('alSilentNote').classList.toggle('d-none', name !== 'videos');
        selected = {};
        setFilter('all');
        files = allFiles.filter(inTab);
        if (!quiet) { renderRows(); updateButtons(); }
    }

    function setFilter(name) {
        filter = name;
        Array.prototype.forEach.call($id('alFilters').querySelectorAll('[data-filter]'), function (x) {
            var on = x.getAttribute('data-filter') === name;
            x.classList.toggle('active', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    var filesSeq = 0;
    function loadFiles() {
        // Two loads can overlap (a poll and a click): only the newest one's
        // answer is used, so an older reply never puts back a stale list.
        var seq = ++filesSeq;
        return api('GET', 'files').then(function (j) {
            if (seq !== filesSeq) { return; }
            allFiles = j.files || [];
            pgSupported = !!j.playbackGainSupported;
            pgVideos = !!j.playbackGainVideos;
            // On FPP 10.4+ a plain volume change is done by FPP's Normalize, so call it that.
            CHOICE_NAMES.volume = pgSupported ? 'Normalize' : 'Volume only';
            var setFixVol = document.querySelector('#alSetFix option[value="volume"]');
            if (setFixVol) { setFixVol.textContent = CHOICE_NAMES.volume; }
            var nVideos = allFiles.filter(function (f) { return f.video; }).length;
            $id('alTabSongs').querySelector('.badge').textContent = allFiles.length - nVideos;
            $id('alTabVideos').querySelector('.badge').textContent = nVideos;
            var checking = j.videosChecking || 0;
            $id('alTabVideosItem').classList.toggle('d-none', !nVideos && !checking);
            if (!nVideos && !checking && tab === 'videos') { setTab('songs', true); }
            var silent = j.silentVideos || 0;
            $id('alSilentNote').innerHTML =
                (checking ? '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Checking ' + checking +
                    ' video' + (checking === 1 ? '' : 's') + ' for a sound track. They appear here as they\'re checked. ' : '') +
                (silent ? silent + ' video' + (silent === 1 ? ' has' : 's have') + ' no sound track, so ' +
                    (silent === 1 ? 'it isn\'t' : 'they aren\'t') + ' listed.' : '');
            // The check runs in the background, under fppd: make sure it's
            // going, then look again shortly for its answers.
            clearTimeout(probeTimer);
            if (checking) {
                api('POST', 'checkvideos').then(function () {
                    probeTimer = setTimeout(loadFiles, 3000);
                }).catch(function (e) {
                    $id('alSilentNote').textContent = e.message;
                });
            }
            files = allFiles.filter(inTab);
            // Show what each song will actually sound like: its own loudness
            // plus any playback gain fppd applies to it.
            allFiles.forEach(function (f) {
                if (f.pbGain !== undefined && f.measured && f.lufs !== null && f.lufs !== undefined) {
                    f.rawLufs = f.lufs;
                    f.lufs = f.lufs + f.pbGain;
                    if (f.peak !== null && f.peak !== undefined) { f.peak = f.peak + f.pbGain; }
                }
                // Something to undo: a backed-up original, or a playback gain we set.
                f.canRestore = !!f.backup || f.pbSource === 'plugin';
            });
            var keep = {};
            files.forEach(function (f) { if (selected[f.name]) { keep[f.name] = true; } });
            selected = keep;
            $id('alNoFfmpeg').classList.toggle('d-none', j.haveFfmpeg !== false);
            var bk = j.backups || { count: 0, bytes: 0 };
            backupCount = bk.count || 0;
            $id('alBackupInfo').textContent = bk.count
                ? bk.count + ' original' + (bk.count === 1 ? '' : 's') + ' backed up (' + fmtBytes(bk.bytes) + ')' +
                  (j.freeBytes ? ', ' + fmtBytes(j.freeBytes) + ' free' : '')
                : 'No backups yet';
            $id('alDeleteBackups').disabled = !bk.count || busy();
            renderRows();
        }).catch(function (e) { toast(e.message, false); });
    }

    /* ---------------- jobs ---------------- */

    var CMD_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', tags: 'Saving song info for', auto: 'Auto-leveling new uploads' };

    function showJob(j) {
        var state = j.state || null;
        var wasBusy = busy();
        lastJobState = state;
        var box = $id('alJob');
        if (busy()) {
            box.classList.remove('d-none');
            $id('alResult').classList.add('d-none');
            var total = j.total || 0, done = j.done || 0;
            // How far into the file being worked on (a long mix takes minutes).
            var part = state === 'running' && done < total ? Math.max(0, Math.min(1, +j.part || 0)) : 0;
            jobProgress = { cmd: j.cmd || jobProgress.cmd, done: done, total: total };
            renderStats();
            var pct = total ? Math.round(100 * (done + part) / total) : 0;
            $id('alJobBar').style.width = pct + '%';
            var verb = CMD_NAMES[j.cmd] || 'Working';
            var txt = state === 'starting' ? 'Starting…'
                : verb + ' ' + (total ? (Math.min(done + 1, total)) + ' of ' + total : '') +
                  (j.current ? ': ' + shortName(j.current) : '') +
                  (part >= 0.01 ? ' (' + Math.round(part * 100) + '%)' : '');
            $id('alJobText').textContent = txt;
            $id('alJobMsg').textContent = j.message || '';
            $id('alJobBar').classList.toggle('bg-warning', state === 'waiting');

            // Show each song's new numbers as soon as it is finished, and mark
            // the one being worked on, instead of waiting for the whole job.
            var cur = state === 'starting' ? '' : (j.current || '');
            if (done !== lastDone) {
                lastDone = done;
                workingOn = cur;
                workingCmd = j.cmd || '';
                loadFiles();
            } else if (cur !== workingOn) {
                workingOn = cur;
                workingCmd = j.cmd || '';
                renderRows();
            }
        } else {
            box.classList.add('d-none');
            lastDone = -1;
            renderStats();
            if (workingOn) {
                workingOn = '';
                renderRows();
            }
            if (wasBusy) {
                showResult(j);
                loadFiles();
                if (j.cmd === 'tags') {
                    // Saved ones now match the files; anything that failed stays to try again.
                    (j.results || []).forEach(function (r) { if (r.ok) { delete info.edits[r.file]; } });
                    loadTags();
                }
            }
        }
        updateButtons();
        renderInfoButtons();
        schedulePoll();
    }

    function showResult(j) {
        var res = j.results || [];
        var names = res.map(function (r) { return r.file; });
        var bad = res.filter(function (r) { return !r.ok; });
        var verb = { analyze: 'Measured', level: 'Leveled', restore: 'Restored', retime: 'Fixed the timing of', tags: 'Updated the info of', auto: 'Auto-leveled' }[j.cmd] || 'Finished';
        var head;
        var cls = 'alert-success';
        if (j.state === 'cancelled') {
            var doneN = res.length, total = j.total || 0;
            var again = { analyze: 'Measure ' + jobNoun(names, 2), level: 'Level all (or Level selected)', restore: 'Restore originals', retime: 'Fix MP3 timing', tags: 'Save' }[j.cmd] || 'it';
            head = 'Stopped after ' + doneN + (total ? ' of ' + total : '') + ' ' + jobNoun(names, doneN) + '. ' +
                (doneN ? 'The ' + (doneN === 1 ? 'one' : doneN) + ' finished ' + (doneN === 1 ? 'is' : 'are') + ' saved' : 'Nothing was changed') +
                (j.stoppedAt ? '; ' + shortName(j.stoppedAt) + ' was left as it was' : '') + '.' +
                (total && doneN < total && j.cmd === 'auto'
                    ? ' The rest are picked up at the next automatic check.'
                    : total && doneN < total && j.cmd !== 'restore'
                    ? ' Press ' + again + ' again to carry on with the rest; finished ones are skipped.' : '');
            cls = 'alert-secondary';
        } else if (j.state === 'error') {
            head = j.message || 'The job stopped with an error.';
            cls = 'alert-danger';
        } else {
            head = verb + ' ' + (res.length - bad.length) + ' ' + jobNoun(names, res.length - bad.length) + '.';
            if (bad.length) { cls = 'alert-warning'; }
        }
        var html = '<div class="alert ' + cls + ' mb-0" role="status"><div>' + esc(head) + '</div>';
        if (bad.length) {
            html += '<div class="mt-1">' + bad.length + ' had a problem:</div><ul class="mb-0">' +
                bad.slice(0, 20).map(function (r) { return '<li>' + esc(shortName(r.file) + ': ' + r.msg) + '</li>'; }).join('') +
                (bad.length > 20 ? '<li>…and ' + (bad.length - 20) + ' more (see the plugin log)</li>' : '') + '</ul>';
        }
        if (j.cmd === 'level' && j.state === 'done' && res.length - bad.length > 0) {
            html += '<div class="mt-1 form-text">If the show now sounds quieter overall, turn up FPP\'s volume.</div>';
        }
        html += '</div>';
        var el = $id('alResult');
        el.innerHTML = html;
        el.classList.remove('d-none');
    }

    function poll() {
        api('GET', 'job').then(showJob).catch(function () { schedulePoll(); });
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, busy() ? 2000 : 15000);
    }

    function start(path, body) {
        $id('alResult').classList.add('d-none');
        lastJobState = 'starting';
        jobProgress = { cmd: path, done: 0, total: 0 };
        updateButtons();
        renderStats();
        return api('POST', path, body).then(function () {
            setTimeout(poll, 500);
        }).catch(function (e) {
            lastJobState = null;
            updateButtons();
            toast(e.message, false);
        });
    }

    /* ---------------- Song info tab (Title and Artist) ----------------
       What FPP shows while a song plays, and what an FM transmitter plugin
       can send as RDS text. Changes are collected here, checked by eye, then
       saved in one go by the worker. File names are never changed. */

    var info = { files: [], edits: {}, filter: 'all', search: '', loaded: false };
    var scanning = false;
    var backupCount = 0;

    // Bits that don't belong in a song's info: "(Official Video)", "[Lyrics]", a website...
    var TAG_JUNK = /\s*[\(\[\{]\s*(?:official\s*(?:music\s*|lyrics?\s*|hd\s*)?(?:video|audio|visuali[sz]er)?|lyrics?(?:\s*video)?|audio(?:\s*only)?|visuali[sz]er|hq|hd|4k|explicit|free\s*download|out\s*now|(?:no\s*)?copyright(?:\s*free)?|full\s*song)\s*[\)\]\}]/ig;
    var TAG_SITE = /\s*(?:[-|~]\s*)?[\(\[]?\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:com|net|org|cc|me|io|ru|info|biz|fm|to|mx|co\.uk)\b\/?\s*[\)\]]?/ig;
    var TAG_TRACKNO = /^\s*(?:track\s*\d{1,3}\b\s*[-._:)]?\s*|\d{1,3}\s*[-._)]\s+)/i;

    function cleanTag(s) {
        s = String(s || '');
        if (s.indexOf(' ') < 0 && s.indexOf('_') >= 0) { s = s.replace(/_+/g, ' '); }
        s = s.replace(TAG_JUNK, '').replace(TAG_SITE, '');
        return s.replace(/\s+/g, ' ').replace(/^[\s\-_|~.]+|[\s\-_|~]+$/g, '');
    }

    // "01 - Bobby Helms - Jingle Bell Rock.mp3" -> artist and title.
    function tagsFromName(name) {
        // " (1)" is a second download of the same file, not part of the name.
        var base = String(name).replace(/\.[^.]+$/, '').replace(/\s*\(\d{1,2}\)$/, '').replace(TAG_TRACKNO, '');
        if (base.indexOf(' ') < 0) { base = base.replace(/_+/g, ' '); }
        var i = base.indexOf(' - ');
        return i > 0 ? { artist: cleanTag(base.slice(0, i)), title: cleanTag(base.slice(i + 3)) }
            : { artist: '', title: cleanTag(base) };
    }

    function infoNow(f) { return info.edits[f.name] || { title: f.title, artist: f.artist }; }

    function infoProblems(t) {
        var p = [];
        if (!t.title) { p.push('No title'); } else if (/^(?:track\s*)?\d{1,3}$/i.test(t.title)) { p.push('Title is just a number'); }
        if (!t.artist) { p.push(t.title.indexOf(' - ') > 0 ? 'Artist is in the title?' : 'No artist'); }
        if ((t.title && cleanTag(t.title) !== t.title) || (t.artist && cleanTag(t.artist) !== t.artist)) { p.push('Has junk to clean up'); }
        return p;
    }

    function infoChanges() { return Object.keys(info.edits).length; }

    function setInfoEdit(f, title, artist) {
        if (title === f.title && artist === f.artist) { delete info.edits[f.name]; } else { info.edits[f.name] = { title: title, artist: artist }; }
    }

    function loadTags() {
        return api('GET', 'tags').then(function (j) {
            info.files = j.files || [];
            info.loaded = true;
            var have = {};
            info.files.forEach(function (f) { have[f.name] = f; });
            Object.keys(info.edits).forEach(function (n) {
                var f = have[n];
                if (!f || !f.editable) { delete info.edits[n]; } else { setInfoEdit(f, info.edits[n].title, info.edits[n].artist); }
            });
            renderInfo();
            return true;
        }).catch(function (e) { toast(e.message, false); return false; });
    }

    // Info saved on this tab that an upload has since replaced (and that isn't
    // already being put back).
    function infoReplaced(f) {
        if (!f.saved || !f.editable) { return false; }
        var e = info.edits[f.name];
        return !(e && e.title === f.saved.title && e.artist === f.saved.artist);
    }

    function renderInfoBadge() {
        var n = info.files.filter(function (f) {
            return f.editable && (f.saved || infoProblems({ title: f.title, artist: f.artist }).length);
        }).length;
        var b = $id('alInfoBadge');
        b.textContent = n;
        b.classList.toggle('d-none', !n);
        b.title = n + ' song' + (n === 1 ? '' : 's') + ' to look at';
    }

    function renderInfo() {
        renderInfoBadge();
        var el = $id('alInfoPanel');
        if (tab !== 'info') { return; }
        if (!el.firstChild) {
            el.innerHTML =
                '<p class="small text-body-secondary mb-2">Title and Artist are what FPP shows while a song plays, and what an FM transmitter ' +
                'plugin can send to car radios (RDS). Only the info inside each MP3 changes: never the file name, so sequences and playlists ' +
                'still find it, and the sound and timing stay exactly the same. Look the changes over, then <b>Save</b>.</p>' +
                '<div class="alert alert-secondary small py-2 mb-3">Uploading a song again (from xLights, say) brings back the info in your ' +
                'computer\'s copy. This tab remembers what you saved and flags songs an upload has changed, with <b>Put back your info</b> ' +
                'to restore them. To make a fix stick for good, also make it on your computer.</div>' +
                '<div class="d-flex flex-wrap gap-2 align-items-center mb-2">' +
                '<button id="alInfoScan" type="button" class="buttons btn btn-sm btn-outline-primary" title="Looks in the music folder again, for songs uploaded since this page opened. Unsaved changes are kept.">Scan for songs</button>' +
                '<button id="alInfoFill" type="button" class="buttons btn btn-sm btn-outline-secondary" title="Fills in blank titles and artists from file names like Artist - Title.mp3">Fill blanks from file names</button>' +
                '<button id="alInfoClean" type="button" class="buttons btn btn-sm btn-outline-secondary" title="Removes (Official Video), [Lyrics], websites and similar">Clean up junk</button>' +
                '<button id="alInfoPutBack" type="button" class="buttons btn btn-sm btn-outline-warning d-none" title="Puts back the info you saved here for songs an upload has replaced. Look them over, then Save.">Put back your info</button>' +
                '<span class="me-auto"></span>' +
                '<button id="alInfoUndo" type="button" class="btn btn-sm btn-link">Undo changes</button>' +
                '<button id="alInfoSave" type="button" class="buttons btn btn-sm btn-success">Save</button></div>' +
                '<div class="d-flex flex-wrap gap-2 align-items-center mb-2">' +
                '<div id="alInfoFilters" class="d-flex flex-wrap gap-1" role="group" aria-label="Show songs">' +
                '<button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" data-info-filter="all">All</button>' +
                '<button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" data-info-filter="look">Needs a look</button>' +
                '<button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" data-info-filter="changed">Changed</button></div>' +
                '<input id="alInfoSearch" type="search" class="form-control form-control-sm w-auto ms-auto" placeholder="Search" aria-label="Search songs"></div>' +
                '<div class="row g-2 small fw-semibold border-bottom pb-1 mx-0 d-none d-md-flex"><div class="col-md-4">File</div>' +
                '<div class="col-md-4">Title</div><div class="col-md-4">Artist</div></div>' +
                '<div id="alInfoRows" class="al-scroll mb-2"></div>';
            wireInfo();
        }
        Array.prototype.forEach.call(el.querySelectorAll('[data-info-filter]'), function (b) {
            var on = b.getAttribute('data-info-filter') === info.filter;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        var q = info.search.toLowerCase();
        var list = info.files.filter(function (f) {
            var t = infoNow(f);
            if (info.filter === 'look' && !(f.editable && (infoReplaced(f) || infoProblems(t).length))) { return false; }
            if (info.filter === 'changed' && !info.edits[f.name]) { return false; }
            return !q || (f.name + ' ' + t.title + ' ' + t.artist).toLowerCase().indexOf(q) >= 0;
        });
        var tb = $id('alInfoRows');
        if (!info.loaded) {
            tb.innerHTML = '<div class="text-body-secondary py-2">Loading&hellip;</div>';
        } else if (!list.length) {
            tb.innerHTML = '<div class="text-body-secondary py-3 text-center">' +
                (info.files.length ? 'No songs match.' : 'No songs in the music folder.') + '</div>';
        } else {
            tb.innerHTML = list.map(function (f) {
                var t = infoNow(f);
                var note = !f.mp3 ? 'Only MP3s can be changed here'
                    : f.notMp3 ? 'Not really an MP3 (another format named .mp3), so it\'s left alone'
                    : !f.editable ? 'Its info is stored in an old format: change it on your computer'
                    : infoProblems(t).join(' · ');
                var replaced = infoReplaced(f) ? '<div class="text-warning-emphasis">An upload replaced the info you saved: ' +
                    '<b>' + esc(f.saved.title || '(no title)') + '</b>' + (f.saved.artist ? ' by <b>' + esc(f.saved.artist) + '</b>' : '') +
                    ' <button type="button" class="btn btn-link btn-sm p-0 align-baseline al-putback" data-n="' + esc(f.name) + '">Put back</button>' +
                    ' · <button type="button" class="btn btn-link btn-sm p-0 align-baseline al-keep" data-n="' + esc(f.name) + '" title="The uploaded info is right: stop flagging this song">Keep upload\'s</button></div>' : '';
                var input = function (k, label) {
                    return '<input type="text" class="form-control form-control-sm al-tag" data-k="' + k + '" data-n="' + esc(f.name) + '"' +
                        ' value="' + esc(t[k]) + '" placeholder="' + label + '" aria-label="' + label + ' of ' + esc(f.name) + '"' + (f.editable ? '' : ' disabled') + '>';
                };
                return '<div class="row g-2 mx-0 py-2 border-bottom align-items-center al-info-row' + (info.edits[f.name] ? ' al-changed' : '') + '">' +
                    '<div class="col-12 col-md-4 text-break small">' + playButtonHtml(f.name) + esc(f.name) +
                    (note ? '<div class="text-' + (f.editable ? 'warning-emphasis' : 'body-secondary') + '">' + esc(note) + '</div>' : '') + replaced + '</div>' +
                    '<div class="col-6 col-md-4">' + input('title', 'Title') + '</div>' +
                    '<div class="col-6 col-md-4 d-flex gap-1">' + input('artist', 'Artist') +
                    (f.editable ? '<button type="button" class="btn btn-sm btn-outline-secondary al-swap" data-n="' + esc(f.name) + '" title="Swap Title and Artist" aria-label="Swap Title and Artist of ' + esc(f.name) + '">&#8644;</button>' : '') +
                    '</div></div>';
            }).join('');
        }
        renderInfoButtons();
    }

    function renderInfoButtons() {
        if (!$id('alInfoSave')) { return; }
        var n = infoChanges();
        $id('alInfoSave').textContent = n ? 'Save ' + n + ' change' + (n === 1 ? '' : 's') : 'Save';
        $id('alInfoSave').disabled = !n || busy();
        $id('alInfoUndo').classList.toggle('d-none', !n);
        $id('alInfoFill').disabled = busy();
        $id('alInfoClean').disabled = busy();
        var back = info.files.filter(infoReplaced).length;
        $id('alInfoPutBack').classList.toggle('d-none', !back);
        $id('alInfoPutBack').textContent = 'Put back your info (' + back + ')';
        $id('alInfoPutBack').disabled = busy();
    }

    function wireInfo() {
        var byName = function (n) { return info.files.filter(function (f) { return f.name === n; })[0]; };
        $id('alInfoRows').addEventListener('input', function (e) {
            if (!e.target.classList.contains('al-tag')) { return; }
            var f = byName(e.target.getAttribute('data-n'));
            if (!f) { return; }
            var t = infoNow(f);
            var v = { title: t.title, artist: t.artist };
            v[e.target.getAttribute('data-k')] = e.target.value.trim();
            setInfoEdit(f, v.title, v.artist);
            e.target.closest('.al-info-row').classList.toggle('al-changed', !!info.edits[f.name]);
            renderInfoButtons();
        });
        $id('alInfoRows').addEventListener('click', function (e) {
            var b = e.target.closest('.al-swap, .al-putback, .al-keep');
            var f = b && byName(b.getAttribute('data-n'));
            if (!f) { return; }
            if (b.classList.contains('al-swap')) {
                var t = infoNow(f);
                setInfoEdit(f, t.artist, t.title);
                renderInfo();
            } else if (b.classList.contains('al-putback')) {
                setInfoEdit(f, f.saved.title, f.saved.artist);
                renderInfo();
            } else {
                // The uploaded info is the one wanted: stop comparing it.
                api('POST', 'tagsforget', { files: [f.name] }).then(function () {
                    delete info.edits[f.name];
                    return loadTags();
                }).catch(function (ex) { toast(ex.message, false); });
            }
        });
        $id('alInfoPutBack').addEventListener('click', function () {
            var n = 0;
            info.files.forEach(function (f) {
                if (infoReplaced(f)) { setInfoEdit(f, f.saved.title, f.saved.artist); n++; }
            });
            info.filter = 'changed';
            renderInfo();
            toast('Put back the info for ' + n + ' song' + (n === 1 ? '' : 's') + '. Look them over, then Save.');
        });
        // Re-check a row's notes once the edit is done, not on every key.
        $id('alInfoRows').addEventListener('change', function (e) { if (e.target.classList.contains('al-tag')) { renderInfo(); renderInfoBadge(); } });
        var bulk = function (fn, what) {
            var n = 0;
            info.files.forEach(function (f) {
                if (!f.editable) { return; }
                var t = infoNow(f);
                var v = fn(t, f);
                if (v.title !== t.title || v.artist !== t.artist) { setInfoEdit(f, v.title, v.artist); n++; }
            });
            if (n) { info.filter = 'changed'; }
            renderInfo();
            toast(n ? what + ' ' + n + ' song' + (n === 1 ? '' : 's') + '. Look them over, then Save.' : 'Nothing to change.');
        };
        $id('alInfoFill').addEventListener('click', function () {
            bulk(function (t, f) {
                var g = tagsFromName(f.name);
                var title = t.title, artist = t.artist;
                // "Artist - Title" typed into the title: split it.
                if (!artist && title.indexOf(' - ') > 0) {
                    var i = title.indexOf(' - ');
                    artist = cleanTag(title.slice(0, i));
                    title = cleanTag(title.slice(i + 3));
                }
                if (!title || /^(?:track\s*)?\d{1,3}$/i.test(title)) { title = g.title; }
                if (!artist) { artist = g.artist; }
                return { title: title, artist: artist };
            }, 'Filled in');
        });
        $id('alInfoClean').addEventListener('click', function () {
            bulk(function (t) { return { title: cleanTag(t.title) || t.title, artist: cleanTag(t.artist) || t.artist }; }, 'Cleaned up');
        });
        $id('alInfoScan').addEventListener('click', function () {
            var b = this, before = info.files.length;
            b.disabled = true;
            b.textContent = 'Scanning\u2026';
            loadTags().then(function (ok) {
                if (!ok) { return; }
                var n = info.files.length, added = n - before;
                toast('Found ' + n + ' song' + (n === 1 ? '' : 's') + (added > 0 ? ' (' + added + ' new)' : '') + '.');
            }).then(function () {
                b.disabled = false;
                b.textContent = 'Scan for songs';
            });
        });
        $id('alInfoUndo').addEventListener('click', function () { info.edits = {}; renderInfo(); });
        $id('alInfoSave').addEventListener('click', function () {
            if (!infoChanges()) { return; }
            start('tags', { edits: info.edits });
        });
        $id('alInfoFilters').addEventListener('click', function (e) {
            var b = e.target.closest('[data-info-filter]');
            if (b) { info.filter = b.getAttribute('data-info-filter'); renderInfo(); }
        });
        $id('alInfoSearch').addEventListener('input', function () { info.search = this.value; renderInfo(); });
    }

    /* ---------------- Player ----------------
       A play button on each row. Songs play here in the browser, streamed
       from FPP's own file API, with the song's Normalize setting applied
       (Leveled) or not (Original); or, when "Play through the show" is on and
       no show is playing, out FPP's own audio via the preview endpoint
       (fppd's Play Media, which applies Normalize itself). */

    var VIDEO_PREFIX = 'videos/';
    var PREVIEW_PLAYLIST = 'AudioLeveler-Preview';   // api.php's temporary preview playlist
    var player = {
        name: null,        // what's playing
        list: [],          // the list it was started from, for Next
        mode: 'browser',   // or 'show'
        leveled: true,
        audio: null, ctx: null, src: null, gain: null,
        started: 0, dur: 0, // through the show: when it started, how long it is
        tick: null, poll: null,
        canShow: false
    };

    function playFile(name) {
        return allFiles.filter(function (f) { return f.name === name; })[0] ||
            info.files.filter(function (f) { return f.name === name; })[0] || { name: name };
    }

    // The volume FPP's Normalize applies to this song, or null when there's none to hear.
    function playGainDb(f) {
        return pgSupported && (!f.video || pgVideos) && typeof f.pbGain === 'number' ? f.pbGain : null;
    }

    function playUrl(name) {
        var video = name.indexOf(VIDEO_PREFIX) === 0;
        var base = video ? name.slice(VIDEO_PREFIX.length) : name;
        return '/api/file/' + (video ? 'Videos' : 'Music') + '/' + encodeURIComponent(base) + '?play=1';
    }

    function clock(s) {
        if (!isFinite(s) || s < 0) { return '0:00'; }
        s = Math.floor(s);
        return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    function playButtonHtml(name) {
        var on = player.name === name;
        // FPP's own player controls: a green play, a red stop.
        return '<button type="button" class="buttons btn btn-sm al-play me-1 ' + (on ? 'btn-outline-danger' : 'btn-outline-success') + '"' +
            ' data-n="' + esc(name) + '" aria-label="' + (on ? 'Stop ' : 'Play ') + esc(name) + '" title="' + (on ? 'Stop' : 'Listen') + '">' +
            '<i class="fas fa-fw ' + (on ? 'fa-stop' : 'fa-play') + '"></i></button>';
    }

    function refreshPlayButtons() {
        Array.prototype.forEach.call(document.querySelectorAll('#audioLeveler .al-play'), function (b) {
            var on = player.name === b.getAttribute('data-n');
            b.innerHTML = '<i class="fas fa-fw ' + (on ? 'fa-stop' : 'fa-play') + '"></i>';
            b.title = on ? 'Stop' : 'Listen';
            b.setAttribute('aria-label', (on ? 'Stop ' : 'Play ') + b.getAttribute('data-n'));
            b.classList.toggle('btn-outline-success', !on);
            b.classList.toggle('btn-outline-danger', on);
        });
    }

    function renderPlayer() {
        var bar = $id('alPlayer');
        bar.classList.toggle('d-none', !player.name);
        refreshPlayButtons();
        if (!player.name) { return; }
        var f = playFile(player.name);
        $id('alPlayName').textContent = displayName(f);
        var show = player.mode === 'show';
        var g = playGainDb(f);
        // Leveled / Original only means something for a song FPP's Normalize
        // turns up or down, and only here in the browser: through the show
        // FPP always applies it.
        $id('alPlayMode').classList.toggle('d-none', g === null);
        Array.prototype.forEach.call($id('alPlayMode').querySelectorAll('button'), function (b) {
            var on = (b.getAttribute('data-mode') === 'leveled') === player.leveled;
            b.classList.toggle('active', show ? b.getAttribute('data-mode') === 'leveled' : on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.disabled = show;
            b.title = show ? 'Through the show it always plays leveled' : (b.getAttribute('data-mode') === 'leveled'
                ? 'With its Normalize setting (' + (g > 0 ? '+' : '') + (g === null ? 0 : g.toFixed(1)) + ' dB), as the show plays it'
                : 'The file as uploaded');
        });
        var box = $id('alPlayShow');
        box.checked = show;
        box.disabled = !show && !player.canShow;
        box.parentNode.title = box.disabled ? 'A show is playing (or FPPD is stopped), so it plays here in your browser.' : '';
        $id('alPlaySeek').disabled = show;
    }

    function updateTime() {
        var pos = 0, dur = 0;
        if (player.mode === 'show') {
            pos = (Date.now() - player.started) / 1000;
            dur = player.dur;
        } else if (player.audio) {
            pos = player.audio.currentTime;
            dur = player.audio.duration;
        }
        $id('alPlayTime').textContent = clock(pos) + (isFinite(dur) && dur > 0 ? ' / ' + clock(dur) : '');
        if (isFinite(dur) && dur > 0 && document.activeElement !== $id('alPlaySeek')) {
            $id('alPlaySeek').value = Math.min(1000, Math.round(1000 * pos / dur));
        }
        if (player.mode === 'show' && dur > 0 && pos > dur + 1) { stopPlayer(); }
    }

    function applyGain() {
        if (!player.gain) { return; }
        var g = playGainDb(playFile(player.name));
        player.gain.gain.value = player.leveled && g !== null ? Math.pow(10, g / 20) : 1;
    }

    function stopSound(tellFpp) {
        if (player.audio) {
            player.audio.pause();
            player.audio.removeAttribute('src');
            player.audio.load();
            player.audio = null;
        }
        [player.src, player.gain, player.split, player.out].concat(player.eqNodes || [], player.analysers || []).forEach(function (n) {
            if (n) { try { n.disconnect(); } catch (e) { /* gone */ } }
        });
        player.src = player.gain = player.split = player.out = null;
        player.eqNodes = player.analysers = null;
        resetMeter();
        if (player.mode === 'show' && player.name && tellFpp !== false) {
            // The next play waits for this, so a late stop never removes the new preview.
            player.stopping = api('POST', 'preview', { file: player.name, action: 'stop' }).catch(function () { /* stopped anyway */ });
        }
        clearInterval(player.tick);
        player.tick = null;
    }

    function stopPlayer() {
        stopSound(true);
        clearInterval(player.poll);
        player.poll = null;
        player.name = null;
        renderPlayer();
    }

    // The browser's copy of what FPP plays: the song, its Normalize setting,
    // FPP's five EQ bands, then the meter, and the speakers unless silent (a
    // silent copy drives the meter while the song plays through the show).
    function buildChain(a, silent) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) { return; }
        if (!player.ctx) { player.ctx = new C(); }
        if (player.ctx.state === 'suspended') { player.ctx.resume(); }
        var ctx = player.ctx;
        player.src = ctx.createMediaElementSource(a);
        player.gain = ctx.createGain();
        player.src.connect(player.gain);
        var last = player.gain;
        player.eqNodes = EQ_BANDS.map(function (b) {
            var f = ctx.createBiquadFilter();
            f.type = b[0];
            f.frequency.value = b[1];
            f.Q.value = b[2];
            last.connect(f);
            last = f;
            return f;
        });
        var split = ctx.createChannelSplitter(2);
        last.connect(split);
        player.analysers = [0, 1].map(function (ch) {
            var an = ctx.createAnalyser();
            an.fftSize = 2048;
            split.connect(an, ch);
            return an;
        });
        player.out = ctx.createGain();
        player.out.gain.value = silent ? 0 : 1;   // silent still has to reach the output to be processed
        last.connect(player.out);
        player.out.connect(ctx.destination);
        player.split = split;
        applyGain();
        applyEqToPlayer();
        startMeter();
    }

    // The EQ heard in the browser: the Audio EQ tab's sliders (or flat for
    // Before), and otherwise the EQ FPP plays with when it's on.
    function applyEqToPlayer() {
        if (!player.eqNodes) { return; }
        var g = (eq.on || (tab === 'eq' && eq.mode === 'try')) ? eqPlaybackGains() : [0, 0, 0, 0, 0];
        player.eqNodes.forEach(function (f, i) { f.gain.value = g[i]; });
    }

    function playInBrowser(name) {
        var a = new Audio(playUrl(name));
        a.preload = 'auto';
        player.audio = a;
        buildChain(a, false);
        a.addEventListener('timeupdate', updateTime);
        a.addEventListener('loadedmetadata', updateTime);
        a.addEventListener('ended', function () { if (player.audio === a) { stopPlayer(); } });
        a.addEventListener('error', function () {
            if (player.audio === a) { toast('This file couldn\'t be played in the browser.', false); stopPlayer(); }
        });
        a.play().catch(function (e) {
            if (player.audio === a && e && e.name !== 'AbortError') { toast('Couldn\'t start playing: ' + e.message, false); stopPlayer(); }
        });
    }

    function playThroughShow(name) {
        var f = playFile(name);
        var before = player.stopping || Promise.resolve();
        player.stopping = null;
        return before.then(function () {
            if (player.name !== name || player.mode !== 'show') { return null; }
            return api('POST', 'preview', { file: name, action: 'play', dur: f.dur || 0 });
        }).then(function (j) {
            if (!j) { return; }
            if (player.name !== name || player.mode !== 'show') {
                // Stopped or moved on while FPP was starting it: stop it there too.
                player.stopping = api('POST', 'preview', { file: name, action: 'stop' }).catch(function () { /* stopped anyway */ });
                return;
            }
            player.started = Date.now();
            player.dur = f.dur || 0;
            // A silent copy in step with FPP, for the meter.
            var shadow = new Audio(playUrl(name));
            player.audio = shadow;
            buildChain(shadow, true);
            shadow.play().catch(function () { /* the meter just stays still */ });
            if (!player.dur) {
                // Not measured yet: read its length from the file's header.
                var probe = new Audio();
                probe.preload = 'metadata';
                probe.addEventListener('loadedmetadata', function () {
                    if (player.name === name && isFinite(probe.duration)) { player.dur = probe.duration; }
                    probe.removeAttribute('src');
                    probe.load();
                });
                probe.src = playUrl(name);
            }
            player.tick = setInterval(updateTime, 500);
            updateTime();
        });
    }

    // While the bar is up: can it play through the show, and has a show started?
    function pollShow() {
        fetch('/api/fppd/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) {
            // Our own preview playlist is not a show.
            var ours = st && st.current_playlist && st.current_playlist.playlist === PREVIEW_PLAYLIST;
            var idle = st && (st.status_name === 'idle' || ours);
            if (player.mode === 'show' && player.name && !idle) {
                toast('A show started, so the preview stopped.');
                stopSound(false);
                player.mode = 'browser';
                player.name = null;
            }
            player.canShow = idle;
            renderPlayer();
        }).catch(function () { player.canShow = false; renderPlayer(); });
    }

    function play(name, list) {
        stopSound(true);
        player.name = name;
        if (list) { player.list = list; }
        if (player.mode === 'show' && !player.canShow) { player.mode = 'browser'; }
        $id('alPlaySeek').value = 0;
        $id('alPlayTime').textContent = '0:00';
        renderPlayer();
        if (!player.poll) { player.poll = setInterval(pollShow, 3000); pollShow(); }
        if (player.mode === 'show') {
            playThroughShow(name).catch(function (e) {
                // Refused (a show started, FPPD stopped): play it here instead.
                toast(e.message, false);
                player.mode = 'browser';
                if (player.name === name) { playInBrowser(name); renderPlayer(); }
            });
        } else {
            playInBrowser(name);
        }
    }

    function wirePlayer() {
        // Play buttons are drawn with the rows, on every tab.
        $id('audioLeveler').addEventListener('click', function (e) {
            var b = e.target.closest('.al-play');
            if (!b) { return; }
            var name = b.getAttribute('data-n');
            if (player.name === name) { stopPlayer(); return; }
            var list = tab === 'info'
                ? Array.prototype.map.call(document.querySelectorAll('#alInfoRows .al-play'), function (x) { return x.getAttribute('data-n'); })
                : shown.map(function (f) { return f.name; });
            play(name, list);
        });
        $id('alPlayStop').addEventListener('click', stopPlayer);
        $id('alPlayNext').addEventListener('click', function () {
            var i = player.list.indexOf(player.name);
            var next = i >= 0 ? player.list[i + 1] : null;
            if (next) { play(next); } else { toast('That was the last one in the list.'); stopPlayer(); }
        });
        $id('alPlaySeek').addEventListener('input', function () {
            var a = player.audio;
            if (a && isFinite(a.duration)) { a.currentTime = a.duration * this.value / 1000; }
        });
        $id('alPlayMode').addEventListener('click', function (e) {
            var b = e.target.closest('[data-mode]');
            if (!b || player.mode === 'show') { return; }
            player.leveled = b.getAttribute('data-mode') === 'leveled';
            applyGain();
            renderPlayer();
        });
        $id('alPlayShow').addEventListener('change', function () {
            if (!player.name) { return; }
            player.mode = this.checked ? 'show' : 'browser';
            play(player.name);   // starts again from the top, the other way
        });
        // Leaving the page doesn't leave a song playing through the show.
        window.addEventListener('pagehide', function () {
            if (tab === 'eq') { eqFlush(true); }
            if (player.mode === 'show' && player.name && navigator.sendBeacon) {
                navigator.sendBeacon(API + 'preview', JSON.stringify({ file: player.name, action: 'stop' }));
            }
        });
    }

    /* ---------------- Audio EQ tab ----------------
       A front end for FPP's own equalizer: FPP's five EQ bands on the show's
       sound card (Audio Output Groups, FPP 10 with PipeWire). A three-way switch:
       Off (FPP untouched, the tab greyed out), Preview (in the browser only)
       and Live (FPP's audio switched to Advanced with this EQ; out of
       it, FPP is put back as it was). When live, sliders change the running
       EQ at once (FPP's live update) and are kept with Save; leaving the tab
       puts the saved EQ back, stops the test song and turns Preview off. The
       meter reads the song the player is playing, with its Normalize setting
       and this EQ applied. */

    var EQ_FREQS = ['60 Hz', '250 Hz', '1 kHz', '4 kHz', '12 kHz'];
    // [type, frequency, Q] of FPP's five default bands, for the browser's copy of the EQ.
    var EQ_BANDS = [['lowshelf', 60, 0.7], ['peaking', 250, 1.0], ['peaking', 1000, 1.0], ['peaking', 4000, 1.0], ['highshelf', 12000, 0.7]];
    var EQ_PRESETS = [
        ['fmclear', 'FM Clear', [-4, -1.5, -1, 0, -4]],
        ['bass', 'Bass Boost', [0, -1, -4, -4, -4]],
        ['loud', 'Loudness', [0, -3, -5, -3, -1]],
        ['vocal', 'Vocal', [-6, -4, 0, 0, -3]],
        ['rock', 'Rock', [0, -3, -5, -2, 0]],
        ['pop', 'Pop', [-3, -1, 0, -1, -3]],
        ['oldradio', 'Old Radio', [-12, -6, 0, -8, -12]],
        ['flat', 'Flat', [0, 0, 0, 0, 0]]
    ];
    var EQ_WARNINGS =
        '<b>Before you use the EQ</b><ul class="mb-0 ps-3 text-start">' +
        '<li><b>Preview</b> is in your browser only: nothing on FPP or the transmitter changes. Leaving this tab turns it off.</li>' +
        '<li><b>Live switches FPP\'s audio to Advanced (Full PipeWire)</b> with your show\'s sound card, and needs a reboot. ' +
        '<b>Going back to Preview or Off puts FPP\'s audio settings back exactly as they were</b> (another reboot); your EQ is remembered for next time.</li>' +
        '<li><b>Switching Live on or off restarts FPP\'s audio</b>, which stops anything playing. It won\'t while a show is running.</li>' +
        '<li><b>In Live, a change is saved into FPP by itself</b>, the same as FPP\'s own Save &amp; Apply, which restarts FPP\'s audio for a few seconds. ' +
        'So while anything plays you hear the change straight away, and it goes into FPP\'s settings when the playing stops.</li>' +
        '<li><b>Raising a slider makes the signal hotter.</b> Too hot overdrives an FM transmitter: distortion, and RDS can drop out. ' +
        'The presets only cut; if you push sliders up, watch the meter.</li>' +
        '<li>Some presets make the show a little quieter overall: turn FPP\'s volume up a touch if needed.</li>' +
        '<li><b>It changes everything FPP plays through this sound card</b>, every song and video, not one song.</li>' +
        '<li><b>Presets never change.</b> Moving a slider makes your own <b>Custom</b> setting; <b>+ Save as preset</b> keeps it under a name.</li>' +
        '<li>These are FPP\'s own EQ settings (Audio Output Groups), so changes show there too.</li></ul>';

    var eq = {
        loaded: false, supported: false, on: false, mode: 'off', pendingMode: null, presets: [], delAsk: -1,
        gains: [0, 0, 0, 0, 0], saved: [0, 0, 0, 0, 0], preset: 'flat',
        rebootPending: false, cardName: '', kfmt: false, after: true, confirming: false, busy: false,
        showRunning: false, liveTimer: null, liveSent: '', tx: null, txTimer: null, statusTimer: null
    };

    function eqDirty() { return eq.gains.join() !== eq.saved.join(); }
    function eqPlaybackGains() { return eq.after ? eq.gains : [0, 0, 0, 0, 0]; }

    function loadEq() {
        return api('GET', 'eq').then(function (j) {
            eq.loaded = true;
            eq.supported = !!j.supported;
            eq.on = !!j.on;
            eq.rebootPending = !!j.rebootPending;
            eq.cardName = j.cardName || j.cardId || '';
            eq.cardId = j.cardId || '';
            eq.groupId = j.groupId || 0;
            eq.kfmt = !!j.kfmt;
            eq.showRunning = j.idle === false;
            if (!eqDirty()) { eq.gains = (j.gains || [0, 0, 0, 0, 0]).slice(); }
            eq.saved = (j.gains || [0, 0, 0, 0, 0]).slice();
            eq.preset = j.preset || 'flat';
            eq.presets = j.presets || [];
            eq.custom = j.custom || null;
            // What FPP itself has saved (none: from before the plugin kept track; taken as in step).
            eq.fppGains = j.fppGains || (eq.on ? (j.gains || [0, 0, 0, 0, 0]).slice() : null);
            // Live is FPP's own setting; Preview lives only on this page.
            if (eq.on) { eq.mode = 'show'; } else if (eq.mode === 'show') { eq.mode = 'off'; }
            applyEqToPlayer();
            renderEq();
            fppMeterSync();
        }).catch(function (e) { toast(e.message, false); });
    }

    function renderEq() {
        var el = $id('alEqPanel');
        if (tab !== 'eq') { return; }
        if (!el.firstChild) {
            el.innerHTML =
                '<div id="alEqStatus" class="d-flex flex-wrap align-items-center gap-2 rounded border bg-body-tertiary px-3 py-2 mb-3"></div>' +
                '<div id="alEqConfirm" class="alert alert-warning small d-none"></div>' +
                '<fieldset id="alEqBody" class="al-eq-body">' +
                '<div id="alEqOffNote" class="small text-body-secondary mb-2 d-none">Pick <b>Preview</b> to adjust the EQ and hear it here in your browser.</div>' +
                '<div class="small fw-semibold text-body-secondary text-uppercase mb-1">Presets</div>' +
                '<div id="alEqPresets" class="d-flex flex-wrap gap-2 mb-3">' + EQ_PRESETS.map(function (p) {
                    return '<button type="button" class="buttons btn btn-sm btn-outline-secondary" data-preset="' + p[0] + '">' + p[1] + '</button>';
                }).join('') + '<button type="button" class="buttons btn btn-sm btn-outline-secondary" data-preset="custom" ' +
                'title="Your own slider settings. Move any slider to change it; the presets stay as they are.">Custom</button></div>' +
                '<div class="small fw-semibold text-body-secondary text-uppercase mb-1">My presets</div>' +
                '<div class="d-flex flex-wrap align-items-center gap-2 mb-3">' +
                '<span id="alEqMine" class="d-flex flex-wrap gap-2"></span>' +
                '<button id="alEqMineAdd" type="button" class="btn btn-sm btn-outline-primary">+ Save as preset</button>' +
                '<span id="alEqMineForm" class="d-none align-items-center gap-2">' +
                '<input id="alEqMineName" type="text" class="form-control form-control-sm" maxlength="30" style="width:14rem" ' +
                'placeholder="Name, e.g. Old Radio (mine)" aria-label="Preset name">' +
                '<button id="alEqMineSave" type="button" class="buttons btn btn-sm btn-success">Save preset</button>' +
                '<button id="alEqMineCancel" type="button" class="btn btn-sm btn-link">Cancel</button></span>' +
                '<span id="alEqMineFull" class="small text-body-secondary d-none">8 saved: delete one to add another.</span>' +
                '</div>' +
                '<div class="row g-3">' +
                '<div class="col-12 col-lg-7"><div class="al-hifi p-3 h-100">' +
                '<div class="d-flex justify-content-center mb-3"><span class="al-onair-frame"><span id="alOnAir" class="al-onair" role="status" aria-live="polite">On Air</span></span></div>' +
                '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><span class="small fw-semibold text-body-secondary text-uppercase me-auto">Equalizer (dB)</span>' +
                '<span id="alEqAB" class="btn-group btn-group-sm" role="group" aria-label="Hear the EQ">' +
                '<button type="button" class="btn btn-outline-secondary" data-ab="before" title="Hear it with the EQ flat">Before</button>' +
                '<button type="button" class="btn btn-outline-secondary" data-ab="after" title="Hear it with this EQ">After</button></span></div>' +
                '<div id="alEqSliders" class="d-flex justify-content-around al-eq-sliders">' + EQ_FREQS.map(function (f, i) {
                    return '<div class="d-flex flex-column align-items-center gap-1"><span class="small font-monospace al-eq-db" id="alEqDb' + i + '"></span>' +
                        '<input type="range" class="form-range al-eq-slider" min="-12" max="12" step="0.5" data-band="' + i + '" aria-label="' + f + ' gain in dB">' +
                        '<span class="small text-body-secondary">' + f + '</span></div>';
                }).join('') + '</div>' +
                                '</div></div>' +
                '<div class="col-12 col-lg-5"><div class="al-hifi p-3 h-100">' +
                '<div class="d-flex align-items-center gap-2 mb-2"><span class="small fw-semibold text-body-secondary text-uppercase">Level</span>' +
                '<span id="alEqMeterSrc" class="small text-body-secondary me-auto"></span>' +
                '<span id="alEqMeterHelp"></span></div>' +
                '<canvas id="alVu" class="al-vu" width="360" height="170" aria-label="VU meter"></canvas>' +
                '<div class="d-flex align-items-center gap-3 mt-2 small">' +
                '<span class="d-flex align-items-center gap-1"><span id="alPeakLamp" class="al-lamp"></span> Peak</span>' +
                '<span id="alTxWrap" class="d-flex align-items-center gap-1 d-none"><span id="alTxLamp" class="al-lamp al-lamp-off"></span> TX (K-FMT)' +
                '<span id="alTxHelp"></span></span>' +
                '<button id="alTxClear" type="button" class="btn btn-sm btn-outline-secondary ms-auto d-none">Clear TX</button></div>' +
                '<div class="mt-2"><canvas id="alLeds" class="al-leds" width="360" height="34" aria-hidden="true"></canvas></div>' +
                '</div></div></div>' +
                '<div class="d-flex flex-wrap align-items-center gap-2 mt-3">' +
                '<span class="small text-body-secondary">Test song</span>' +
                '<select id="alEqSong" class="form-select form-select-sm w-auto" aria-label="Song to test the EQ with"></select>' +
                '<button id="alEqPlay" type="button" class="buttons btn btn-sm btn-outline-success"><i class="fas fa-fw fa-play"></i> Play</button>' +
                '<span class="small text-body-secondary">The player below has Stop, Next and <b>Play through the show</b>, to hear it on your speakers and FM.</span>' +
                '</div></fieldset>';
            wireEq();
        }
        // Status strip: the three-way switch and where things stand
        var st = $id('alEqStatus');
        if (!eq.loaded) {
            st.innerHTML = '<span class="text-body-secondary">Loading&hellip;</span>';
        } else {
            var lock = eq.busy || eq.showRunning;   // switching Live on or off restarts FPP's audio
            var seg = function (m, label, title, disabled) {
                return '<button type="button" class="btn btn-outline-secondary' + (eq.mode === m ? ' active' : '') + '" data-eqmode="' + m + '"' +
                    ' aria-pressed="' + (eq.mode === m ? 'true' : 'false') + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
            };
            var msg;
            if (eq.mode === 'show') {
                msg = eq.rebootPending ? '<b>Live: reboot FPP to finish</b> &middot; use the Reboot button at the top of FPP'
                    : '<b>Live</b>' + (eq.cardName ? ' &middot; shaping <b>' + esc(eq.cardName) + '</b>, on your speakers and FM' : ' &middot; on your speakers and FM');
            } else if (eq.mode === 'try') {
                msg = '<b>Preview</b> &middot; in your browser only, not on your speakers or FM' +
                    (eq.rebootPending ? ' &middot; <b>reboot FPP to finish putting FPP back</b>' : '');
            } else {
                msg = '<b>Off</b> &middot; FPP\'s audio is as you set it' +
                    (eq.rebootPending ? ' &middot; <b>reboot FPP to finish putting it back</b>' : '');
            }
            if (!eq.supported) { msg += ' &middot; this FPP has no PipeWire audio groups, so Live isn\'t available'; }
            if (eq.showRunning) { msg += ' &middot; a show is playing, so Live can\'t be switched now'; }
            st.innerHTML =
                '<span class="small fw-semibold text-body-secondary text-uppercase">EQ</span>' +
                '<span class="btn-group btn-group-sm al-eq-mode" role="group" aria-label="Audio EQ">' +
                // Always clickable (except mid-change): a click that can't go
                // ahead says why in the box below instead of doing nothing.
                seg('off', 'Off', 'FPP untouched', eq.busy) +
                seg('try', 'Preview', 'In your browser only', eq.busy) +
                seg('show', 'Live', 'On your speakers and FM (reboot)', eq.busy) +
                '</span>' + helpIconHtml(EQ_WARNINGS) +
                '<span class="small text-body-secondary al-eq-msg">' + msg + '</span>';
            initTips(st);
        }
        var body = $id('alEqBody');
        body.disabled = eq.mode === 'off';
        body.classList.toggle('al-eq-disabled', eq.mode === 'off');
        $id('alEqOffNote').classList.toggle('d-none', eq.mode !== 'off');
        eqOnAir();
        // My presets
        $id('alEqMine').innerHTML = eq.presets.map(function (p, i) {
            var on = p.gains.join() === eq.gains.join();
            return '<span class="btn-group btn-group-sm" role="group">' +
                '<button type="button" class="buttons btn ' + (on ? 'btn-success' : 'btn-outline-secondary') + '" data-mine="' + i + '" aria-pressed="' + on + '">' + esc(p.name) + '</button>' +
                '<button type="button" class="btn ' + (eq.delAsk === i ? 'btn-danger' : 'btn-outline-secondary') + '" data-mine-del="' + i + '"' +
                ' aria-label="Delete ' + esc(p.name) + '" title="Delete">' + (eq.delAsk === i ? 'Delete?' : '&times;') + '</button></span>';
        }).join('');
        $id('alEqMine').classList.toggle('d-none', !eq.presets.length);
        var naming = !$id('alEqMineForm').classList.contains('d-none');
        $id('alEqMineAdd').classList.toggle('d-none', naming || eq.presets.length >= 8);
        $id('alEqMineFull').classList.toggle('d-none', naming || eq.presets.length < 8);
        // Presets, sliders, buttons
        var matching = EQ_PRESETS.filter(function (p) { return p[2].join() === eq.gains.join(); })[0];
        var mineOn = eq.presets.some(function (p) { return p.gains.join() === eq.gains.join(); });
        if (!matching && !mineOn) { matching = ['custom']; }
        el.querySelector('[data-preset="custom"]').disabled = !eq.custom && matching[0] !== 'custom';
        Array.prototype.forEach.call(el.querySelectorAll('[data-preset]'), function (b) {
            var on = matching && matching[0] === b.getAttribute('data-preset');
            b.classList.toggle('btn-success', !!on);
            b.classList.toggle('btn-outline-secondary', !on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(el.querySelectorAll('.al-eq-slider'), function (s) {
            var i = +s.getAttribute('data-band');
            if (document.activeElement !== s) { s.value = eq.gains[i]; }
            $id('alEqDb' + i).innerHTML = (eq.gains[i] > 0 ? '+' : '') + eq.gains[i].toFixed(1) + '<span class="al-unit"> dB</span>';
        });
        Array.prototype.forEach.call(el.querySelectorAll('[data-ab]'), function (b) {
            var on = (b.getAttribute('data-ab') === 'after') === eq.after;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        $id('alTxWrap').classList.toggle('d-none', !eq.kfmt);
        $id('alTxClear').classList.toggle('d-none', !eq.kfmt);
        // Test songs: the Songs list as it stands
        var sel = $id('alEqSong');
        var names = allFiles.filter(function (f) { return !f.video; }).map(function (f) { return f.name; });
        if (sel.options.length !== names.length) {
            var keep = sel.value;
            sel.innerHTML = names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
            if (keep && names.indexOf(keep) >= 0) { sel.value = keep; }
        }
        if (player.name && names.indexOf(player.name) >= 0 && document.activeElement !== sel) { sel.value = player.name; }
        drawVu(meter.vu, meter.peakUntil > Date.now());
    }

    function helpIconHtml(html) {
        return '<span data-bs-toggle="tooltip" data-bs-html="true" data-bs-placement="auto" data-bs-custom-class="al-eq-tip" data-bs-title="' +
            esc(html) + '"><img src="images/redesign/help-icon.svg" class="icon-help" alt="Help"></span>';
    }

    function initTips(root) {
        if (window.bootstrap && bootstrap.Tooltip) {
            Array.prototype.forEach.call(root.querySelectorAll('[data-bs-toggle="tooltip"]'), function (t) {
                bootstrap.Tooltip.getOrCreateInstance(t);
            });
        }
    }

    // Switching Live on or off asks first, with what it will do.
    function eqAskToggle(target) {
        var c = $id('alEqConfirm');
        var why = function (html) {
            c.innerHTML = html + ' <div class="mt-2"><button type="button" class="btn btn-sm btn-outline-secondary" data-eq-confirm="cancel">OK</button></div>';
            c.classList.remove('d-none');
        };
        if (!eq.on && !eq.supported) {
            why('<b>Live isn\'t available on this FPP.</b> It needs FPP\'s PipeWire audio (FPP 10, Media Backend set to Simple or Advanced ' +
                'under Settings &gt; Audio/Video). Preview still works here in your browser.');
            return;
        }
        if (eq.showRunning) {
            why('<b>Something is playing in FPP' + (eq.playingName ? ' (' + esc(eq.playingName) + ')' : '') + '.</b> ' +
                (eq.on ? 'Taking the EQ off live' : 'Going live') + ' restarts FPP\'s audio, so stop it first ' +
                '(Status/Control page &gt; Stop), then try again.');
            return;
        }
        eq.pendingMode = target;
        c.innerHTML = eq.on
            ? '<b>Take the EQ off live?</b> FPP\'s audio settings go back exactly as they were before, then FPP needs a reboot. ' +
              'Your EQ is remembered for next time' + (target === 'try' ? ', and you can keep previewing it here in your browser' : '') + '.' +
              ' <div class="mt-2"><button type="button" class="btn btn-sm btn-warning" data-eq-confirm="off">Put FPP back</button> ' +
              '<button type="button" class="btn btn-sm btn-link" data-eq-confirm="cancel">Cancel</button></div>'
            : '<b>Make the EQ live?</b> FPP\'s audio switches to Advanced (Full PipeWire) with the same sound card' +
              (eq.cardName ? ' (' + esc(eq.cardName) + ')' : '') + ' and this EQ on it, then FPP needs a reboot. ' +
              'Pick Preview or Off any time to put everything back. <div class="mt-2"><button type="button" class="btn btn-sm btn-warning" data-eq-confirm="on">Go live</button> ' +
              '<button type="button" class="btn btn-sm btn-link" data-eq-confirm="cancel">Cancel</button></div>';
        c.classList.remove('d-none');
    }

    function eqSaveMine(list, done) {
        return api('POST', 'eq/presets', { presets: list }).then(function (j) {
            eq.presets = j.presets || [];
            if (done) { toast(done); }
            renderEq();
        }).catch(function (ex) { toast(ex.message, false); });
    }

    function eqSendLive(force) {
        // FPP's own live update (as its EQ sliders do): no restart, so fine mid-show.
        if (!eq.on || eq.rebootPending) { return; }
        var gains = player.mode === 'show' ? eqPlaybackGains() : eq.gains;
        var key = gains.join();
        if (!force && key === eq.liveSent) { return; }
        clearTimeout(eq.liveTimer);
        // A few a second at most: each one is a small job for FPP.
        eq.liveTimer = setTimeout(function () {
            eq.liveSent = key;
            api('POST', 'eq/live', { gains: gains }).then(function (j) {
                if (j.status === 'NOT_RUNNING') { eq.rebootPending = true; renderEq(); }
            }).catch(function () { /* best effort, like FPP's own page */ });
        }, 250);
    }

    function eqSetGains(g) {
        eq.gains = g.map(function (x) { return Math.max(-12, Math.min(12, Math.round(x * 2) / 2)); });
        applyEqToPlayer();
        eqSendLive();
        eqQueueSave();
        renderEq();
    }

    /* Saving happens by itself, like the buttons on an old radio. Every pick
       or slider move is remembered by the plugin straight away (once the
       slider stops). In Live it also goes into FPP's own settings, which is
       FPP's Save & Apply and restarts FPP's audio for a few seconds: so only
       while nothing is playing. Until then you hear it live and the plugin
       has it; the page saves it into FPP when the playing stops. */
    // Nothing at all playing through FPP, our own previews included (saving
    // into FPP restarts its audio, which would cut them off).
    function eqFppQuiet(st) {
        return !!st && st.status_name === 'idle' && !(player.mode === 'show' && player.name);
    }

    function eqNeedsFpp() {
        return eq.on && !eq.rebootPending && !!eq.fppGains && eq.fppGains.join() !== eq.saved.join();
    }

    function eqQueueSave() {
        clearTimeout(eq.saveTimer);
        eq.saveTimer = null;
        if (eq.mode === 'off' || !eqDirty()) { return; }
        eq.saveTimer = setTimeout(function () { eq.saveTimer = null; eqAutoSave(); }, 900);
    }

    function eqSaveBody() {
        return { gains: eq.gains.slice(), preset: eq.preset, custom: eq.custom || undefined };
    }

    function eqAutoSave() {
        if (eq.saving || (!eqDirty() && !eqNeedsFpp())) { return; }
        var body = eqSaveBody();
        // Our own preview plays as FPP's "idle" for a video: the server can't
        // see it, so say so and it only remembers.
        if (player.mode === 'show' && player.name) { body.hold = true; }
        eq.saving = true;
        renderEq();
        api('POST', 'eq/save', body).then(function (j) {
            eq.saved = body.gains;
            if (j.fppGains) { eq.fppGains = j.fppGains.slice(); }
        }).catch(function (ex) { toast(ex.message, false); }).then(function () {
            eq.saving = false;
            renderEq();
            if (eqDirty() && !eq.saveTimer) { eqQueueSave(); }
        });
    }

    // The ON AIR sign, like a radio studio's: lit green while the EQ is live
    // in the show and kept; dark while it's being saved into FPP (its audio
    // restarts for a few seconds), and when it isn't on air at all. The
    // details are in its tooltip.
    function eqOnAir() {
        var el = $id('alOnAir');
        if (!el) { return; }
        var lit = false, tip;
        if (eq.mode !== 'show') {
            tip = eq.mode === 'try' ? 'Preview: in your browser only, not on air. Your pick is kept for when you go Live.' : 'The EQ is off.';
        } else if (eq.rebootPending) {
            tip = 'Not on air yet: reboot FPP to finish. Your pick is kept.';
        } else if (eq.saving && eq.fppQuiet) {
            tip = 'Saving into FPP: its audio restarts for a few seconds.';
        } else if (eqDirty() || eq.saveTimer || eq.saving) {
            lit = true;
            tip = 'On air. Saving your pick…';
        } else if (eqNeedsFpp()) {
            lit = true;
            tip = 'On air and kept. It goes into FPP\'s own settings by itself when the playing stops (that restarts FPP\'s audio for a few seconds).';
        } else {
            lit = true;
            tip = 'On air, and saved in FPP.';
        }
        el.classList.toggle('al-onair-lit', lit);
        el.title = tip;
        el.setAttribute('aria-label', tip);
    }

    function wireEq() {
        var el = $id('alEqPanel');
        el.addEventListener('click', function (e) {
            var m = e.target.closest('[data-eqmode]');
            if (m) {
                var to = m.getAttribute('data-eqmode');
                if (to === eq.mode) { return; }
                $id('alEqConfirm').classList.add('d-none');
                if (to === 'show' || eq.on) { eqAskToggle(to); return; }
                // Off and Preview are only this page.
                eq.mode = to;
                if (to === 'off') {
                    if (player.name) { stopPlayer(); }
                    eqFlush(false);   // a pick still waiting is kept
                }
                applyEqToPlayer();
                renderEq();
                return;
            }
            var mine = e.target.closest('[data-mine]');
            if (mine) {
                var mp = eq.presets[+mine.getAttribute('data-mine')];
                if (mp) { eq.preset = 'mine'; eqSetGains(mp.gains.slice()); }
                return;
            }
            var del = e.target.closest('[data-mine-del]');
            if (del) {
                var di = +del.getAttribute('data-mine-del');
                if (eq.delAsk !== di) {
                    eq.delAsk = di;
                    renderEq();
                    setTimeout(function () { if (eq.delAsk === di) { eq.delAsk = -1; renderEq(); } }, 3000);
                    return;
                }
                eq.delAsk = -1;
                var gone = eq.presets[di];
                eqSaveMine(eq.presets.filter(function (x, i) { return i !== di; }), gone ? 'Deleted ' + gone.name + '.' : null);
                return;
            }
            var p = e.target.closest('[data-preset]');
            if (p && p.getAttribute('data-preset') === 'custom') {
                if (eq.custom) { eq.preset = 'custom'; eqSetGains(eq.custom.slice()); }
                return;
            }
            if (p) {
                var pr = EQ_PRESETS.filter(function (x) { return x[0] === p.getAttribute('data-preset'); })[0];
                eq.preset = pr[0];
                eqSetGains(pr[2].slice());
                return;
            }
            var ab = e.target.closest('[data-ab]');
            if (ab) {
                eq.after = ab.getAttribute('data-ab') === 'after';
                applyEqToPlayer();
                eqSendLive(true);
                renderEq();
                return;
            }
            var c = e.target.closest('[data-eq-confirm]');
            if (c) {
                var what = c.getAttribute('data-eq-confirm');
                $id('alEqConfirm').classList.add('d-none');
                if (what === 'cancel') { return; }
                var target = eq.pendingMode;
                eq.busy = true;
                renderEq();
                api('POST', what === 'on' ? 'eq/on' : 'eq/off', what === 'on' ? { gains: eq.gains, preset: eq.preset } : {}).then(function (j) {
                    toast(what === 'on'
                        ? (j.reboot ? 'The EQ is set up to go live. Reboot FPP to finish (Reboot button at the top).' : 'The EQ is live.')
                        : (j.reboot ? 'FPP\'s audio settings are back as they were. Reboot FPP to finish.' : 'The EQ is no longer live.'));
                    if (what === 'off') { eq.mode = target === 'try' ? 'try' : 'off'; }
                }).catch(function (ex) { toast(ex.message, false); }).then(function () {
                    eq.busy = false;
                    return loadEq();
                });
            }
        });
        el.addEventListener('input', function (e) {
            if (!e.target.classList.contains('al-eq-slider')) { return; }
            var g = eq.gains.slice();
            g[+e.target.getAttribute('data-band')] = parseFloat(e.target.value);
            eq.preset = 'custom';
            eq.custom = g.map(function (x) { return Math.max(-12, Math.min(12, Math.round(x * 2) / 2)); });
            eqSetGains(g);
        });
        $id('alEqPlay').addEventListener('click', function () {
            var n = $id('alEqSong').value;
            if (!n) { return; }
            var list = Array.prototype.map.call($id('alEqSong').options, function (o) { return o.value; });
            if (player.name === n) { stopPlayer(); } else { play(n, list); }
        });
        var mineForm = function (open) {
            $id('alEqMineForm').classList.toggle('d-none', !open);
            $id('alEqMineForm').classList.toggle('d-flex', open);
            if (open) { $id('alEqMineName').value = ''; $id('alEqMineName').focus(); }
            renderEq();
        };
        $id('alEqMineAdd').addEventListener('click', function () { mineForm(true); });
        $id('alEqMineCancel').addEventListener('click', function () { mineForm(false); });
        var saveMine = function () {
            var name = $id('alEqMineName').value.trim();
            if (!name) { $id('alEqMineName').focus(); return; }
            var list = eq.presets.slice();
            var same = list.map(function (x) { return x.name.toLowerCase(); }).indexOf(name.toLowerCase());
            if (same >= 0) { list[same] = { name: list[same].name, gains: eq.gains.slice() }; }
            else if (list.length >= 8) { toast('You have 8 presets: delete one first.', false); return; }
            else { list.push({ name: name, gains: eq.gains.slice() }); }
            mineForm(false);
            eqSaveMine(list, (same >= 0 ? 'Updated ' : 'Saved ') + name + '.');
        };
        $id('alEqMineSave').addEventListener('click', saveMine);
        $id('alEqMineName').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); saveMine(); }
            if (e.key === 'Escape') { mineForm(false); }
        });
        $id('alTxClear').addEventListener('click', function () {
            fetch('/api/plugin-apis/kfmt/clearpeak', { method: 'POST' }).then(pollTx).catch(function () { /* not there */ });
        });
        $id('alEqMeterHelp').innerHTML = helpIconHtml('A test song playing here: the needle shows it with its Normalize setting and this EQ, before FPP\'s volume. ' +
            'When the EQ is <b>Live</b>: it shows what FPP is really sending to the sound card, after the EQ (FPP\'s own meter, as on its Audio Mixer), ' +
            'only while this tab is on screen. Around 0 is a healthy level; red is hot. <b>Peak</b> flashes on the loudest moments ' +
            '(for FPP\'s meter, at FPP\'s own hot mark).');
        $id('alTxHelp').innerHTML = helpIconHtml('Lights red when the K-FMT\'s own input reading hits the top. Read only: it is only cleared when you press Clear TX, ' +
            'the same as on the K-FMT page. A brief flash is usually fine; red most of the time means turn down.');
        initTips(el);
    }

    // The K-FMT's own peak reading, read only.
    function pollTx() {
        if (!eq.kfmt || tab !== 'eq') { return Promise.resolve(); }
        return fetch('/api/plugin-apis/kfmt', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
            var lamp = $id('alTxLamp');
            if (!lamp) { return; }
            lamp.classList.toggle('al-lamp-on', !!j.audioClip);
            lamp.classList.toggle('al-lamp-off', !j.audioClip);
            lamp.title = 'K-FMT input peak ' + (j.audioPeak === undefined ? '?' : j.audioPeak) + ' / 15';
        }).catch(function () { /* the plugin isn't answering */ });
    }

    // While the tab is open: is a show running (no live changes then), and the TX lamp.
    function eqStartPolling() {
        if (eq.statusTimer) { return; }
        eq.statusTimer = setInterval(function () {
            if (tab !== 'eq') { clearInterval(eq.statusTimer); eq.statusTimer = null; fppMeterSync(); return; }
            fppMeterSync();
            fetch('/api/fppd/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) {
                var cur = st && st.current_playlist && st.current_playlist.playlist;
                var was = eq.showRunning;
                eq.showRunning = !!st && st.status_name !== 'idle' && cur !== PREVIEW_PLAYLIST;
                eq.playingName = eq.showRunning ? (cur || '') : '';
                var wasQuiet = eq.fppQuiet;
                eq.fppQuiet = eqFppQuiet(st);
                if (was !== eq.showRunning || wasQuiet !== eq.fppQuiet) { renderEq(); }
                if (eq.fppQuiet && !eq.saving && !eq.saveTimer && eqNeedsFpp()) { eqAutoSave(); }
            }).catch(function () { /* fppd down */ });
            pollTx();
        }, 2000);
    }

    // Leaving the tab: the test song stops, Preview turns off and unsaved
    // slider moves go back to what was saved. Live stays as it is.
    function eqLeave() {
        eqFlush(false);
        setTimeout(fppMeterSync, 0);   // after the tab has changed: FPP stops metering
        if (eq.mode === 'try') { eq.mode = 'off'; }
        eq.delAsk = -1;
        $id('alEqConfirm') && $id('alEqConfirm').classList.add('d-none');
        if (player.name) { stopPlayer(); }
    }

    // Leaving: a change still waiting to be remembered is saved now, and
    // FPP plays what you picked (not "Before", if that was on).
    function eqFlush(beacon) {
        clearTimeout(eq.saveTimer);
        eq.saveTimer = null;
        var body = eqSaveBody();
        if (eq.mode !== 'off' && eqDirty()) {
            if (beacon && navigator.sendBeacon) { navigator.sendBeacon(API + 'eq/save', JSON.stringify(body)); }
            else { eqAutoSave(); }
        }
        if (eq.on && !eq.after) {
            if (beacon && navigator.sendBeacon) { navigator.sendBeacon(API + 'eq/live', JSON.stringify({ gains: body.gains })); }
            else { api('POST', 'eq/live', { gains: body.gains }).catch(function () { /* best effort */ }); }
        }
        eq.after = true;   // other tabs hear what FPP plays
        applyEqToPlayer();
    }

    /* ---- the meter ---- */
    var meter = { vu: -40, peakUntil: 0, raf: 0, last: 0, l: -60, r: -60 };

    var vuFace = null;

    // Old paper: the same every time (a fixed seed), so the meter looks like
    // one well-used meter rather than flickering noise.
    function vuAge(x, w, h, layer) {
        var seed = layer === 'paper' ? 1979 : 1957;
        var rnd = function () {
            seed = (seed + 0x6D2B79F5) | 0;
            var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        var i;
        if (layer === 'paper') {
            // Yellowed, uneven tone: big soft stains.
            for (i = 0; i < 9; i++) {
                var sx = rnd() * w, sy = rnd() * h, sr = 25 + rnd() * 70;
                var st = x.createRadialGradient(sx, sy, 0, sx, sy, sr);
                st.addColorStop(0, 'rgba(150, 95, 25, ' + (0.06 + rnd() * 0.08).toFixed(3) + ')');
                st.addColorStop(1, 'rgba(150, 95, 25, 0)');
                x.fillStyle = st;
                x.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
            }
            // Foxing: small brown age spots, a few with a darker heart.
            for (i = 0; i < 26; i++) {
                var fx = rnd() * w, fy = rnd() * h, fr = 1 + rnd() * 4.5;
                var fg = x.createRadialGradient(fx, fy, 0, fx, fy, fr * 2.2);
                fg.addColorStop(0, 'rgba(120, 62, 18, ' + (0.18 + rnd() * 0.3).toFixed(3) + ')');
                fg.addColorStop(1, 'rgba(120, 62, 18, 0)');
                x.fillStyle = fg;
                x.fillRect(fx - fr * 2.2, fy - fr * 2.2, fr * 4.4, fr * 4.4);
            }
            // A tea-coloured water ring, faint.
            x.beginPath();
            x.strokeStyle = 'rgba(130, 80, 20, 0.16)';
            x.lineWidth = 2.2;
            x.arc(w * 0.82, h * 0.7, 22, 0.3, 5.4);
            x.stroke();
            // Edges browned where the light never reached.
            var ed = x.createLinearGradient(0, 0, w, 0);
            ed.addColorStop(0, 'rgba(110, 60, 10, 0.28)');
            ed.addColorStop(0.08, 'rgba(110, 60, 10, 0)');
            ed.addColorStop(0.92, 'rgba(110, 60, 10, 0)');
            ed.addColorStop(1, 'rgba(110, 60, 10, 0.28)');
            x.fillStyle = ed;
            x.fillRect(0, 0, w, h);
            // Paper grain.
            for (i = 0; i < 900; i++) {
                x.fillStyle = rnd() < 0.5 ? 'rgba(90, 50, 10, 0.07)' : 'rgba(255, 245, 220, 0.08)';
                x.fillRect(rnd() * w, rnd() * h, 1, 1);
            }
            return;
        }
        // Crazing: fine hairline cracks wandering across the face, each with a
        // pale edge where the paper lifts.
        for (i = 0; i < 7; i++) {
            var px = rnd() * w, py = rnd() * h, dir = rnd() * Math.PI * 2;
            var pts = [[px, py]];
            for (var k = 0; k < 6 + Math.floor(rnd() * 6); k++) {
                dir += (rnd() - 0.5) * 1.1;
                px += Math.cos(dir) * (6 + rnd() * 12);
                py += Math.sin(dir) * (6 + rnd() * 12);
                pts.push([px, py]);
                if (rnd() < 0.18) {   // a small branch
                    var bd = dir + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6);
                    x.beginPath();
                    x.moveTo(px, py);
                    x.lineTo(px + Math.cos(bd) * (5 + rnd() * 9), py + Math.sin(bd) * (5 + rnd() * 9));
                    x.strokeStyle = 'rgba(70, 40, 10, 0.32)';
                    x.lineWidth = 0.6;
                    x.stroke();
                }
            }
            [['rgba(255, 248, 225, 0.35)', 1.6, 0.8], ['rgba(70, 40, 10, 0.45)', 0.7, 0]].forEach(function (pass) {
                x.beginPath();
                x.moveTo(pts[0][0] + pass[2], pts[0][1] + pass[2]);
                for (var q = 1; q < pts.length; q++) { x.lineTo(pts[q][0] + pass[2], pts[q][1] + pass[2]); }
                x.strokeStyle = pass[0];
                x.lineWidth = pass[1];
                x.stroke();
            });
        }
    }

    function drawVu(vu, peakOn) {
        var c = $id('alVu');
        if (!c) { return; }
        var x = c.getContext('2d'), w = c.width, h = c.height;
        var cx = w / 2, cy = h * 1.02, rad = h * 0.86;
        // VU scale: -20 .. +3, positions as on a classic meter face
        var marks = [[-20, -48], [-10, -33], [-7, -24], [-5, -15], [-3, -6], [-2, 0], [-1, 6], [0, 13], [1, 21], [2, 30], [3, 40]];
        var ang = function (v) {
            if (v <= -20) { return -48; }
            if (v >= 3) { return 40; }
            for (var i = 1; i < marks.length; i++) {
                if (v <= marks[i][0]) {
                    var a = marks[i - 1], b = marks[i];
                    return a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]);
                }
            }
            return 40;
        };
        var pt = function (deg, r) { var t = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
        // The face (paper, ageing, glow, printed scale) is drawn once and
        // reused; each frame only adds the needle and the glass.
        if (!vuFace || vuFace.width !== w || vuFace.height !== h) {
            vuFace = document.createElement('canvas');
            vuFace.width = w;
            vuFace.height = h;
            var screen = x;
            x = vuFace.getContext('2d');
            // A vintage backlit face: warm parchment lit by a bulb behind the top
            // edge, the glow falling off toward the bottom and the corners.
            var face = x.createLinearGradient(0, 0, 0, h);
            face.addColorStop(0, '#fff1c4');
            face.addColorStop(0.45, '#f4d993');
            face.addColorStop(1, '#b98a3e');
            x.fillStyle = face;
            x.fillRect(0, 0, w, h);
            vuAge(x, w, h, 'paper');
            var bulb = x.createRadialGradient(cx, -h * 0.15, h * 0.05, cx, -h * 0.15, h * 1.05);
            bulb.addColorStop(0, 'rgba(255, 236, 170, 0.95)');
            bulb.addColorStop(0.35, 'rgba(255, 205, 110, 0.45)');
            bulb.addColorStop(1, 'rgba(255, 170, 60, 0)');
            x.fillStyle = bulb;
            x.fillRect(0, 0, w, h);
            var vig = x.createRadialGradient(cx, h * 0.35, h * 0.35, cx, h * 0.45, w * 0.62);
            vig.addColorStop(0, 'rgba(60, 30, 0, 0)');
            vig.addColorStop(1, 'rgba(60, 30, 0, 0.45)');
            x.fillStyle = vig;
            x.fillRect(0, 0, w, h);
            var arc = function (a0, a1, r, col, lw) {
                x.beginPath();
                x.strokeStyle = col;
                x.lineWidth = lw;
                x.arc(cx, cy, r, (a0 - 90) * Math.PI / 180, (a1 - 90) * Math.PI / 180);
                x.stroke();
            };
            // Scale printed in ink: a thin black line, the red zone as a band.
            arc(-48, 13, rad - 1, '#2b1d10', 1.5);
            arc(-6, 13, rad - 4, 'rgba(176, 122, 20, 0.85)', 4);
            arc(-48, -6, rad - 4, 'rgba(38, 110, 60, 0.75)', 4);
            arc(13, 40, rad - 3, '#b3161b', 8);
            x.font = '11px Georgia, "Times New Roman", serif';
            x.textAlign = 'center';
            marks.forEach(function (m) {
                var a = pt(m[1], rad), b2 = pt(m[1], rad - 10), t = pt(m[1], rad + 12);
                var ink = m[0] > 0 ? '#a3121a' : '#2b1d10';
                x.beginPath();
                x.strokeStyle = ink;
                x.lineWidth = 1.6;
                x.moveTo(a[0], a[1]);
                x.lineTo(b2[0], b2[1]);
                x.stroke();
                x.fillStyle = ink;
                x.fillText((m[0] > 0 ? '+' : '') + m[0], t[0], t[1] + 4);
            });
            vuAge(x, w, h, 'cracks');
            x.font = 'italic bold 17px Georgia, "Times New Roman", serif';
            x.fillStyle = '#2b1d10';
            x.fillText('VU', cx, h - 30);
            x = screen;
        }
        x.clearRect(0, 0, w, h);
        x.drawImage(vuFace, 0, 0);
        // Needle, with a soft shadow on the face.
        var n = pt(ang(vu), rad - 2);
        x.save();
        x.shadowColor = 'rgba(40, 20, 0, 0.45)';
        x.shadowBlur = 4;
        x.shadowOffsetX = 2;
        x.shadowOffsetY = 2;
        x.beginPath();
        x.strokeStyle = '#1a0f05';
        x.lineWidth = 1.8;
        x.moveTo(cx, cy);
        x.lineTo(n[0], n[1]);
        x.stroke();
        x.restore();
        // The pivot cover along the bottom.
        var cap = x.createLinearGradient(0, h - 22, 0, h);
        cap.addColorStop(0, '#3a3029');
        cap.addColorStop(1, '#0d0907');
        x.fillStyle = cap;
        x.beginPath();
        x.ellipse(cx, h + 6, w * 0.22, 26, 0, Math.PI, 2 * Math.PI);
        x.fill();
        // Glass: a faint sheen across the top.
        var glass = x.createLinearGradient(0, 0, 0, h * 0.5);
        glass.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
        glass.addColorStop(1, 'rgba(255, 255, 255, 0)');
        x.fillStyle = glass;
        x.beginPath();
        x.moveTo(0, 0);
        x.lineTo(w, 0);
        x.lineTo(w, h * 0.18);
        x.quadraticCurveTo(cx, h * 0.32, 0, h * 0.18);
        x.closePath();
        x.fill();
        var lamp = $id('alPeakLamp');
        if (lamp) {
            lamp.classList.toggle('al-lamp-on', !!peakOn);
            lamp.classList.toggle('al-lamp-off', !peakOn);
        }
    }

    function drawLeds(l, r) {
        var c = $id('alLeds');
        if (!c) { return; }
        var x = c.getContext('2d'), n = 24, seg = (c.width - 18) / n;
        x.clearRect(0, 0, c.width, c.height);
        [[l, 2, 'L'], [r, 19, 'R']].forEach(function (row) {
            x.fillStyle = getComputedStyle(c).color;
            x.font = '10px sans-serif';
            x.fillText(row[2], 0, row[1] + 10);
            // -30 .. +3 VU across the segments
            var lit = Math.round((Math.max(-30, Math.min(3, row[0])) + 30) / 33 * n);
            for (var i = 0; i < n; i++) {
                var col = i < 15 ? '#2fb36b' : i < 20 ? '#e6b33c' : '#e04646';
                x.fillStyle = i < lit ? col : 'rgba(127,127,127,.25)';
                x.fillRect(14 + i * seg, row[1], seg - 2, 12);
            }
        });
    }

    // VU ballistics: about 300 ms to settle, like an analog meter. 0 VU sits at
    // -18 dBFS RMS (the usual broadcast alignment); Peak lights at -1 dBFS.
    function meterLoop(ts) {
        meter.raf = 0;
        var a = player.analysers;
        var fpp = fppMeter.on && !(a && player.mode !== 'show');
        if (tab !== 'eq' || (!a && !fpp)) { return; }
        var dt = meter.last ? Math.min(0.1, (ts - meter.last) / 1000) : 0.016;
        meter.last = ts;
        var k = 1 - Math.exp(-dt / 0.3);
        var levels = fpp ? fppLevels() : a.map(function (an) {
            var buf = new Float32Array(an.fftSize);
            an.getFloatTimeDomainData(buf);
            var sum = 0, pk = 0;
            for (var i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; pk = Math.max(pk, Math.abs(buf[i])); }
            if (pk >= 0.89) { meter.peakUntil = Date.now() + 1000; }
            return 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9) + 18;
        });
        meter.l += (levels[0] - meter.l) * k;
        meter.r += ((levels[1] === undefined ? levels[0] : levels[1]) - meter.r) * k;
        meter.vu = Math.max(meter.l, meter.r);
        drawVu(meter.vu, meter.peakUntil > Date.now());
        drawLeds(meter.l, meter.r);
        meter.raf = requestAnimationFrame(meterLoop);
    }

    function startMeter() {
        if (!meter.raf && tab === 'eq' && (player.analysers || fppMeter.on)) { meter.last = 0; meter.raf = requestAnimationFrame(meterLoop); }
        meterSource();
    }

    /* FPP's own meter of the card, while the EQ is live and this tab is on
       screen: the same meters FPP's Audio Mixer shows, asked for the same way
       (POST pipewire/audio/meters, re-posted every 3 s with a 6 s TTL, so
       fppd stops metering by itself when the page goes away) and read from
       FPP's status WebSocket, which FPP's own page script hands to
       window.PWMixerOnLevels. Nothing meters while the tab is hidden or
       you're on another tab. Levels are RMS on FPP's -60..0 dBFS scale. */
    var fppMeter = { on: false, timer: null, node: '', level: null, at: 0, good: 0, since: 0, hooked: false };
    document.addEventListener('visibilitychange', function () { fppMeterSync(); });

    function fppMeterWanted() {
        return tab === 'eq' && eq.on && !eq.rebootPending && !!eq.cardId && eq.groupId > 0 &&
            !document.hidden && typeof window.startFppdWS === 'function';
    }

    function fppMeterPost(nodes, ttl) {
        return fetch('/api/pipewire/audio/meters', {
            method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: nodes, ttl: ttl })
        }).catch(function () { /* fppd down: no levels */ });
    }

    function fppMeterSync() {
        if (fppMeterWanted() === fppMeter.on) { meterSource(); return; }
        if (!fppMeter.on) {
            if (!fppMeter.hooked) {
                var prev = window.PWMixerOnLevels;
                window.PWMixerOnLevels = function (levels) {
                    if (fppMeter.on && levels && typeof levels[fppMeter.node] === 'number') {
                        var v = levels[fppMeter.node], now = Date.now();
                        // fppd reports a meter that fell behind (a busy Pi) as
                        // silence, then catches up. A sudden drop to the floor
                        // right after real sound is that, not a quiet song: ride
                        // over it. Real silence still shows once it lasts.
                        if (v <= 0 && fppMeter.level > 0 && now - fppMeter.good < 1500) { return pass(); }
                        fppMeter.level = v;
                        fppMeter.at = now;
                        if (v > 0) { fppMeter.good = now; }
                    }
                    pass();
                    function pass() { if (typeof prev === 'function') { prev(levels); } }
                    return;
                };
                fppMeter.hooked = true;
            }
            // The card's output after its EQ, named the way FPP's mixer names it.
            fppMeter.node = 'fpp_fx_g' + eq.groupId + '_' + String(eq.cardId).toLowerCase().replace(/[^a-z0-9_]/g, '_');
            fppMeter.on = true;
            fppMeter.level = null;
            fppMeter.since = Date.now();
            var sub = function () { fppMeterPost([{ name: fppMeter.node, sink: true }], 6000); };
            sub();
            fppMeter.timer = setInterval(sub, 3000);
            startMeter();
        } else {
            clearInterval(fppMeter.timer);
            fppMeter.timer = null;
            fppMeter.on = false;
            fppMeter.level = null;
            fppMeterPost([], 0);
            if (!player.analysers) { resetMeter(); }
        }
        meterSource();
    }

    // FPP's level as the meter's L and R (FPP reports one level per node).
    function fppLevels() {
        // Frames can arrive in bursts over the WebSocket: hold the last level
        // through a short gap instead of dropping the needle.
        var fresh = typeof fppMeter.level === 'number' && Date.now() - fppMeter.at < 2000;
        var pct = fresh ? fppMeter.level : 0;
        if (pct >= 90) { meter.peakUntil = Date.now() + 1000; }   // FPP's own "hot" mark, -6 dBFS RMS
        var vu = pct * 0.6 - 60 + 18;
        return [vu, vu];
    }

    // What the meter is showing, above it.
    function meterSource() {
        var el = $id('alEqMeterSrc');
        if (!el) { return; }
        var a = player.analysers && player.mode !== 'show';
        var txt = '';
        if (a) {
            txt = '&middot; test song, in your browser';
        } else if (fppMeter.on) {
            var waiting = !(fppMeter.at > fppMeter.since) && Date.now() - fppMeter.since > 6000;
            txt = waiting ? '&middot; FPP isn\'t sending a level for this card' : '&middot; <b>FPP\'s output, live</b>';
        } else if (eq.on && eq.rebootPending) {
            txt = '&middot; FPP\'s meter shows here after the reboot';
        }
        el.innerHTML = txt;
    }

    function resetMeter() {
        meter.vu = -40; meter.l = meter.r = -60;
        drawVu(meter.vu, false);
        drawLeds(-60, -60);
    }

    /* ---------------- wiring ---------------- */

    // Basic shows the few settings most shows need; Advanced shows all (FPP's UI level names).
    function setView(view, save) {
        var simple = view !== 'advanced';
        $id('audioLeveler').classList.toggle('al-simple', simple);
        Array.prototype.forEach.call(document.querySelectorAll('[data-al-view]'), function (b) {
            var on = (b.getAttribute('data-al-view') === 'advanced') !== simple;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (save) { try { localStorage.setItem('audioLeveler.view', simple ? 'simple' : 'advanced'); } catch (e) { /* no storage */ } }
    }

    function init() {
        // The ? tips: FPP sets up tooltips when its pages load; make sure these
        // are too, on FPP versions that don't.
        if (window.bootstrap && bootstrap.Tooltip) {
            document.querySelectorAll('#audioLeveler [data-bs-toggle="tooltip"]').forEach(function (el) {
                bootstrap.Tooltip.getOrCreateInstance(el);
            });
        }
        if (!$id('audioLeveler')) { return; }
        var view = 'simple';
        try { view = localStorage.getItem('audioLeveler.view') || 'simple'; } catch (e) { /* no storage */ }
        setView(view, false);
        wirePlayer();
        Array.prototype.forEach.call(document.querySelectorAll('[data-al-view]'), function (b) {
            b.addEventListener('click', function () { setView(b.getAttribute('data-al-view'), true); });
        });
        setTab(tab, true);

        $id('alAdvisorRows').addEventListener('click', function (e) {
            var b = e.target.closest('.al-use-target');
            if (!b) { return; }
            // Pick it in the Loudness setting, which saves it the FPP way.
            var sel = $id('AudioLeveler_target');
            if (!sel) { return; }
            sel.value = b.getAttribute('data-t');
            sel.dispatchEvent(new Event('change'));
        });
        $id('alTabs').addEventListener('click', function (e) {
            var b = e.target.closest('[data-tab]');
            if (b) { e.preventDefault(); setTab(b.getAttribute('data-tab')); }
        });

        $id('alRows').addEventListener('change', function (e) {
            if (e.target.classList.contains('al-sel')) {
                var f = shown[+e.target.getAttribute('data-i')];
                if (f) { selected[f.name] = e.target.checked; }
                e.target.closest('tr').classList.toggle('table-active', e.target.checked);
                updateButtons();
            } else if (e.target.classList.contains('al-fix')) {
                var song = shown[+e.target.getAttribute('data-i')];
                if (song) { setChoice([song.name], e.target.value); }
            }
        });
        $id('alSetFix').addEventListener('blur', function () { updateButtons(); });
        $id('alSetFix').addEventListener('change', function () {
            var v = this.value;
            if (!v) { updateButtons(); return; }
            // Background and Skip are deliberate per-song decisions: a bulk
            // change leaves them alone, unless only such songs are selected
            // (then they're clearly what you mean to change).
            var sel = files.filter(function (f) { return selected[f.name]; });
            var kept = sel.filter(function (f) {
                return (f.choice === 'background' || f.choice === 'skip') && f.choice !== v;
            });
            var change = kept.length === sel.length ? sel : sel.filter(function (f) { return kept.indexOf(f) < 0; });
            setChoice(change.map(function (f) { return f.name; }), v);
            if (kept.length && change.length < sel.length) {
                var bg = kept.filter(function (f) { return f.choice === 'background'; }).length;
                var sk = kept.length - bg;
                toast('Kept ' + [bg ? bg + ' Background' : '', sk ? sk + ' Skip' : ''].filter(Boolean).join(' and ') +
                    ' ' + noun(kept.length) + ' as they were. Change those from their own dropdown, ' +
                    'or select only them and use Set fix.');
            }
        });
        $id('alRows').addEventListener('click', function (e) {
            var btn = e.target.closest('.al-restore');
            if (!btn || busy()) { return; }
            var f = shown[+btn.getAttribute('data-i')];
            if (f) { start('restore', { files: [f.name] }); }
        });
        $id('alSelectAll').addEventListener('change', function () {
            // Acts on the songs currently shown, so "Clipping" + tick all
            // selects exactly the clipping songs.
            var on = this.checked;
            shown.forEach(function (f) { selected[f.name] = on; });
            renderRows();
        });
        $id('alClearSel').addEventListener('click', function () {
            selected = {};
            renderRows();
        });
        $id('alFilters').addEventListener('click', function (e) {
            var b = e.target.closest('[data-filter]');
            if (!b) { return; }
            setFilter(b.getAttribute('data-filter'));
            renderRows();
        });
        $id('alSearch').addEventListener('input', function () {
            search = this.value;
            renderRows();
        });
        Array.prototype.forEach.call(document.querySelectorAll('#audioLeveler .al-sort'), function (b) {
            b.addEventListener('click', function () {
                var k = b.getAttribute('data-sort');
                if (k === sortKey) { sortDir = -sortDir; } else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
                renderRows();
            });
        });

        $id('alMeasure').addEventListener('click', function () {
            var sel = selectedNames();
            start('analyze', { files: sel.length ? sel : 'all', scope: tab, force: sel.length > 0 });
        });
        $id('alLevelSel').addEventListener('click', function () {
            start('level', { files: selectedNames() });
        });
        $id('alLevelAll').addEventListener('click', function () {
            start('level', { files: 'all', scope: tab });
        });
        $id('alRetime').addEventListener('click', function () {
            var names = files.filter(function (f) { return f.lateTag; }).map(function (f) { return f.name; });
            if (names.length) { start('retime', { files: names }); }
        });
        $id('alRestoreSel').addEventListener('click', function () {
            var names = files.filter(function (f) { return selected[f.name] && f.canRestore; }).map(function (f) { return f.name; });
            start('restore', { files: names });
        });
        $id('alCancel').addEventListener('click', function () {
            api('POST', 'cancel').then(function () {
                $id('alJobMsg').textContent = 'Stopping…';
            });
        });
        $id('alDeleteBackups').addEventListener('click', function () {
            var b = this;
            if (!deleteArmed) {
                deleteArmed = true;
                b.textContent = 'Tap again to delete all backups';
                setTimeout(function () { deleteArmed = false; b.textContent = 'Delete all backups'; }, 5000);
                return;
            }
            deleteArmed = false;
            b.textContent = 'Delete all backups';
            api('DELETE', 'backups', { count: backupCount }).then(function (j) {
                toast('Deleted ' + j.deleted + ' backup(s).');
                loadFiles();
            }).catch(function (e) { toast(e.message, false); });
        });

        // Scan for songs / videos: pick up files uploaded since the page opened.
        $id('alScan').addEventListener('click', function () {
            var b = this, which = tab, before = allFiles.filter(inTab).length;
            scanning = true;
            b.disabled = true;
            b.textContent = 'Scanning\u2026';
            Promise.all([loadFiles(), loadTags()]).then(function () {
                var n = allFiles.filter(inTab).length, added = n - before;
                if (tab === which) {
                    toast('Found ' + n + ' ' + noun(n) + (added > 0 ? ' (' + added + ' new)' : '') + '.' +
                        (which === 'videos' && added > 0 ? ' New videos appear as they\'re checked for sound.' : ''));
                }
            }).catch(function (e) { toast(e.message, false); }).then(function () {
                scanning = false;
                b.disabled = false;
                updateButtons();
            });
        });

        api('GET', 'options').then(function (j) { showOptions(j.options); })
            .catch(function () { showOptions({ target: -14, ceiling: -1.5, backup: true, waitIdle: true, lossless: true, bgOffset: 10, match: 'speakers' }); })
            .then(loadFiles)
            .then(poll)
            .then(autoCheck)
            .then(loadTags);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
