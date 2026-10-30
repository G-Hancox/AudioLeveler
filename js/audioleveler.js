/* Audio Leveler - Content Setup page */
(function () {
    'use strict';

    var API = '/api/plugin/AudioLeveler/';
    var files = [];
    var options = null;
    var selected = {};
    var pollTimer = null;
    var lastJobState = null;
    var lastDone = -1;       // songs finished at the last poll, to refresh the list as each one completes
    var workingOn = '';      // song the running job is on right now
    var workingCmd = '';
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

    var MODE_NAMES = { volume: 'volume only', limit: 'limiter', compress: 'compression' };

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
            mode: mode ? mode.value : 'limit',
            backup: $id('alBackup').checked,
            waitIdle: $id('alWaitIdle').checked
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
        if (busy() && workingOn && f.name === workingOn) {
            return '<span class="badge text-bg-primary"><span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' +
                esc(WORKING_NAMES[workingCmd] || 'Working') + '…</span>';
        }
        if (f.leveled) {
            var l = f.leveled;
            return '<span class="badge text-bg-success">Leveled</span> <span class="form-text">' +
                esc(l.target + ' LUFS, ' + (MODE_NAMES[l.mode] || l.mode)) + '</span>';
        }
        if (f.changedSinceLeveled) {
            return '<span class="badge text-bg-warning">Replaced since leveling</span>';
        }
        if (!f.measured) {
            return '<span class="form-text">Not measured yet</span>';
        }
        return '<span class="form-text">Original</span>';
    }

    function renderSummary() {
        var measured = files.filter(function (f) { return f.measured && f.lufs !== null && f.lufs !== undefined; });
        var el = $id('alSummary');
        if (!files.length) {
            el.innerHTML = '<span class="text-body-secondary">No songs found in the music folder.</span>';
            return;
        }
        var parts = [files.length + ' song' + (files.length === 1 ? '' : 's')];
        if (measured.length < files.length) {
            parts.push((files.length - measured.length) + ' not measured yet');
        }
        if (measured.length) {
            var lo = Math.min.apply(null, measured.map(function (f) { return f.lufs; }));
            var hi = Math.max.apply(null, measured.map(function (f) { return f.lufs; }));
            parts.push('loudness ranges from ' + lo.toFixed(1) + ' to ' + hi.toFixed(1) + ' LUFS (' + (hi - lo).toFixed(1) + ' dB apart)');
            var clip = measured.filter(function (f) { return f.peak !== null && f.peak > 0; }).length;
            if (clip) { parts.push(clip + ' clipping'); }
            var off = measured.filter(function (f) { return Math.abs(f.lufs - options.target) > 1; }).length;
            parts.push(off ? off + ' more than 1 dB off your target' : 'all within 1 dB of your target');
        }
        el.innerHTML = '<span class="form-text">' + esc(parts.join(' · ')) + '</span>';
    }

    function renderRows() {
        var tb = $id('alRows');
        if (!files.length) {
            tb.innerHTML = '<tr><td colspan="6" class="text-body-secondary">No songs in the music folder.</td></tr>';
            renderSummary();
            updateButtons();
            return;
        }
        var html = files.map(function (f, i) {
            var lufs = f.measured && f.lufs !== null && f.lufs !== undefined ? f.lufs.toFixed(1) : '&ndash;';
            var peak = f.measured && f.peak !== null && f.peak !== undefined ? f.peak.toFixed(1) : '&ndash;';
            var clip = f.measured && f.peak > 0 ? ' <span class="badge text-bg-danger">clips</span>' : '';
            var restore = f.backup
                ? '<button type="button" class="buttons btn btn-sm btn-outline-secondary al-restore" data-i="' + i + '" title="Put the original back">Restore</button>'
                : '';
            return '<tr>' +
                '<td class="text-center"><input class="form-check-input al-sel" type="checkbox" data-i="' + i + '"' +
                (selected[f.name] ? ' checked' : '') + ' aria-label="Select ' + esc(f.name) + '"></td>' +
                '<td class="text-break">' + esc(f.name) +
                '<div class="d-md-none">' + statusHtml(f) + '</div></td>' +
                '<td class="text-end text-nowrap ' + lufsClass(f) + '">' + lufs + '</td>' +
                '<td class="text-end text-nowrap d-none d-sm-table-cell">' + peak + clip + '</td>' +
                '<td class="d-none d-md-table-cell">' + statusHtml(f) + '</td>' +
                '<td class="text-end">' + restore + '</td>' +
                '</tr>';
        }).join('');
        tb.innerHTML = html;
        renderSummary();
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
        $id('alLevelSel').textContent = sel.length ? 'Level selected (' + sel.length + ')' : 'Level selected';
        var selWithBackup = files.filter(function (f) { return selected[f.name] && f.backup; }).length;
        $id('alRestoreSel').disabled = b || !selWithBackup;
        var all = $id('alSelectAll');
        all.checked = files.length > 0 && sel.length === files.length;
        all.indeterminate = sel.length > 0 && sel.length < files.length;
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
            head = 'Stopped. ' + (res.length - bad.length) + ' song(s) were finished before cancelling.';
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
        updateButtons();
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

        $id('alRows').addEventListener('change', function (e) {
            if (e.target.classList.contains('al-sel')) {
                var f = files[+e.target.getAttribute('data-i')];
                if (f) { selected[f.name] = e.target.checked; }
                updateButtons();
            }
        });
        $id('alRows').addEventListener('click', function (e) {
            var btn = e.target.closest('.al-restore');
            if (!btn || busy()) { return; }
            var f = files[+btn.getAttribute('data-i')];
            if (f) { start('restore', { files: [f.name] }); }
        });
        $id('alSelectAll').addEventListener('change', function () {
            var on = this.checked;
            selected = {};
            if (on) { files.forEach(function (f) { selected[f.name] = true; }); }
            renderRows();
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
                $id('alJobMsg').textContent = 'Stopping after the current song…';
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
            .catch(function () { showOptions({ target: -14, ceiling: -1, mode: 'limit', backup: true, waitIdle: true }); })
            .then(loadFiles)
            .then(poll);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
