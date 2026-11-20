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
    var state = { job: S.jobId || '', result: null, polling: false, startedAt: 0 };
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
        fetch: 'Pulling stats from MySportsFeeds',
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
        table: 'Stats table'
    };

    var FEED_LABELS = {
        player_gamelogs: 'player game logs',
        team_gamelogs: 'team game logs',
        team_games: 'schedule and results',
        player_totals: 'player season totals',
        league_player_totals: 'league player totals',
        league_team_totals: 'league team totals',
        standings: 'standings',
        injuries: 'injury report'
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
        var addons = (r.addons || []).filter(function (a) { return gone.indexOf(a.id) < 0; });
        var suggested = addons.filter(function (a) { return a.tier === 'suggested'; });
        var extra = addons.filter(function (a) { return a.tier !== 'suggested'; });

        resultsEl.appendChild(summary(r, suggested, extra));
        var checks = checksSection(r.checks || []);
        if (checks) {
            resultsEl.appendChild(checks);
        }
        var sugg = suggestionsSection(r.suggestions || []);
        if (sugg) {
            resultsEl.appendChild(sugg);
        }
        if (addons.length) {
            resultsEl.appendChild(h('p', { class: 'se-section-title', text: 'Graphics' }));
        }
        if (!addons.length) {
            resultsEl.appendChild(h('p', { class: 'se-empty', text: r.skipped_reason || 'No add-ons were good enough to suggest for this draft.' }));
        }
        var list = h('div', { class: 'se-cards' }, suggested.map(card));
        resultsEl.appendChild(list);
        if (extra.length) {
            var more = h('details', { class: 'se-more' }, [
                h('summary', { text: 'More options (' + extra.length + '): these sit close to another add-on' }),
                h('div', { class: 'se-cards' }, extra.map(card))
            ]);
            resultsEl.appendChild(more);
        }
        if (gone.length) {
            resultsEl.appendChild(h('button', {
                type: 'button', class: 'se-link', text: 'Show dismissed (' + gone.length + ')',
                onclick: function () { storageSet('se-dismissed-' + state.job, []); render(); }
            }));
        }
        resultsEl.appendChild(h('p', { class: 'se-foot' }, [
            'Numbers come from MySportsFeeds and are computed by code, not written by AI. ',
            h('button', { type: 'button', class: 'se-link', text: 'Run fresh', onclick: function () { start(true); } }),
            ' ignores the saved result.'
        ]));
    }

    function summary(r, suggested, extra) {
        var bits = [];
        bits.push(h('span', { class: 'se-pill', text: (r.league || '').toUpperCase() || 'STATS' }));
        var edits = (r.suggestions || []).length;
        bits.push(h('span', { class: 'se-sum-text', text: suggested.length + (suggested.length === 1 ? ' graphic' : ' graphics')
            + (extra.length ? ', ' + extra.length + ' more' : '') + (edits ? ' · ' + edits + (edits === 1 ? ' writing suggestion' : ' writing suggestions') : '') }));
        var notes = [];
        if (r.placement && r.placement.early_hook === false && suggested.length) {
            notes.push('None of the suggestions lands in the first quarter of the article, where most readers leave. Consider moving one up.');
        }
        if (r.display_font === 'stand-in') {
            notes.push('Graphics use a stand-in headline font until the Acumin Pro Condensed Black file is added to the service.');
        }
        return h('div', { class: 'se-summary' }, [
            h('div', { class: 'se-sum-row' }, bits),
            notes.length ? h('ul', { class: 'se-notes' }, notes.map(function (n) { return h('li', { text: n }); })) : null
        ]);
    }

    function checksSection(checks) {
        var mismatches = checks.filter(function (c) { return c.status === 'mismatch'; });
        var matches = checks.filter(function (c) { return c.status === 'match'; });
        if (!checks.length) {
            return null;
        }
        var box = h('div', { class: 'se-checks' + (mismatches.length ? ' se-checks-warn' : '') }, [
            h('div', { class: 'se-checks-head' }, [
                h('strong', { text: mismatches.length ? 'Check these figures' : 'Figures checked' }),
                h('span', { text: matches.length + ' of ' + checks.length + ' match MySportsFeeds' })
            ])
        ]);
        mismatches.forEach(function (c, ci) {
            var msg = h('p', { class: 'se-msg', hidden: true });
            var fixKey = state.job + ':fix-' + ci;
            box.appendChild(h('div', { class: 'se-check' }, [
                h('p', { class: 'se-quote', text: '“' + c.quote + '”' }),
                h('p', { class: 'se-check-values' }, [
                    'Article: ', h('strong', { text: c.article_value }),
                    ' · MySportsFeeds: ', h('strong', { text: c.data_value || '-' })
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
            ]));
        });
        return box;
    }

    var SUGGEST_LABELS = { add: 'Add a stat', sharpen: 'Sharpen a claim', box: 'Key stats box' };

    function suggestionsSection(list) {
        var gone = dismissed();
        var shown = (list || []).filter(function (s) { return gone.indexOf(s.id) < 0; });
        if (!shown.length) {
            return null;
        }
        return h('div', { class: 'se-suggest' }, [
            h('div', { class: 'se-suggest-head' }, [
                h('strong', { text: 'Writing suggestions' }),
                h('span', { text: shown.length + (shown.length === 1 ? ' edit' : ' edits') + ' backed by the data' })
            ]),
            h('div', { class: 'se-suggest-list' }, shown.map(suggestionCard))
        ]);
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
                h('span', { class: 'se-pill', text: SUGGEST_LABELS[s.type] || s.label || 'Suggestion' }),
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

    function replaceText(find, replacement, blockIndex, btn, msg, key, kind) {
        var re = looseRegex(find);
        if (hasBlockEditor()) {
            var blocks = wp.data.select('core/block-editor').getBlocks();
            var order = [findIndex(find, blockIndex)];
            for (var i = 0; i < blocks.length; i++) {
                if (order.indexOf(i) < 0) {
                    order.push(i);
                }
            }
            for (var k = 0; k < order.length; k++) {
                var b = blocks[order[k]];
                var html = blockHtml(b);
                html = html === null ? null : decodePunct(html);
                if (html && re.test(html)) {
                    wp.data.dispatch('core/block-editor').updateBlockAttributes(b.clientId, { content: html.replace(re, esc(replacement)) });
                    wp.data.dispatch('core/block-editor').selectBlock(b.clientId);
                    scrollToBlock(b.clientId);
                    markDone(key, btn, msg, 'Replaced in the article.', kind);
                    return;
                }
            }
            showMsg(msg, 'Couldn’t find those exact words in the article; they may have been edited. Use Copy instead.', 'error');
            return;
        }
        if (window.tinymce && tinymce.get('content') && !tinymce.get('content').isHidden()) {
            var ed = tinymce.get('content');
            var content = decodePunct(ed.getContent());
            if (re.test(content)) {
                ed.setContent(content.replace(re, esc(replacement)));
                markDone(key, btn, msg, 'Replaced in the article.', kind);
                return;
            }
        } else {
            var ta = document.getElementById('content');
            if (ta && re.test(decodePunct(ta.value))) {
                ta.value = decodePunct(ta.value).replace(re, esc(replacement));
                markDone(key, btn, msg, 'Replaced in the article.', kind);
                return;
            }
        }
        showMsg(msg, 'Couldn’t find those exact words in the article; they may have been edited. Use Copy instead.', 'error');
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
        return (a.source_line || 'Data: MySportsFeeds') + (feeds.length ? ' · ' + feeds.join(', ') : '');
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

    function card(a) {
        var key = state.job + ':' + a.id;
        var inserted = !!used[key];
        var msg = h('p', { class: 'se-msg', hidden: true });
        var inputs = {};
        var editor = h('details', { class: 'se-edit' }, [h('summary', { text: 'Edit text' })]);
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

        return h('div', { class: 'se-card' + (inserted ? ' se-card-used' : ''), 'data-addon': a.id }, [
            h('div', { class: 'se-card-head' }, [
                h('span', { class: 'se-pill', text: TEMPLATE_LABELS[a.template] || a.template }),
                where.anchor ? h('button', {
                    type: 'button', class: 'se-where', title: 'Show this spot in the article',
                    onclick: function () { jumpTo(where.anchor, where.after_block); }
                }, ['Goes after: “' + where.anchor.slice(0, 70) + (where.anchor.length > 70 ? '…' : '') + '”']) : null
            ]),
            preview(a),
            h('p', { class: 'se-why', text: a.why }),
            editor,
            actions,
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

    runBtn.addEventListener('click', function () { start(false); });
    setBusy(false);
    if (state.job) {
        poll();
    }
})();
