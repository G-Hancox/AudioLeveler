/* Audio Leveler - Content Setup page */
(function () {
    'use strict';

    var API = '/api/plugin/AudioLeveler/';
    var files = [];
    var options = null;
    var selected = {};
    var pollTimer = null;
    var lastJobState = null;
    var shown = [];          // songs currently listed, after filter/search/sort
    var filter = 'all';
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
        'default': 'Default', auto: 'Recommended', volume: 'Volume only', limit: 'Limiter',
        compress: 'Compression', background: 'Background', skip: 'Skip'
    };

    /* ---------------- per-song recommendation (display copy) ----------------
       Mirrors recommend() in bin/leveler.py, which is what the worker uses;
       keep the two in step. Quality first: a plain volume change whenever
       it's enough, the limiter only for gentle trims, never compression. */

    var NEAR_TARGET_DB = 0.5, GENTLE_LIMIT_DB = 3.0, LOSSLESS_STEP = 1.505;
    var VOLUME_CLOSE_DB = 1.0, PEAK_TOLERANCE_DB = 0.1;
    var WIDE_DYNAMICS_LU = 15, LONG_TRACK_SECONDS = 900;

    function recommendMode(I, TP, target, ceiling) {
        var gain = target - I;
        var over = (TP === null || TP === undefined) ? null : TP + gain - ceiling;
        if (over === null || over <= PEAK_TOLERANCE_DB) {
            return Math.abs(gain) < NEAR_TARGET_DB ? 'none' : 'volume';
        }
        if (over <= VOLUME_CLOSE_DB) { return 'volume'; }
        return over <= GENTLE_LIMIT_DB ? 'limit' : 'volume';
    }

    function dB(v) { return (v > 0 ? '+' : (v < 0 ? '−' : '±')) + Math.abs(v).toFixed(1) + ' dB'; }

    // What leveling would do to this song now: {text, note, rec}
    function planFor(f) {
        if (!hasLufs(f)) { return { text: 'Measure first', note: '' }; }
        var choice = f.choice || 'default';
        var mode = choice === 'default' ? options.mode : choice;
        var target = options.target, ceiling = options.ceiling;
        var I = f.lufs, TP = (f.peak === null || f.peak === undefined) ? null : f.peak;
        var mp3Lossless = /\.mp3$/i.test(f.name) && options.lossless !== false;
        var note = [];
        if (f.lra !== null && f.lra !== undefined && f.lra > WIDE_DYNAMICS_LU && mode !== 'compress') {
            note.push('Wide dynamics (' + f.lra.toFixed(0) + ' LU); compression is an option if quiet parts get lost');
        }
        if (f.length && f.length > LONG_TRACK_SECONDS && choice !== 'background' && choice !== 'skip') {
            note.push('Long track. Background?');
        }
        if (choice === 'skip') { return { text: 'Skipped', note: '' }; }
        if (choice === 'background') { mode = 'volume'; target = target - (options.bgOffset || 10); }
        var rec = mode === 'auto';
        if (rec) {
            mode = recommendMode(I, TP, target, ceiling);
            if (mode === 'none') { return { text: 'Fine as is', note: note.join(' · '), rec: true }; }
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
                text = dB(gain) + (lossless ? ' · lossless' : ' · re-encode');
            }
            var lands = I + gain;
            if (lands < target - 0.8) {
                text += ' · ends at ' + lands.toFixed(1) + ' LUFS';
            }
        }
        return { text: text, note: note.join(' · '), rec: rec };
    }

    function fixHtml(f, i) {
        var choice = f.choice || 'default';
        var opts = Object.keys(CHOICE_NAMES).map(function (k) {
            var label = CHOICE_NAMES[k];
            if (k === 'default') { label += ' (' + (MODE_NAMES[options.mode] || options.mode) + ')'; }
            return '<option value="' + k + '"' + (k === choice ? ' selected' : '') + '>' + esc(label) + '</option>';
        }).join('');
        var plan = planFor(f);
        return '<select class="form-select form-select-sm al-fix" data-i="' + i + '" aria-label="Fix for ' + esc(f.name) + '">' + opts + '</select>' +
            '<div class="small mt-1">' + esc(plan.text) + '</div>' +
            (plan.note ? '<div class="small text-body-secondary">' + esc(plan.note) + '</div>' : '');
    }

    /* ---------------- options ---------------- */

    function currentTarget() {
        var p = $id('alTargetPreset').value;
        if (p === 'custom') {
            var v = parseFloat($id('alTargetCustom').value);
            return isNaN(v) ? -14 : Math.max(-30, Math.min(-6, v));
        }
        return parseFloat(p);
    }

    function readOptions() {
        var mode = document.querySelector('input[name="alMode"]:checked');
        return {
            target: currentTarget(),
            ceiling: parseFloat($id('alCeiling').value),
            mode: mode ? mode.value : 'auto',
            bgOffset: parseFloat($id('alBgOffset').value) || 10,
            backup: $id('alBackup').checked,
            waitIdle: $id('alWaitIdle').checked,
            lossless: $id('alLossless').checked
        };
    }

    function showOptions(o) {
        options = o;
        var preset = $id('alTargetPreset');
        var t = String(Number(o.target));
        var match = Array.prototype.some.call(preset.options, function (op) { return op.value === t; });
        preset.value = match ? t : 'custom';
        $id('alTargetCustom').value = o.target;
        $id('alTargetCustom').classList.toggle('d-none', match);
        var c = String(Number(o.ceiling));
        var cs = $id('alCeiling');
        if (!Array.prototype.some.call(cs.options, function (op) { return op.value === c; })) {
            var op = document.createElement('option');
            op.value = c; op.textContent = c + ' dBTP';
            cs.appendChild(op);
        }
        cs.value = c;
        var radio = document.querySelector('input[name="alMode"][value="' + o.mode + '"]');
        if (radio) { radio.checked = true; }
        $id('alBackup').checked = !!o.backup;
        $id('alWaitIdle').checked = !!o.waitIdle;
        $id('alLossless').checked = o.lossless !== false;
        var bg = String(Number(o.bgOffset || 10));
        var bs = $id('alBgOffset');
        if (!Array.prototype.some.call(bs.options, function (op) { return op.value === bg; })) {
            var bo = document.createElement('option');
            bo.value = bg; bo.textContent = bg + ' dB under the show';
            bs.appendChild(bo);
        }
        bs.value = bg;
    }

    function saveOptions() {
        var o = readOptions();
        options = o;
        renderRows();
        api('POST', 'options', o).catch(function (e) { toast(e.message, false); });
    }

    /* ---------------- songs table ---------------- */

    function lufsClass(f) {
        if (!f.measured || f.lufs === null || f.lufs === undefined) { return ''; }
        var d = Math.abs(f.lufs - (options ? options.target : -14));
        if (d <= 1) { return 'text-success'; }
        if (d <= 4) { return 'text-warning-emphasis'; }
        return 'text-danger';
    }

    var WORKING_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring' };

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
        if (f.leveled) {
            var l = f.leveled;
            return '<span class="badge text-bg-success">Leveled</span> <span class="small text-body-secondary">' +
                esc(l.target + ' LUFS, ' + (l.method === 'lossless' ? 'lossless'
                    : l.method === 'original' ? 'original kept'
                    : (MODE_NAMES[l.mode] || l.mode) + ', re-encoded')) + '</span>';
        }
        if (f.changedSinceLeveled) {
            return '<span class="badge text-bg-warning">Replaced since leveling</span>';
        }
        if (!f.measured) {
            return '<span class="small text-body-secondary">Not measured yet</span>';
        }
        return '<span class="small text-body-secondary">Original</span>';
    }

    function hasLufs(f) { return f.measured && f.lufs !== null && f.lufs !== undefined; }
    function clips(f) { return f.measured && f.peak !== null && f.peak !== undefined && f.peak > 0; }
    function offTarget(f) { return hasLufs(f) && !!options && Math.abs(f.lufs - options.target) > 1; }

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
            el.innerHTML = '<div class="col-12 text-body-secondary">No songs found in the music folder.</div>';
            return;
        }
        var measured = files.filter(hasLufs);
        var spread = '&ndash;', spreadCls = '', spreadLbl = 'loudness spread';
        if (measured.length > 1) {
            var lo = Math.min.apply(null, measured.map(function (f) { return f.lufs; }));
            var hi = Math.max.apply(null, measured.map(function (f) { return f.lufs; }));
            spread = (hi - lo).toFixed(1) + ' <small class="fw-normal">dB</small>';
            spreadCls = hi - lo <= 2 ? 'text-success' : (hi - lo <= 6 ? 'text-warning-emphasis' : 'text-danger');
            spreadLbl = 'spread, ' + lo.toFixed(1) + ' to ' + hi.toFixed(1) + ' LUFS';
        }
        var clipN = measured.filter(clips).length;
        var offN = measured.filter(offTarget).length;
        var notM = files.length - measured.length;
        // While a job runs these totals are a mix of old and new numbers, so
        // grey them out and say so, rather than let them look final.
        var stale = busy();
        var verb = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring' }[jobProgress.cmd] || 'Working';
        el.innerHTML =
            (stale ? '<div class="col-12 small text-body-secondary">' +
                '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' +
                esc(verb + '…' + (jobProgress.total ? ' ' + jobProgress.done + ' of ' + jobProgress.total + ' done.' : '') +
                    ' These totals will update when it finishes.') + '</div>' : '') +
            stat(files.length, notM ? notM + ' not measured yet' : 'songs, all measured') +
            stat(spread, esc(spreadLbl), spreadCls) +
            stat(clipN, 'clipping', clipN ? 'text-danger' : 'text-success') +
            stat(offN, 'more than 1 dB off ' + options.target + ' LUFS', offN ? 'text-warning-emphasis' : 'text-success');
    }

    // Meter range in LUFS: quiet end to loud end.
    var METER_LO = -30, METER_HI = -3;

    function meterHtml(f) {
        if (!hasLufs(f)) { return ''; }
        var pos = function (v) { return Math.max(0, Math.min(100, 100 * (v - METER_LO) / (METER_HI - METER_LO))); };
        var d = Math.abs(f.lufs - options.target);
        var bg = d <= 1 ? 'bg-success' : (d <= 4 ? 'bg-warning' : 'bg-danger');
        return '<div class="al-meter" aria-hidden="true">' +
            '<div class="al-meter-fill ' + bg + '" style="width:' + pos(f.lufs).toFixed(1) + '%"></div>' +
            '<div class="al-meter-target" style="left:' + pos(options.target).toFixed(1) + '%"></div></div>';
    }

    // Sort songs by title, not raw file name: skip a leading track number
    // ("01 - ", "13 ", "07."), ignore case, and order numbers naturally.
    // A name that merely starts with a digit (like "2WEI ...") is left alone.
    function titleKey(name) {
        return name.replace(/^\s*\d{1,3}(?:\s*[-_.)]\s*|\s+)(?=\S)/, '');
    }

    function byTitle(a, b) {
        return titleKey(a.name).localeCompare(titleKey(b.name), undefined, { sensitivity: 'base', numeric: true }) ||
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
                case 'custom': return !!f.choice && f.choice !== 'default';
                case 'unmeasured': return !hasLufs(f);
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

    function renderRows() {
        renderStats();
        renderSortIcons();
        var tb = $id('alRows');
        shown = visibleFiles();
        if (!files.length) {
            tb.innerHTML = '<tr><td colspan="7" class="text-body-secondary py-3 text-center">No songs in the music folder.</td></tr>';
        } else if (!shown.length) {
            tb.innerHTML = '<tr><td colspan="7" class="text-body-secondary py-3 text-center">No songs match this filter.</td></tr>';
        } else {
            tb.innerHTML = shown.map(function (f, i) {
                var lufs = hasLufs(f) ? f.lufs.toFixed(1) : '&ndash;';
                var peak = f.measured && f.peak !== null && f.peak !== undefined ? f.peak.toFixed(1) : '&ndash;';
                var restore = f.backup
                    ? '<button type="button" class="buttons btn btn-sm btn-outline-secondary al-restore" data-i="' + i + '" title="Put the original back">Restore</button>'
                    : '';
                return '<tr' + (selected[f.name] ? ' class="table-active"' : '') + '>' +
                    '<td class="text-center"><input class="form-check-input al-sel" type="checkbox" data-i="' + i + '"' +
                    (selected[f.name] ? ' checked' : '') + ' aria-label="Select ' + esc(f.name) + '"></td>' +
                    '<td class="text-break al-song">' + esc(f.name) +
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
        $id('alMeasure').disabled = b || !files.length;
        $id('alLevelAll').disabled = b || !files.length;
        $id('alLevelSel').disabled = b || !sel.length;
        var selWithBackup = files.filter(function (f) { return selected[f.name] && f.backup; }).length;
        $id('alRestoreSel').disabled = b || !selWithBackup;
        $id('alSetFix').disabled = !sel.length;
        $id('alSelText').textContent = sel.length
            ? sel.length + ' song' + (sel.length === 1 ? '' : 's') + ' selected' +
              (selWithBackup ? ' · ' + selWithBackup + ' with an original to restore' : '')
            : 'No songs selected. Tick songs to level or restore just those.';
        $id('alClearSel').classList.toggle('d-none', !sel.length);
        $id('alMeasure').textContent = sel.length ? 'Measure selected' : 'Measure songs';
        var all = $id('alSelectAll');
        var shownSel = shown.filter(function (f) { return selected[f.name]; }).length;
        all.checked = shown.length > 0 && shownSel === shown.length;
        all.indeterminate = shownSel > 0 && shownSel < shown.length;
    }

    // Save how the given songs should be leveled, and show the new plan at once.
    function setChoice(names, choice) {
        if (!names.length) { return; }
        files.forEach(function (f) { if (names.indexOf(f.name) >= 0) { f.choice = choice; } });
        renderRows();
        api('POST', 'choice', { files: names, choice: choice }).then(function () {
            if (names.length > 1) {
                toast(names.length + ' songs set to ' + CHOICE_NAMES[choice] + '.');
            }
        }).catch(function (e) {
            toast(e.message, false);
            loadFiles();
        });
    }

    function loadFiles() {
        return api('GET', 'files').then(function (j) {
            files = j.files || [];
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

    var CMD_NAMES = { analyze: 'Measuring', level: 'Leveling', restore: 'Restoring' };

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
                  (j.current ? ': ' + j.current : '');
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
        var bad = res.filter(function (r) { return !r.ok; });
        var verb = { analyze: 'Measured', level: 'Leveled', restore: 'Restored' }[j.cmd] || 'Finished';
        var head;
        var cls = 'alert-success';
        if (j.state === 'cancelled') {
            var doneN = res.length, total = j.total || 0;
            var again = { analyze: 'Measure songs', level: 'Level all (or Level selected)', restore: 'Restore originals' }[j.cmd] || 'it';
            head = 'Stopped after ' + doneN + (total ? ' of ' + total : '') + ' song' + (doneN === 1 ? '' : 's') + '. ' +
                (doneN ? 'The ' + (doneN === 1 ? 'one' : doneN) + ' finished ' + (doneN === 1 ? 'is' : 'are') + ' saved' : 'Nothing was changed') +
                (j.stoppedAt ? '; ' + j.stoppedAt + ' was left as it was' : '') + '.' +
                (total && doneN < total && j.cmd !== 'restore'
                    ? ' Press ' + again + ' again to carry on with the rest; finished songs are skipped.' : '');
            cls = 'alert-secondary';
        } else if (j.state === 'error') {
            head = j.message || 'The job stopped with an error.';
            cls = 'alert-danger';
        } else {
            head = verb + ' ' + (res.length - bad.length) + ' song' + (res.length - bad.length === 1 ? '' : 's') + '.';
            if (bad.length) { cls = 'alert-warning'; }
        }
        var html = '<div class="alert ' + cls + ' mb-0" role="status"><div>' + esc(head) + '</div>';
        if (bad.length) {
            html += '<div class="mt-1">' + bad.length + ' had a problem:</div><ul class="mb-0">' +
                bad.slice(0, 20).map(function (r) { return '<li>' + esc(r.file + ': ' + r.msg) + '</li>'; }).join('') +
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

    function init() {
        if (!$id('audioLeveler')) { return; }

        $id('alTargetPreset').addEventListener('change', function () {
            var custom = this.value === 'custom';
            $id('alTargetCustom').classList.toggle('d-none', !custom);
            if (custom) { $id('alTargetCustom').focus(); }
            saveOptions();
        });
        $id('alTargetCustom').addEventListener('change', saveOptions);
        $id('alCeiling').addEventListener('change', saveOptions);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="alMode"]'), function (r) {
            r.addEventListener('change', saveOptions);
        });
        $id('alBackup').addEventListener('change', saveOptions);
        $id('alWaitIdle').addEventListener('change', saveOptions);
        $id('alLossless').addEventListener('change', saveOptions);
        $id('alBgOffset').addEventListener('change', saveOptions);

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
                    ' song' + (kept.length === 1 ? '' : 's') + ' as they were. Change those from their own dropdown, ' +
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
            filter = b.getAttribute('data-filter');
            Array.prototype.forEach.call(this.querySelectorAll('[data-filter]'), function (x) {
                x.classList.toggle('active', x === b);
                x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
            });
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
            start('analyze', { files: sel.length ? sel : 'all', force: sel.length > 0 });
        });
        $id('alLevelSel').addEventListener('click', function () {
            var o = readOptions();
            o.files = selectedNames();
            start('level', o);
        });
        $id('alLevelAll').addEventListener('click', function () {
            var o = readOptions();
            o.files = 'all';
            start('level', o);
        });
        $id('alRestoreSel').addEventListener('click', function () {
            var names = files.filter(function (f) { return selected[f.name] && f.backup; }).map(function (f) { return f.name; });
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
            .catch(function () { showOptions({ target: -14, ceiling: -1, mode: 'auto', backup: true, waitIdle: true, lossless: true, bgOffset: 10 }); })
            .then(loadFiles)
            .then(poll);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
