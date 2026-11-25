(function () {
    'use strict';

    var S = window.StatsEnhancer;
    var panel = document.getElementById('se-panel');
    if (!S || !panel) {
        return;
    }

    var runBtn = document.getElementById('se-run');
    var statusEl = document.getElementById('se-status');
    var resultsEl = document.getElementById('se-results');
    var state = { job: S.jobId || '', result: null, polling: false, startedAt: 0, task: false };
    var used = {};
    (S.used || []).forEach(function (u) {
        if (u && u.job_id && u.addon_id) {
            used[u.job_id + ':' + u.addon_id] = true;
        }
    });

    var STAGES = {
        queued: 'Queued',
        start: 'Starting',
        plan: 'Reading the article',
        fetch: 'Pulling the stats',
        design: 'Choosing add-ons and writing headlines',
        render: 'Drawing the graphics',
        finished: 'Finishing up'
    };

    var TEMPLATE_LABELS = {
        stat_widget: 'Stat widget',
        versus_widget: 'Head-to-head widget',
        form_widget: 'Form widget',
        status_widget: 'Status widget',
        bar_series: 'Game-by-game chart',
        split_card: 'Split card',
        compare_bars: 'Comparison chart',
        leaderboard: 'Leaderboard',
        key_numbers: 'By the numbers',
        context_card: 'Status card',
        table: 'Stats table',
        claim_card: 'Claim check',
        turning_point: 'Turning point',
        history_strip: 'History chart'
    };

    var FEED_LABELS = {
        player_gamelogs: 'player game logs',
        team_gamelogs: 'team game logs',
        team_games: 'schedule and results',
        player_totals: 'player season totals',
        league_player_totals: 'league player totals',
        league_team_totals: 'league team totals',
        standings: 'standings',
        injuries: 'injury report',
        team_history: 'team history (every game)',
        player_history: 'player history (every game)'
    };

    function h(tag, attrs, children) {
        var el = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) {
                return;
            }
            if (k === 'class') {
                el.className = v;
            } else if (k === 'text') {
                el.textContent = v;
            } else if (k.indexOf('on') === 0 && typeof v === 'function') {
                el.addEventListener(k.slice(2), v);
            } else {
                el.setAttribute(k, v === true ? '' : v);
            }
        });
        (children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) {
                return;
            }
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return el;
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function norm(s) {
        return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
            .replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function request(action, data) {
        var fd = new FormData();
        fd.append('action', 'stats_enhancer_' + action);
        fd.append('nonce', S.nonce);
        fd.append('post_id', S.postId);
        Object.keys(data || {}).forEach(function (k) {
            fd.append(k, data[k]);
        });
        return fetch(S.ajaxUrl, { method: 'POST', body: fd, credentials: 'same-origin' })
            .then(function (r) {
                return r.json().catch(function () {
                    throw new Error('The server returned an unreadable response (HTTP ' + r.status + ').');
                });
            })
            .then(function (j) {
                if (!j || !j.success) {
                    throw new Error((j && j.data && j.data.message) || 'Request failed.');
                }
                return j.data;
            });
    }

    function storageGet(key) {
        try {
            return JSON.parse(window.localStorage.getItem(key) || 'null');
        } catch (e) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            return;
        }
    }

    function dismissed() {
        return storageGet('se-dismissed-' + state.job) || [];
    }

    function hasBlockEditor() {
        return !!(S.blockEditor && window.wp && wp.data && wp.blocks && wp.data.select('core/block-editor'));
    }

    function editorData() {
        if (hasBlockEditor()) {
            var ed = wp.data.select('core/editor');
            return {
                title: ed.getEditedPostAttribute('title') || '',
                content: ed.getEditedPostContent() || '',
                categories: (ed.getEditedPostAttribute('categories') || []).join(','),
                tags: (ed.getEditedPostAttribute('tags') || []).join(',')
            };
        }
        var title = (document.getElementById('title') || {}).value || '';
        var content = '';
        if (window.tinymce && tinymce.get('content') && !tinymce.get('content').isHidden()) {
            content = tinymce.get('content').getContent();
        } else {
            content = (document.getElementById('content') || {}).value || '';
        }
        var cats = Array.prototype.map.call(
            document.querySelectorAll('#categorychecklist input[type=checkbox]:checked'),
            function (i) { return i.value; }
        );
        return { title: title, content: content, categories: cats.join(','), tags: '' };
    }

    function setStatus(text, kind) {
        statusEl.hidden = !text;
        statusEl.className = 'se-status' + (kind ? ' se-status-' + kind : '');
        statusEl.textContent = text || '';
    }

    function setBusy(busy) {
        runBtn.disabled = busy || panel.getAttribute('data-configured') !== '1';
        runBtn.textContent = busy ? 'Working…' : (state.result ? 'Run again' : 'Find stat add-ons');
    }

    function start(fresh) {
        var data = editorData();
        if (!String(data.content).replace(/<[^>]*>/g, '').trim()) {
            setStatus('Write the article first: the tool needs the text to work from.', 'error');
            return;
        }
        setBusy(true);
        setStatus('Sending the article…');
        request('start', {
            title: data.title,
            content: data.content,
            categories: data.categories,
            tags: data.tags,
            focus: focusEl ? focusEl.value.trim() : '',
            fresh: fresh ? '1' : ''
        }).then(function (r) {
            state.job = r.job_id;
            state.startedAt = Date.now();
            poll();
        }).catch(function (e) {
            setBusy(false);
            setStatus(e.message, 'error');
        });
    }

    function poll() {
        if (!state.job) {
            return;
        }
        state.polling = true;
        setBusy(true);
        request('status', { job_id: state.job }).then(function (r) {
            if (r.status === 'queued' || r.status === 'running') {
                var secs = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
                setStatus((STAGES[r.stage] || 'Working') + '…' + (secs ? ' (' + secs + 's)' : ''));
                if (state.startedAt && Date.now() - state.startedAt > 9 * 60 * 1000) {
                    state.polling = false;
                    setBusy(false);
                    setStatus('This is taking much longer than usual. Try again in a minute.', 'error');
                    return;
                }
                window.setTimeout(poll, 2500);
                return;
            }
            state.polling = false;
            state.result = r;
            setBusy(false);
            render();
        }).catch(function (e) {
            state.polling = false;
            setBusy(false);
            setStatus(e.message, 'error');
        });
    }

    var SECTIONS = {
        fix: { title: 'Figures to fix', hint: 'Numbers in your draft that the data disagrees with' },
        writing: { title: 'Writing suggestions', hint: 'Sentences backed by the data, ready to drop into the text' },
        graphic: { title: 'Graphics', hint: 'Full-size infographics for the main points of the story' },
        widget: { title: 'Widgets', hint: 'Small stat strips that sit right after one sentence' },
        table: { title: 'Tables', hint: 'Stats tables for readers who want the detail' }
    };

    var TYPE_NAMES = {
        graphic: ['graphic', 'graphics'],
        widget: ['widget', 'widgets'],
        table: ['table', 'tables'],
        writing: ['writing suggestion', 'writing suggestions'],
        fix: ['figure to fix', 'figures to fix']
    };

    function typeOf(a) {
        if (a.kind === 'table') {
            return 'table';
        }
        return a.size === 'widget' ? 'widget' : 'graphic';
    }

    function plural(key, n) {
        return n + ' ' + TYPE_NAMES[key][n === 1 ? 0 : 1];
    }

    function openState() {
        return storageGet('se-open') || {};
    }

    function section(key, count, sub, children) {
        var meta = SECTIONS[key];
        var saved = openState();
        var el = h('details', { class: 'se-section se-section-' + key, id: 'se-section-' + key, open: saved[key] === false ? null : true }, [
            h('summary', { class: 'se-section-head' }, [
                h('span', { class: 'se-section-name', text: meta.title }),
                h('span', { class: 'se-count', text: String(count) }),
                h('span', { class: 'se-section-sub', text: sub || meta.hint })
            ]),
            h('div', { class: 'se-section-body' }, children)
        ]);
        el.addEventListener('toggle', function () {
            var o = openState();
            o[key] = el.open;
            storageSet('se-open', o);
        });
        return el;
    }

    function liveAddons(r) {
        var gone = dismissed();
        return (r.addons || []).filter(function (a) { return !a.replaced_by && gone.indexOf(a.id) < 0; });
    }

    function render() {
        var r = state.result;
        resultsEl.innerHTML = '';
        if (!r) {
            return;
        }
        if (r.status === 'failed') {
            setStatus(r.error || 'Something went wrong.', 'error');
            return;
        }
        if (r.status === 'no_data') {
            setStatus(r.error || 'No stat add-ons for this article.', 'info');
            return;
        }
        setStatus('');
        var gone = dismissed();
        var live = liveAddons(r);
        resultsEl.appendChild(summary(r, live));
        var checks = checksSection(r.checks || []);
        if (checks) {
            resultsEl.appendChild(checks);
        }
        var sugg = suggestionsSection(r.suggestions || []);
        if (sugg) {
            resultsEl.appendChild(sugg);
        }
        ['graphic', 'widget', 'table'].forEach(function (key) {
            var items = live.filter(function (a) { return typeOf(a) === key; });
            if (!items.length) {
                return;
            }
            var main = items.filter(function (a) { return a.tier === 'suggested'; });
            var extra = items.filter(function (a) { return a.tier !== 'suggested'; });
            var kids = [];
            if (main.length) {
                kids.push(h('div', { class: 'se-cards' }, main.map(card)));
            }
            if (extra.length) {
                kids.push(h('details', { class: 'se-more', open: main.length ? null : true }, [
                    h('summary', { text: 'Also possible (' + extra.length + '): these sit close to another add-on' }),
                    h('div', { class: 'se-cards' }, extra.map(card))
                ]));
            }
            resultsEl.appendChild(section(key, items.length, null, kids));
        });
        if (!live.length) {
            resultsEl.appendChild(h('p', { class: 'se-empty', text: r.skipped_reason || 'No graphics were good enough to suggest for this draft. Ask for one below.' }));
        }
        resultsEl.appendChild(askBox());
        if (gone.length) {
            resultsEl.appendChild(h('button', {
                type: 'button', class: 'se-link', text: 'Show dismissed (' + gone.length + ')',
                onclick: function () { storageSet('se-dismissed-' + state.job, []); render(); }
            }));
        }
        resultsEl.appendChild(h('p', { class: 'se-foot' }, [
            'Numbers come from the ES stats service (MySportsFeeds, nflverse, Retrosheet) and are computed by code, not written by AI. ',
            h('button', { type: 'button', class: 'se-link', text: 'Run fresh', onclick: function () { start(true); } }),
            ' ignores the saved result.'
        ]));
    }

    function jumpChip(key, n) {
        return h('button', {
            type: 'button', class: 'se-sum-chip se-sum-chip-' + key, text: plural(key, n),
            onclick: function () {
                var el = document.getElementById('se-section-' + key);
                if (el) {
                    el.open = true;
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        });
    }

    function summary(r, live) {
        var gone = dismissed();
        var counts = {
            fix: (r.checks || []).filter(function (c) { return c.status === 'mismatch'; }).length,
            writing: (r.suggestions || []).filter(function (s) { return gone.indexOf(s.id) < 0; }).length,
            graphic: live.filter(function (a) { return typeOf(a) === 'graphic'; }).length,
            widget: live.filter(function (a) { return typeOf(a) === 'widget'; }).length,
            table: live.filter(function (a) { return typeOf(a) === 'table'; }).length
        };
        var chips = ['fix', 'writing', 'graphic', 'widget', 'table'].filter(function (k) { return counts[k]; })
            .map(function (k) { return jumpChip(k, counts[k]); });
        var lines = [];
        if (r.angle) {
            lines.push(h('p', { class: 'se-sum-line' }, [h('strong', { text: 'Angle: ' }), r.angle]));
        }
        if (r.focus) {
            lines.push(h('p', { class: 'se-sum-line' }, [h('strong', { text: 'Your focus: ' }), r.focus]));
        }
        var checked = (r.checks || []).length;
        if (checked && !counts.fix) {
            lines.push(h('p', { class: 'se-sum-line', text: checked === 1 ? 'The figure checked in your draft matches the data.' : 'All ' + checked + ' figures checked in your draft match the data.' }));
        }
        var notes = [];
        if (r.placement && r.placement.early_hook === false && live.some(function (a) { return a.tier === 'suggested'; })) {
            notes.push('None of the add-ons lands in the first quarter of the article, where most readers leave. Consider moving one up.');
        }
        if (r.display_font === 'stand-in') {
            notes.push('Graphics use a stand-in headline font until the Acumin Pro Condensed Black file is added to the service.');
        }
        return h('div', { class: 'se-summary' }, [
            h('div', { class: 'se-sum-row' }, [h('span', { class: 'se-pill', text: (r.league || '').toUpperCase() || 'STATS' })].concat(chips)),
            lines.length ? h('div', { class: 'se-sum-lines' }, lines) : null,
            notes.length ? h('ul', { class: 'se-notes' }, notes.map(function (n) { return h('li', { text: n }); })) : null
        ]);
    }

    function checksSection(checks) {
        var mismatches = checks.filter(function (c) { return c.status === 'mismatch'; });
        var matches = checks.filter(function (c) { return c.status === 'match'; });
        if (!mismatches.length) {
            return null;
        }
        var items = mismatches.map(function (c, ci) {
            var msg = h('p', { class: 'se-msg', hidden: true });
            var fixKey = state.job + ':fix-' + ci;
            return h('div', { class: 'se-check' }, [
                h('div', { class: 'se-card-head' }, [h('span', { class: 'se-pill se-pill-fix', text: 'Figure to fix' })]),
                h('p', { class: 'se-quote', text: '“' + c.quote + '”' }),
                h('p', { class: 'se-check-values' }, [
                    'Your draft: ', h('strong', { text: c.article_value }),
                    ' · The data: ', h('strong', { text: c.data_value || '-' })
                ]),
                c.fix_text ? h('div', { class: 'se-actions' }, [
                    h('button', {
                        type: 'button', class: 'se-btn se-btn-primary',
                        text: used[fixKey] ? 'Fixed ✓' : 'Replace with “' + c.fix_text + '”',
                        onclick: function (ev) {
                            replaceText(c.quote, c.fix_text, c.block, ev.target, msg, fixKey, 'fix');
                        }
                    }),
                    h('button', { type: 'button', class: 'se-btn', text: 'Copy', onclick: function (ev) { copyText(c.fix_text, ev.target); } })
                ]) : null,
                hasBlockEditor() ? h('button', {
                    type: 'button', class: 'se-link', text: 'Find in the article',
                    onclick: function () { jumpTo(c.quote, c.block); }
                }) : null,
                msg
            ]);
        });
        return section('fix', mismatches.length, matches.length + ' of ' + checks.length + ' figures checked match the data',
            [h('div', { class: 'se-check-list' }, items)]);
    }

    function taskBusy(msg) {
        if (state.task) {
            showMsg(msg, 'Another change is still being made. Wait for it to finish.', 'warn');
            return true;
        }
        return false;
    }

    function showCardMsg(id, text, kind) {
        var el = resultsEl.querySelector('[data-addon="' + id + '"]');
        if (!el) {
            return;
        }
        var m = el.querySelector('[data-role="card-msg"]');
        if (m) {
            showMsg(m, text, kind);
        }
        var sec = el.closest('details.se-section');
        if (sec) {
            sec.open = true;
        }
        var more = el.closest('details.se-more');
        if (more) {
            more.open = true;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function runTask(action, data, btn, msg, onDone) {
        if (taskBusy(msg)) {
            return;
        }
        var started = Date.now();
        var finish = function () {
            state.task = false;
            btn.disabled = false;
            setBusy(false);
        };
        state.task = true;
        btn.disabled = true;
        runBtn.disabled = true;
        showMsg(msg, 'Working on it…');
        request(action, Object.assign({ job_id: state.job }, data)).then(function (r) {
            var tick = function () {
                request('task', { job_id: state.job, task_id: r.task_id }).then(function (t) {
                    if (t.status === 'queued' || t.status === 'running') {
                        showMsg(msg, 'Working on it… ' + Math.round((Date.now() - started) / 1000) + 's');
                        if (Date.now() - started > 5 * 60 * 1000) {
                            finish();
                            showMsg(msg, 'This is taking much longer than usual. Try again in a minute.', 'error');
                            return;
                        }
                        window.setTimeout(tick, 2500);
                        return;
                    }
                    finish();
                    if (t.status !== 'done' || !t.result) {
                        showMsg(msg, t.error || 'The change could not be made.', 'error');
                        return;
                    }
                    state.result = t.result;
                    render();
                    if (onDone) {
                        onDone(t.addon_ids || []);
                    }
                }).catch(function (e) {
                    finish();
                    showMsg(msg, e.message, 'error');
                });
            };
            tick();
        }).catch(function (e) {
            finish();
            showMsg(msg, e.message, 'error');
        });
    }

    function undoChange(a, btn, msg) {
        if (taskBusy(msg)) {
            return;
        }
        btn.disabled = true;
        request('undo', { job_id: state.job, addon_id: a.id }).then(function (r) {
            state.result = r.result;
            render();
            if (a.replaces) {
                showCardMsg(a.replaces, 'Back to the earlier version.', 'ok');
            }
        }).catch(function (e) {
            btn.disabled = false;
            showMsg(msg, e.message, 'error');
        });
    }

    function askBox() {
        var msg = h('p', { class: 'se-msg', hidden: true });
        var ta = h('textarea', {
            rows: '2', class: 'se-input',
            placeholder: 'e.g. “A graphic on the Cowboys’ penalties this season” or “Compare this team with the 2022 Cardinals: 1-3, 15.5 points a game”'
        });
        var btn = h('button', {
            type: 'button', class: 'se-btn se-btn-primary', text: 'Make it',
            onclick: function () {
                var text = ta.value.trim();
                if (!text) {
                    showMsg(msg, 'Describe the graphic you want first.', 'warn');
                    return;
                }
                runTask('more', { request: text }, btn, msg, function (ids) {
                    if (ids.length) {
                        showCardMsg(ids[0], 'Here is the graphic you asked for.', 'ok');
                    }
                });
            }
        });
        return h('div', { class: 'se-ask' }, [
            h('p', { class: 'se-ask-title', text: 'Ask for another graphic' }),
            h('p', { class: 'se-ask-sub', text: 'Describe what you want: a stat, a span of games, a comparison. You can include your own figures (from a past season, say); graphics that use them are marked so you can double-check them.' }),
            ta,
            h('div', { class: 'se-actions' }, [btn]),
            msg
        ]);
    }

    var SUGGEST_LABELS = { add: 'Add a stat', sharpen: 'Sharpen a claim', box: 'Key stats box' };

    function suggestionsSection(list) {
        var gone = dismissed();
        var shown = (list || []).filter(function (s) { return gone.indexOf(s.id) < 0; });
        if (!shown.length) {
            return null;
        }
        return section('writing', shown.length, null, [h('div', { class: 'se-suggest-list' }, shown.map(suggestionCard))]);
    }

    function suggestionCard(s) {
        var key = state.job + ':' + s.id;
        var done = !!used[key];
        var msg = h('p', { class: 'se-msg', hidden: true });
        var body;
        if (s.type === 'sharpen') {
            body = h('div', { class: 'se-sg-body' }, [
                h('p', { class: 'se-sg-old' }, [h('span', { class: 'se-sg-tag', text: 'Instead of' }), '“' + s.quote + '”']),
                h('p', { class: 'se-sg-new' }, [h('span', { class: 'se-sg-tag', text: 'Write' }), s.text])
            ]);
        } else if (s.type === 'box') {
            body = h('div', { class: 'se-sg-body se-sg-box' }, [
                h('p', { class: 'se-sg-box-title', text: s.title }),
                h('ul', {}, (s.items || []).map(function (t) { return h('li', { text: t }); }))
            ]);
        } else {
            body = h('div', { class: 'se-sg-body' }, [h('p', { class: 'se-sg-new', text: s.text })]);
        }
        var primary = s.type === 'sharpen' ? 'Replace in article' : (hasBlockEditor() ? 'Insert after paragraph' : 'Insert at cursor');
        var actions = h('div', { class: 'se-actions' }, [
            h('button', {
                type: 'button', class: 'se-btn se-btn-primary', text: done ? 'Done ✓ Use again' : primary,
                onclick: function (ev) { applySuggestion(s, ev.target, msg); }
            }),
            h('button', { type: 'button', class: 'se-btn', text: 'Copy', onclick: function (ev) { copyText(s.text, ev.target); } }),
            h('button', {
                type: 'button', class: 'se-link', text: 'Dismiss',
                onclick: function () {
                    var d = dismissed();
                    d.push(s.id);
                    storageSet('se-dismissed-' + state.job, d);
                    render();
                }
            })
        ]);
        return h('div', { class: 'se-sg' + (done ? ' se-card-used' : ''), 'data-sugg': s.id }, [
            h('div', { class: 'se-card-head' }, [
                h('div', { class: 'se-card-type' }, [
                    h('span', { class: 'se-pill se-pill-writing', text: 'writing' }),
                    h('span', { class: 'se-type-label', text: SUGGEST_LABELS[s.type] || s.label || 'Suggestion' })
                ]),
                s.anchor ? h('button', {
                    type: 'button', class: 'se-where', title: 'Show this spot in the article',
                    onclick: function () { jumpTo(s.quote || s.anchor, s.block); }
                }, [(s.type === 'sharpen' ? 'In: “' : 'After: “') + s.anchor.slice(0, 70) + (s.anchor.length > 70 ? '…' : '') + '”']) : null
            ]),
            body,
            s.why ? h('p', { class: 'se-why', text: s.why }) : null,
            actions,
            msg
        ]);
    }

    var NAMED_PUNCT = { rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', apos: "'", nbsp: ' ' };
    var CODE_PUNCT = [39, 160, 8211, 8212, 8216, 8217, 8220, 8221];

    function decodePunct(html) {
        return String(html).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (m, e) {
            if (e.charAt(0) === '#') {
                var hex = e.charAt(1) === 'x' || e.charAt(1) === 'X';
                var code = hex ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return CODE_PUNCT.indexOf(code) >= 0 ? String.fromCharCode(code) : m;
            }
            var named = NAMED_PUNCT[e.toLowerCase()];
            return named !== undefined ? named : m;
        });
    }

    function looseRegex(find) {
        var src = '';
        var lastSpace = false;
        String(find).trim().split('').forEach(function (ch) {
            var space = /\s/.test(ch);
            if (space) {
                if (!lastSpace) {
                    src += '[\\s\\u00a0]+';
                }
            } else if (/['’‘]/.test(ch)) {
                src += "['’‘]";
            } else if (/["“”]/.test(ch)) {
                src += '["“”]';
            } else if (/[–—-]/.test(ch)) {
                src += '[-–—]';
            } else if (ch === '&') {
                src += '(?:&|&amp;)';
            } else {
                src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            lastSpace = space;
        });
        return new RegExp(src);
    }

    function blockHtml(b) {
        var c = b && b.attributes ? b.attributes.content : null;
        if (c === null || c === undefined) {
            return null;
        }
        if (typeof c === 'string') {
            return c;
        }
        return typeof c.toHTMLString === 'function' ? c.toHTMLString() : String(c);
    }

    function markDone(key, btn, msg, text, kind) {
        used[key] = true;
        btn.disabled = false;
        btn.textContent = kind === 'fix' ? 'Fixed ✓' : 'Done ✓ Use again';
        showMsg(msg, text, 'ok');
        var parts = key.split(':');
        request('log_insert', { job_id: state.job, addon_id: parts[parts.length - 1], template: 'suggestion:' + kind }).catch(function () { return null; });
    }

    function decodeEntity(ent) {
        var t = document.createElement('textarea');
        t.innerHTML = ent;
        return t.value;
    }

    function textMap(html) {
        var text = '', from = [], to = [], i = 0;
        while (i < html.length) {
            var ch = html.charAt(i);
            if (ch === '<') {
                var j = html.indexOf('>', i);
                if (j < 0) {
                    break;
                }
                i = j + 1;
                continue;
            }
            if (ch === '&') {
                var m = /^&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/i.exec(html.slice(i, i + 12));
                if (m) {
                    var d = decodeEntity(m[0]);
                    for (var k = 0; k < d.length; k++) {
                        text += d.charAt(k);
                        from.push(i);
                        to.push(i + m[0].length);
                    }
                    i += m[0].length;
                    continue;
                }
            }
            text += ch;
            from.push(i);
            to.push(i + 1);
            i++;
        }
        return { text: text, from: from, to: to };
    }

    function wordsOf(text) {
        var out = [], re = /[A-Za-z0-9]+(?:['’.\-][A-Za-z0-9]+)*/g, m;
        while ((m = re.exec(text))) {
            out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), s: m.index, e: m.index + m[0].length });
        }
        return out;
    }

    function common(a, b) {
        var count = {}, n = 0;
        a.forEach(function (w) { count[w] = (count[w] || 0) + 1; });
        b.forEach(function (w) {
            if (count[w]) {
                count[w]--;
                n++;
            }
        });
        return n;
    }

    var SMALL_WORDS = ['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
        'has', 'have', 'had', 'be', 'been', 'with', 'by', 'as', 'that', 'this', 'it', 'its', 'his', 'her', 'their', 'so'];

    function closestSpan(text, find, minRecall) {
        var tw = wordsOf(text), qw = wordsOf(find).map(function (x) { return x.w; });
        var key = qw.filter(function (w) { return SMALL_WORDS.indexOf(w) < 0; });
        if (!qw.length || !tw.length || !key.length) {
            return null;
        }
        var best = null;
        for (var len = Math.max(1, qw.length - 2); len <= qw.length * 2 + 1; len++) {
            for (var i = 0; i + len <= tw.length; i++) {
                var win = tw.slice(i, i + len).map(function (x) { return x.w; });
                if (win[0] !== qw[0] && win[len - 1] !== qw[qw.length - 1] && qw.indexOf(win[0]) < 0) {
                    continue;
                }
                if (key.some(function (w) { return win.indexOf(w) < 0; })) {
                    continue;
                }
                var n = common(win, qw);
                var recall = n / qw.length, precision = n / len;
                if (recall < minRecall || precision < 0.5) {
                    continue;
                }
                if (!best || recall > best.recall || (recall === best.recall && precision > best.precision)) {
                    best = { recall: recall, precision: precision, s: tw[i].s, e: tw[i + len - 1].e };
                }
            }
        }
        return best;
    }

    function balanced(fragment) {
        var opens = (fragment.match(/<[a-z][^>]*[^\/]>|<[a-z]>/gi) || []).length;
        var closes = (fragment.match(/<\/[a-z][^>]*>/gi) || []).length;
        return opens === closes;
    }

    function findSpan(html, find, fuzzy) {
        var map = textMap(html);
        var m = looseRegex(find).exec(map.text);
        var span = m ? { s: m.index, e: m.index + m[0].length, exact: true } : null;
        if (!span && fuzzy) {
            var c = closestSpan(map.text, find, fuzzy);
            span = c ? { s: c.s, e: c.e, exact: false } : null;
        }
        if (!span || span.e <= span.s) {
            return null;
        }
        var a = map.from[span.s], b = map.to[span.e - 1];
        if (!balanced(html.slice(a, b))) {
            return null;
        }
        return { a: a, b: b, exact: span.exact, found: map.text.slice(span.s, span.e) };
    }

    function spliced(html, span, replacement) {
        return html.slice(0, span.a) + esc(replacement) + html.slice(span.b);
    }

    function replaceText(find, replacement, blockIndex, btn, msg, key, kind) {
        var done = function (span) {
            markDone(key, btn, msg, span.exact ? 'Replaced in the article.' : 'The words had changed, so the closest match was replaced: “' + span.found + '”. Undo if that’s wrong.', kind);
        };
        if (hasBlockEditor()) {
            var blocks = wp.data.select('core/block-editor').getBlocks();
            var first = findIndex(find, blockIndex);
            var order = [first];
            for (var i = 0; i < blocks.length; i++) {
                if (order.indexOf(i) < 0) {
                    order.push(i);
                }
            }
            var near = [first, first - 1, first + 1].filter(function (x) { return x >= 0 && x < blocks.length; });
            var passes = [{ list: order, fuzzy: 0 }, { list: near, fuzzy: 0.8 }];
            for (var p = 0; p < passes.length; p++) {
                for (var k = 0; k < passes[p].list.length; k++) {
                    var b = blocks[passes[p].list[k]];
                    var html = blockHtml(b);
                    if (!html) {
                        continue;
                    }
                    html = decodePunct(html);
                    var span = findSpan(html, find, passes[p].fuzzy);
                    if (span) {
                        wp.data.dispatch('core/block-editor').updateBlockAttributes(b.clientId, { content: spliced(html, span, replacement) });
                        wp.data.dispatch('core/block-editor').selectBlock(b.clientId);
                        scrollToBlock(b.clientId);
                        done(span);
                        return;
                    }
                }
            }
            showMsg(msg, 'Those words are no longer in the article. Use Copy instead.', 'error');
            return;
        }
        var classic = window.tinymce && tinymce.get('content') && !tinymce.get('content').isHidden() ? tinymce.get('content') : null;
        var ta = classic ? null : document.getElementById('content');
        var content = classic ? decodePunct(classic.getContent()) : (ta ? decodePunct(ta.value) : '');
        var spanC = content ? (findSpan(content, find, 0) || findSpan(content, find, 0.9)) : null;
        if (spanC) {
            var out = spliced(content, spanC, replacement);
            if (classic) {
                classic.setContent(out);
            } else {
                ta.value = out;
            }
            done(spanC);
            return;
        }
        showMsg(msg, 'Those words are no longer in the article. Use Copy instead.', 'error');
    }

    function applySuggestion(s, btn, msg) {
        var key = state.job + ':' + s.id;
        if (s.type === 'sharpen') {
            replaceText(s.quote, s.text, s.block, btn, msg, key, s.type);
            return;
        }
        if (!hasBlockEditor()) {
            if (classicInsert(s.html || esc(s.text))) {
                markDone(key, btn, msg, 'Inserted at the cursor.', s.type);
            } else {
                showMsg(msg, 'Couldn’t reach the editor. Use Copy instead.', 'error');
            }
            return;
        }
        var newBlocks;
        if (s.type === 'box') {
            newBlocks = [
                wp.blocks.createBlock('core/paragraph', { content: '<strong>' + esc(s.title) + '</strong>' }),
                wp.blocks.createBlock('core/list', {}, (s.items_html || []).map(function (li) {
                    return wp.blocks.createBlock('core/list-item', { content: li });
                }))
            ];
        } else {
            newBlocks = [wp.blocks.createBlock('core/paragraph', { content: s.html || esc(s.text) })];
        }
        var index = findIndex(s.anchor, s.block);
        wp.data.dispatch('core/block-editor').insertBlocks(newBlocks, index + 1, undefined, true);
        window.setTimeout(function () { scrollToBlock(newBlocks[0].clientId); }, 150);
        markDone(key, btn, msg, 'Inserted after the paragraph.', s.type);
    }

    function copyText(text, btn) {
        var done = function () {
            var old = btn.textContent;
            btn.textContent = 'Copied';
            window.setTimeout(function () { btn.textContent = old; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function () { window.prompt('Copy the text:', text); });
        } else {
            window.prompt('Copy the text:', text);
        }
    }

    function sourceLine(a) {
        var feeds = [];
        (a.sources || []).forEach(function (s) {
            var label = FEED_LABELS[s.feed] || s.feed;
            if (feeds.indexOf(label) < 0) {
                feeds.push(label);
            }
        });
        return (a.source_line || '') + (feeds.length ? ' · ' + feeds.join(', ') : '');
    }

    function preview(a) {
        if (a.kind === 'image' && a.image) {
            return h('a', { href: a.image.url, target: '_blank', rel: 'noopener', class: 'se-preview' }, [
                h('img', { src: a.image.url, alt: a.alt || '', loading: 'lazy' })
            ]);
        }
        if (a.kind === 'table' && a.table) {
            return h('div', { class: 'se-table-wrap' }, [
                h('table', { class: 'se-table' }, [
                    h('thead', {}, [h('tr', {}, a.table.header.map(function (c) { return h('th', { text: c }); }))]),
                    h('tbody', {}, a.table.body.map(function (row) {
                        return h('tr', {}, row.map(function (c) { return h('td', { text: c }); }));
                    }))
                ])
            ]);
        }
        return null;
    }

    function fieldsFor(a) {
        if (a.kind === 'table') {
            return [['caption', 'Caption']];
        }
        if (a.size === 'widget') {
            return [['kicker', 'Kicker'], ['caption', 'Caption under the image'], ['alt', 'Alt text']];
        }
        var f = [['kicker', 'Kicker'], ['headline', 'Headline'], ['headline_accent', 'Headline accent (blue)']];
        if (['bar_series', 'compare_bars', 'leaderboard'].indexOf(a.template) >= 0 || (a.text && a.text.subhead)) {
            f.push(['subhead', 'Subhead']);
        }
        f.push(['caption', 'Caption under the image'], ['alt', 'Alt text']);
        return f;
    }

    function quickPicks(a) {
        var nfl = (state.result && state.result.league) === 'nfl';
        var games = ['Use only the last 3 games', 'Use the last 5 games', 'Show every game this season'];
        var picks = {
            series: games.concat(nfl ? ['Highlight Weeks … to …', 'Label each bar with the starting QB'] : ['Label each game with who was missing']),
            form: ['Use the last 3 games', 'Use the last 8 games'],
            split: ['Change the games on each side: …'],
            stat: ['Use a more telling stat than the season total', 'Compare with the league average', 'Per game instead of the season total'],
            rank: ['Per game instead of the season total', 'Rank all players, not one position', 'Use a more telling stat'],
            versus: ['Per game instead of totals', 'Compare with last season instead', 'Use these stats: …'],
            compare: ['Per game instead of totals', 'Add last season for comparison'],
            key_numbers: ['Use more telling stats', 'Use these numbers: …'],
            table: ['Only the last 5 games', 'Fewer columns: keep …'],
            status: [],
            context: [],
            claim: ['Use different numbers: …', 'Quote a different line: …', 'Make the verdict more cautious'],
            turning_point: ['Split at a different date: …', 'Show more games before', 'Use a different stat: …'],
            history: ['Use a different stat: …', 'Go back fewer seasons']
        };
        return picks[a.recipe] || [];
    }

    function changeBox(a) {
        var msg = h('p', { class: 'se-msg', hidden: true });
        var ta = h('textarea', {
            rows: '2', class: 'se-input',
            placeholder: 'e.g. “Use Weeks 8 to 10 and label each bar with the starting QB”'
        });
        var chips = quickPicks(a).map(function (p) {
            return h('button', {
                type: 'button', class: 'se-chip', text: p,
                onclick: function () {
                    ta.value = p.replace('…', '').trim() + (p.indexOf('…') >= 0 ? ' ' : '');
                    ta.focus();
                }
            });
        });
        var btn = h('button', {
            type: 'button', class: 'se-btn se-btn-primary', text: 'Make this change',
            onclick: function () {
                var text = ta.value.trim();
                if (!text) {
                    showMsg(msg, 'Say what you want changed first.', 'warn');
                    return;
                }
                runTask('revise', { addon_id: a.id, request: text }, btn, msg, function (ids) {
                    if (ids.length) {
                        showCardMsg(ids[0], 'Changed. Undo brings back the earlier version.', 'ok');
                    }
                });
            }
        });
        return h('details', { class: 'se-change' }, [
            h('summary', { text: 'Change this ' + (typeOf(a) === 'table' ? 'table' : typeOf(a) === 'widget' ? 'widget' : 'graphic') }),
            h('p', { class: 'se-change-sub', text: 'Tell the tool what to change: the games, the stat, a comparison, labels. It redraws it from the same data with the same number checks, in about half a minute.' }),
            chips.length ? h('div', { class: 'se-chips' }, chips) : null,
            ta,
            h('div', { class: 'se-actions' }, [btn]),
            msg
        ]);
    }

    function card(a) {
        var key = state.job + ':' + a.id;
        var inserted = !!used[key];
        var msg = h('p', { class: 'se-msg', hidden: true, 'data-role': 'card-msg' });
        var inputs = {};
        var type = typeOf(a);
        var editor = h('details', { class: 'se-edit' }, [h('summary', { text: 'Edit the words' })]);
        fieldsFor(a).forEach(function (f) {
            var value = f[0] === 'caption' ? (a.caption || (a.text && a.text.caption) || '')
                : f[0] === 'alt' ? (a.alt || (a.text && a.text.alt) || '')
                : ((a.text && a.text[f[0]]) || '');
            var input = f[0] === 'subhead' || f[0] === 'alt' || f[0] === 'caption'
                ? h('textarea', { rows: '2' })
                : h('input', { type: 'text' });
            input.value = value;
            inputs[f[0]] = input;
            editor.appendChild(h('label', { class: 'se-field' }, [h('span', { text: f[1] }), input]));
        });
        if (a.kind === 'image') {
            editor.appendChild(h('button', {
                type: 'button', class: 'se-btn', text: 'Update graphic',
                onclick: function (ev) { rerender(a, inputs, ev.target, msg); }
            }));
        }

        var where = a.placement || {};
        var actions = h('div', { class: 'se-actions' }, [
            h('button', {
                type: 'button', class: 'se-btn se-btn-primary', text: inserted ? 'Inserted ✓ Insert again' : 'Insert at suggested spot',
                onclick: function (ev) { insert(a, inputs, 'suggested', ev.target, msg); }
            }),
            hasBlockEditor() ? h('button', {
                type: 'button', class: 'se-btn', text: 'Insert after selected block',
                onclick: function (ev) { insert(a, inputs, 'selected', ev.target, msg); }
            }) : null,
            h('button', {
                type: 'button', class: 'se-btn', text: 'Copy HTML',
                onclick: function (ev) { copyHtml(a, ev.target); }
            }),
            h('button', {
                type: 'button', class: 'se-link', text: 'Dismiss',
                onclick: function () {
                    var d = dismissed();
                    d.push(a.id);
                    storageSet('se-dismissed-' + state.job, d);
                    render();
                }
            })
        ]);

        var badges = [];
        if (a.request) {
            badges.push(h('p', { class: 'se-badge se-badge-request' }, [
                h('strong', { text: a.replaces ? 'Changed: ' : 'You asked: ' }), '“' + a.request + '” ',
                h('button', {
                    type: 'button', class: 'se-link', text: a.replaces ? 'Undo' : 'Remove',
                    onclick: function (ev) { undoChange(a, ev.target, msg); }
                })
            ]));
        }
        if (a.writer_figures) {
            badges.push(h('p', { class: 'se-badge se-badge-writer', text: 'Uses your own figures. They are not checked against the data, so double-check them.' }));
        }

        return h('div', { class: 'se-card se-card-' + type + (inserted ? ' se-card-used' : ''), 'data-addon': a.id }, [
            h('div', { class: 'se-card-head' }, [
                h('div', { class: 'se-card-type' }, [
                    h('span', { class: 'se-pill se-pill-' + type, text: TYPE_NAMES[type][0] }),
                    h('span', { class: 'se-type-label', text: TEMPLATE_LABELS[a.template] || a.template })
                ]),
                where.anchor ? h('button', {
                    type: 'button', class: 'se-where', title: 'Show this spot in the article',
                    onclick: function () { jumpTo(where.anchor, where.after_block); }
                }, ['Goes after: “' + where.anchor.slice(0, 70) + (where.anchor.length > 70 ? '…' : '') + '”']) : null
            ]),
            badges.length ? h('div', { class: 'se-badges' }, badges) : null,
            preview(a),
            h('p', { class: 'se-why', text: a.why }),
            actions,
            changeBox(a),
            editor,
            msg,
            h('p', { class: 'se-source', text: sourceLine(a) })
        ]);
    }

    function showMsg(msg, text, kind) {
        msg.hidden = !text;
        msg.className = 'se-msg' + (kind ? ' se-msg-' + kind : '');
        msg.textContent = text || '';
    }

    function currentText(inputs) {
        var out = {};
        Object.keys(inputs).forEach(function (k) {
            out[k] = inputs[k].value;
        });
        return out;
    }

    function rerender(a, inputs, btn, msg) {
        btn.disabled = true;
        showMsg(msg, 'Redrawing…');
        request('render', { job_id: state.job, addon_id: a.id, text: JSON.stringify(currentText(inputs)) })
            .then(function (r) {
                var idx = state.result.addons.findIndex(function (x) { return x.id === a.id; });
                if (idx >= 0) {
                    state.result.addons[idx] = r.addon;
                }
                render();
                var cardEl = resultsEl.querySelector('[data-addon="' + a.id + '"] .se-msg');
                if (cardEl) {
                    showMsg(cardEl, r.warnings && r.warnings.length
                        ? 'Updated. Check: ' + r.warnings.join('; ')
                        : 'Updated.', r.warnings && r.warnings.length ? 'warn' : 'ok');
                }
            })
            .catch(function (e) {
                btn.disabled = false;
                showMsg(msg, e.message, 'error');
            });
    }

    function blockText(block) {
        var html = '';
        try {
            html = wp.blocks.getBlockContent(block);
        } catch (e) {
            html = '';
        }
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var text = doc.body.textContent || '';
        var img = doc.querySelector('img');
        if (!text.trim() && img) {
            text = img.getAttribute('alt') || '';
        }
        return norm(text);
    }

    function findIndex(anchor, fallbackIndex) {
        var blocks = wp.data.select('core/block-editor').getBlocks();
        var a = norm(anchor);
        var texts = blocks.map(blockText);
        var probes = [a.slice(0, 60), a.slice(0, 35)];
        for (var p = 0; p < probes.length; p++) {
            if (!probes[p]) {
                continue;
            }
            for (var i = 0; i < texts.length; i++) {
                if (texts[i].indexOf(probes[p]) === 0 || texts[i].indexOf(probes[p]) > -1) {
                    return i;
                }
            }
        }
        if (typeof fallbackIndex === 'number') {
            var seen = -1;
            for (var j = 0; j < blocks.length; j++) {
                if (texts[j] || blocks[j].name === 'core/image') {
                    seen++;
                }
                if (seen === fallbackIndex) {
                    return j;
                }
            }
        }
        return blocks.length - 1;
    }

    function scrollToBlock(clientId) {
        var sel = '[data-block="' + clientId + '"]';
        var el = document.querySelector(sel);
        if (!el) {
            var frame = document.querySelector('iframe[name="editor-canvas"]');
            if (frame && frame.contentDocument) {
                el = frame.contentDocument.querySelector(sel);
            }
        }
        if (el && el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function jumpTo(anchor, index) {
        if (!hasBlockEditor()) {
            return;
        }
        var blocks = wp.data.select('core/block-editor').getBlocks();
        var i = findIndex(anchor, index);
        var b = blocks[i];
        if (b) {
            wp.data.dispatch('core/block-editor').selectBlock(b.clientId);
            scrollToBlock(b.clientId);
        }
    }

    function tableBlock(a, caption) {
        return wp.blocks.createBlock('core/table', {
            hasFixedLayout: false,
            head: [{ cells: a.table.header.map(function (c) { return { content: esc(c), tag: 'th' }; }) }],
            body: a.table.body.map(function (row) {
                return { cells: row.map(function (c) { return { content: esc(c), tag: 'td' }; }) };
            }),
            caption: esc(caption)
        });
    }

    function insertBlockAt(block, mode, a) {
        var be = wp.data.select('core/block-editor');
        var blocks = be.getBlocks();
        var index;
        if (mode === 'selected') {
            var sel = be.getSelectedBlockClientId();
            var root = sel ? be.getBlockHierarchyRootClientId(sel) : null;
            index = root ? be.getBlockIndex(root) : blocks.length - 1;
        } else {
            index = findIndex((a.placement || {}).anchor, (a.placement || {}).after_block);
        }
        wp.data.dispatch('core/block-editor').insertBlocks(block, index + 1, undefined, true);
        window.setTimeout(function () { scrollToBlock(block.clientId); }, 150);
    }

    function classicInsert(html) {
        if (typeof window.send_to_editor === 'function') {
            window.send_to_editor(html);
            return true;
        }
        var ta = document.getElementById('content');
        if (ta) {
            ta.value += '\n' + html;
            return true;
        }
        return false;
    }

    function markUsed(a, btn, msg, text) {
        used[state.job + ':' + a.id] = true;
        btn.disabled = false;
        btn.textContent = 'Inserted ✓ Insert again';
        var cardEl = resultsEl.querySelector('[data-addon="' + a.id + '"]');
        if (cardEl) {
            cardEl.classList.add('se-card-used');
        }
        showMsg(msg, text, 'ok');
    }

    function insert(a, inputs, mode, btn, msg) {
        var text = currentText(inputs);
        var caption = text.caption !== undefined ? text.caption : (a.caption || '');
        var alt = text.alt !== undefined ? text.alt : (a.alt || '');
        btn.disabled = true;
        if (a.kind === 'table') {
            if (hasBlockEditor()) {
                insertBlockAt(tableBlock(a, caption), mode, a);
            } else {
                classicInsert(a.html);
            }
            request('log_insert', { job_id: state.job, addon_id: a.id, template: a.template }).catch(function () { return null; });
            markUsed(a, btn, msg, 'Table inserted.');
            return;
        }
        showMsg(msg, 'Adding the image to the media library…');
        request('insert_image', { job_id: state.job, addon_id: a.id, alt: alt, caption: caption })
            .then(function (img) {
                if (hasBlockEditor()) {
                    insertBlockAt(wp.blocks.createBlock('core/image', {
                        id: img.id,
                        url: img.url,
                        alt: alt,
                        caption: esc(caption),
                        sizeSlug: 'large',
                        linkDestination: 'none'
                    }), mode, a);
                } else {
                    var tag = '<img class="size-large wp-image-' + img.id + '" src="' + esc(img.url) + '" alt="' + esc(alt) + '"'
                        + (img.width ? ' width="' + img.width + '" height="' + img.height + '"' : '') + ' />';
                    classicInsert(caption
                        ? '[caption id="attachment_' + img.id + '" align="alignnone" width="' + (img.width || 1200) + '"]' + tag + ' ' + esc(caption) + '[/caption]'
                        : tag);
                }
                markUsed(a, btn, msg, 'Inserted. The image is in the media library.');
            })
            .catch(function (e) {
                btn.disabled = false;
                showMsg(msg, e.message, 'error');
            });
    }

    function copyHtml(a, btn) {
        var html = a.html || '';
        var done = function () {
            var old = btn.textContent;
            btn.textContent = 'Copied';
            window.setTimeout(function () { btn.textContent = old; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(html).then(done).catch(function () { window.prompt('Copy the HTML:', html); });
        } else {
            window.prompt('Copy the HTML:', html);
        }
    }

    var focusEl = document.getElementById('se-focus');
    if (!focusEl) {
        focusEl = h('textarea', {
            id: 'se-focus', rows: '2', class: 'se-input', maxlength: '400',
            placeholder: 'e.g. “penalties and fines”, “Weeks 8 to 10, a different QB each week”, “compare with the 2022 Cardinals: 1-3, 15.5 points a game”'
        });
        var head = panel.querySelector('.se-head');
        var wrap = h('label', { class: 'se-focus' }, [
            h('span', { class: 'se-focus-label', text: 'Focus (optional)' }),
            h('span', { class: 'se-focus-hint', text: 'Tell the tool what the graphics should be about: the angle, the games, a comparison. You can add your own figures.' }),
            focusEl
        ]);
        if (head && head.parentNode) {
            head.parentNode.insertBefore(wrap, head.nextSibling);
        }
    }
    var focusKey = 'se-focus-' + S.postId;
    if (!focusEl.value) {
        focusEl.value = storageGet(focusKey) || '';
    }
    focusEl.addEventListener('input', function () { storageSet(focusKey, focusEl.value); });

    runBtn.addEventListener('click', function () { start(false); });
    setBusy(false);
    if (state.job) {
        poll();
    }
})();
