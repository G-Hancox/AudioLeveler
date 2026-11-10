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
            return r.json().catch(function () { return {}; }).then(function (j) {
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

    var WORKING_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', auto: 'Auto-leveling new uploads' };

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
        var verb = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', auto: 'Auto-leveling new uploads' }[jobProgress.cmd] || 'Working';
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
        $id('alAdvisorNote').textContent = isFinite(limit)
            ? 'Up to ' + (Math.floor(limit * 2) / 2).toFixed(1) + ' LUFS, every show song lands right on its target with a plain volume change' +
              (by ? ' (the first to need help above that is ' + by + ').' : '.') +
              ' Above it, a song a little short of headroom is left up to 1 dB quieter instead of limited.' +
              ' Counts use each song\'s recommended fix' + (options.match !== 'lufs' ? ' and speaker matching' : '') + '.'
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
                    '<td class="text-break al-song">' + songName(f) +
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
        $id('alSetFix').disabled = !sel.length;
        $id('alSelText').textContent = sel.length
            ? sel.length + ' ' + noun(sel.length) + ' selected' +
              (selWithBackup ? ' · ' + selWithBackup + ' with an original to restore' : '')
            : 'No ' + noun(2) + ' selected. Tick ' + noun(2) + ' to level or restore just those.';
        $id('alClearSel').classList.toggle('d-none', !sel.length);
        $id('alMeasure').textContent = sel.length ? 'Measure selected' : 'Measure ' + noun(2);
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
        tab = name;
        try { localStorage.setItem('audioLeveler.tab', name); } catch (e) { /* no storage */ }
        [['songs', 'alTabSongs'], ['videos', 'alTabVideos']].forEach(function (t) {
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

    function loadFiles() {
        return api('GET', 'files').then(function (j) {
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
            $id('alBackupInfo').textContent = bk.count
                ? bk.count + ' original' + (bk.count === 1 ? '' : 's') + ' backed up (' + fmtBytes(bk.bytes) + ')' +
                  (j.freeBytes ? ', ' + fmtBytes(j.freeBytes) + ' free' : '')
                : 'No backups yet';
            $id('alDeleteBackups').disabled = !bk.count || busy();
            renderRows();
        }).catch(function (e) { toast(e.message, false); });
    }

    /* ---------------- jobs ---------------- */

    var CMD_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring', retime: 'Fixing MP3 timing', auto: 'Auto-leveling new uploads' };

    function showJob(j) {
        var state = j.state || null;
        var wasBusy = busy();
        lastJobState = state;
        var box = $id('alJob');
        if (busy()) {
            box.classList.remove('d-none');
            $id('alResult').classList.add('d-none');
            var total = j.total || 0, done = j.done || 0;
            jobProgress = { cmd: j.cmd || jobProgress.cmd, done: done, total: total };
            renderStats();
            var pct = total ? Math.round(100 * done / total) : 0;
            $id('alJobBar').style.width = pct + '%';
            var verb = CMD_NAMES[j.cmd] || 'Working';
            var txt = state === 'starting' ? 'Starting…'
                : verb + ' ' + (total ? (Math.min(done + 1, total)) + ' of ' + total : '') +
                  (j.current ? ': ' + shortName(j.current) : '');
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
            }
        }
        updateButtons();
        schedulePoll();
    }

    function showResult(j) {
        var res = j.results || [];
        var names = res.map(function (r) { return r.file; });
        var bad = res.filter(function (r) { return !r.ok; });
        var verb = { analyze: 'Measured', level: 'Leveled', restore: 'Restored', retime: 'Fixed the timing of', auto: 'Auto-leveled' }[j.cmd] || 'Finished';
        var head;
        var cls = 'alert-success';
        if (j.state === 'cancelled') {
            var doneN = res.length, total = j.total || 0;
            var again = { analyze: 'Measure ' + jobNoun(names, 2), level: 'Level all (or Level selected)', restore: 'Restore originals', retime: 'Fix MP3 timing' }[j.cmd] || 'it';
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
        if (!$id('audioLeveler')) { return; }
        var view = 'simple';
        try { view = localStorage.getItem('audioLeveler.view') || 'simple'; } catch (e) { /* no storage */ }
        setView(view, false);
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
        $id('alSetFix').addEventListener('change', function () {
            var v = this.value;
            this.value = '';
            if (!v) { return; }
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
            api('DELETE', 'backups').then(function (j) {
                toast('Deleted ' + j.deleted + ' backup(s).');
                loadFiles();
            }).catch(function (e) { toast(e.message, false); });
        });

        api('GET', 'options').then(function (j) { showOptions(j.options); })
            .catch(function () { showOptions({ target: -14, ceiling: -1.5, backup: true, waitIdle: true, lossless: true, bgOffset: 10, match: 'speakers' }); })
            .then(loadFiles)
            .then(poll)
            .then(autoCheck);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
