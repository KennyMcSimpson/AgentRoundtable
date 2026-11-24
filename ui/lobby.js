/* ui/lobby.js - AgentRoundtable Multi-Room Studio Lobby served by lib/lobby.mjs.
 * Plain ES2020 classic script, zero build step, zero framework, zero innerHTML, zero web storage.
 *
 *   GET  /lobby/api/meta, /lobby/api/rooms, /lobby/api/seat-defaults?id=&seat=   (no token)
 *   GET  /lobby/api/stream                                                       (SSE, no token)
 *   POST /lobby/api/create | open | stop | task | start | folder                 JSON {token, ...}
 *
 * The lobby token is read once from the URL fragment (#<token>) and immediately scrubbed with
 * history.replaceState. It lives strictly in memory and travels only inside POST JSON bodies.
 */
(function () {
  'use strict';

  var ROLE_SHORT = { lead: 'Lead', executor: 'Executor', reviewer: 'Reviewer', participant: 'Participant' };
  var WAIT_SHORT = { background: 'Background wait', turn_over: 'Turn-over wait', manual: 'Manual wait', hosted: 'Hosted' };
  var PHASE_LABEL = { idle: 'Idle', work: 'Work', meet: 'Meet', summary: 'Summary', assign: 'Assign', reconcile: 'Reconcile', done: 'Done', closed: 'Closed' };
  var CODEX_AGENTS = { 'codex-desktop': 1, 'codex-cli': 1 };
  var HOSTED_PI = 'hosted-pi';
  var ID_RE = /^[A-Za-z0-9_-]+$/;

  var app = { token: '', meta: null, rooms: [], view: 'rooms', taskOpen: Object.create(null), pollTimer: null, seq: 0, lang: 'en', theme: 'light', sse: null, sseConnected: false, daemon: null };

  function tUi(key, params, fallback) {
    if (typeof globalThis !== 'undefined' && globalThis.RoomI18n && typeof globalThis.RoomI18n.t === 'function') {
      return globalThis.RoomI18n.t(app.lang, key, params);
    }
    return fallback !== undefined ? fallback : key;
  }

  function detectInitialTheme() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { /* ignore */ }
    }
    return 'light';
  }
  function applyTheme(next) {
    app.theme = next === 'dark' ? 'dark' : 'light';
    if (document.documentElement) {
      if (document.documentElement.dataset) document.documentElement.dataset.theme = app.theme;
      else if (typeof document.documentElement.setAttribute === 'function') document.documentElement.setAttribute('data-theme', app.theme);
    }
    var btn = $('btn-theme');
    if (btn) {
      btn.textContent = app.theme === 'dark' ? tUi('theme.light', null, 'Light') : tUi('theme.dark', null, 'Dark');
      btn.title = tUi('theme.toggleTitle', null, 'Toggle light / dark theme');
    }
  }

  function updateDaemonBadge(daemon) {
    if (daemon) app.daemon = daemon;
    var el = $('hdr-daemon');
    if (!el) return;
    if (!app.daemon || app.daemon.mode !== 'daemon') { el.classList.add('hidden'); return; }
    var text = tUi('hdr.daemon.badge', null, 'Daemon Mode') + ' · ' + tUi('hdr.daemon.open', { n: app.daemon.openRooms || 0 }, (app.daemon.openRooms || 0) + ' running');
    if (app.daemon.resumedRooms && app.daemon.resumedRooms.length) {
      text += ' · ' + tUi('hdr.daemon.resumed', { n: app.daemon.resumedRooms.length }, '');
    }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  // Inside the desktop app (app/preload.cjs) window.roomApp offers a native folder picker and the
  // system clipboard; in a browser it is absent and the page behaves as before.
  var APP = (typeof window !== 'undefined' && window.roomApp && window.roomApp.isApp === true) ? window.roomApp : null;

  // ---- token: fragment once, then out of the address bar ----
  function takeTokenFromFragment() {
    var frag = (location.hash || '').replace(/^#/, '').trim();
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* older browsers: leave it */ }
    }
    if (!frag) return '';
    var m = /^token=(.+)$/.exec(frag);
    return m ? m[1] : frag;
  }

  // ---- DOM helpers (zero innerHTML) ----
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function toast(text, tone) {
    var box = $('toasts');
    if (!box) return;
    var el = h('div', { class: 'toast ' + (tone || ''), text: text });
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 8000);
  }

  // ---- network: GET without token, POST with token in JSON body ----
  function getJson(path) {
    return fetch(path, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { setConn(true); return { status: r.status, json: j || {} }; });
    }, function (e) { setConn(false); throw e; });
  }
  function postJson(path, body) {
    var payload = Object.assign({}, body || {}, { token: app.token });
    return fetch(path, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { setConn(true); return { status: r.status, json: j || {} }; });
    }, function (e) { setConn(false); throw e; });
  }
  function errText(res) {
    var j = (res && res.json) || {};
    return j.message || j.error || ('HTTP ' + (res && res.status));
  }

  function setConn(ok) {
    var el = $('hdr-conn');
    if (!el) return;
    if (ok) el.textContent = app.sseConnected ? tUi('lobby.conn.sse', null, 'Live (SSE)') : tUi('lobby.conn.ok', null, 'Online');
    else el.textContent = tUi('lobby.conn.bad', null, 'Disconnected');
    el.className = 'conn ' + (ok ? 'conn-ok' : 'conn-bad');
  }
  function setToken(t) {
    app.token = t || '';
    var el = $('hdr-token');
    if (el) {
      el.textContent = app.token ? tUi('lobby.tok.ok', null, 'Loaded') : tUi('lobby.tok.missing', null, 'Not loaded');
      el.className = 'tok ' + (app.token ? 'tok-ok' : 'tok-missing');
    }
    var bar = $('token-bar');
    if (bar) bar.classList.toggle('hidden', !!app.token);
    var btns = document.querySelectorAll('[data-needs-token]');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !app.token;
  }

  // ---- views ----
  function showView(name) {
    app.view = name;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === name);
    var views = document.querySelectorAll('.view');
    for (var j = 0; j < views.length; j++) views[j].classList.toggle('active', views[j].getAttribute('data-view') === name);
    if (name === 'rooms') refreshRooms();
  }

  function agentLabel(id) {
    var a = app.meta && app.meta.agents ? app.meta.agents.filter(function (x) { return x.id === id; })[0] : null;
    return a ? a.label : (id || 'Unknown');
  }
  function waitLabel(id) {
    var w = app.meta && app.meta.waitModes ? app.meta.waitModes.filter(function (x) { return x.id === id; })[0] : null;
    return w ? w.label : (id || 'Unknown');
  }

  function seatIdentity(seat) {
    var id = (seat && seat.seatId) || '—';
    var agent = seat && typeof seat.agent === 'string' ? seat.agent.toLowerCase() : '';
    var hosted = seat && typeof seat.hosted === 'string' ? seat.hosted.toLowerCase() : '';
    if (hosted.indexOf('pi:') === 0 || agent === 'pi-user' || id.toUpperCase() === 'PI') return { family: 'pi', monogram: 'PI', label: seat.hosted ? ('Built-in ' + seat.hosted) : 'Pi' };
    if (agent === 'claude-code' || /^claude/i.test(id)) return { family: 'claude', monogram: 'CC', label: agentLabel(seat.agent) };
    if (agent === 'antigravity' || /^anti/i.test(id)) return { family: 'antigravity', monogram: 'AG', label: agentLabel(seat.agent) };
    if (agent === 'codex-cli' || agent === 'codex-desktop' || /^codex/i.test(id)) return { family: 'codex', monogram: 'CX', label: agentLabel(seat.agent) };
    if (agent === 'gemini-cli' || /^gemini/i.test(id)) return { family: 'gemini', monogram: 'GM', label: agentLabel(seat.agent) };
    if (agent === 'opencode' || /^opencode/i.test(id)) return { family: 'opencode', monogram: 'OC', label: agentLabel(seat.agent) };
    if (agent === 'kimi' || /^kimi/i.test(id)) return { family: 'kimi', monogram: 'KM', label: agentLabel(seat.agent) };
    if (agent === 'dsh' || /^dsh/i.test(id)) return { family: 'dsh', monogram: 'DH', label: agentLabel(seat.agent) };
    if (/^deepseek/i.test(id)) return { family: 'deepseek', monogram: 'DS', label: agentLabel(seat.agent) };
    var clean = String(id).replace(/[^A-Za-z0-9]/g, '');
    return { family: 'other', monogram: clean ? clean.slice(0, 2).toUpperCase() : 'RT', label: seat.hosted ? ('Built-in ' + seat.hosted) : agentLabel(seat.agent) };
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed — select manually';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (APP && typeof APP.copyText === 'function') {
      APP.copyText(text).then(function (ok) { done(ok !== false); }, function () { done(fallbackCopy(text)); });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else done(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = h('textarea', { value: text, readonly: true });
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // One join-prompt card: exact sentence to send to the agent, copy button, and agent-specific guidance.
  function joinCard(seat) {
    var ident = seatIdentity(seat);
    var head = h('h5', {}, [
      'Seat ' + seat.seatId,
      h('span', { class: 'badge', text: ROLE_SHORT[seat.role] || seat.role }),
      h('span', { class: 'badge info', text: ident.label }),
    ]);
    var body = [head];
    if (seat.sentence) {
      var btn = h('button', { type: 'button', class: 'btn-small', text: 'Copy Prompt' });
      btn.addEventListener('click', function () { copyText(seat.sentence, btn); });
      body.push(h('div', { class: 'hint', text: 'Send this prompt to the agent for this seat:' }));
      body.push(h('div', { class: 'sentence' }, [h('code', { text: seat.sentence }), btn]));
    }
    if (seat.hint) body.push(h('div', { class: 'hint', text: seat.hint }));
    if (seat.notes && seat.notes.length) body.push(h('ul', {}, seat.notes.map(function (n) { return h('li', { text: n }); })));
    return h('div', { class: 'join-card' }, body);
  }

  // ---- room actions (shared by the room grid and post-create view) ----
  function openRoomUi(id, btn) {
    if (!app.token) { toast('Launcher token is not loaded; cannot open room.', 'bad'); return; }
    if (APP) { openRoomUiInApp(id, btn); return; }
    var w = null;
    try { w = window.open('about:blank', '_blank'); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } }
    if (btn) btn.disabled = true;
    postJson('/lobby/api/open', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { if (w) w.close(); toast('Failed to open room: ' + errText(res), 'bad'); return; }
      var url = res.json.url;
      if (w) { try { w.location.replace(url); } catch (e) { /* fallback link stays below */ } }
      showRoomLink(id, url, !w);
      toast(res.json.already ? 'Room ' + id + ' is already running.' : 'Room ' + id + ' opened.', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; if (w) w.close(); toast('Failed to open room: launcher unreachable.', 'bad'); });
  }
  function openRoomUiInApp(id, btn) {
    if (btn) btn.disabled = true;
    postJson('/lobby/api/open', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { toast('Failed to open room: ' + errText(res), 'bad'); return; }
      var url = res.json.url;
      try { window.open(url, '_blank'); } catch (e) { /* fallback link stays below */ }
      showRoomLink(id, url, false);
      toast(res.json.already ? 'Room ' + id + ' is already running.' : 'Room ' + id + ' opened.', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; toast('Failed to open room: launcher unreachable.', 'bad'); });
  }
  // Never interpolate room IDs into CSS selectors.
  function roomLinkBox(id) {
    var boxes = document.querySelectorAll('[data-room-link]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].getAttribute('data-room-link') === String(id)) return boxes[i];
    return null;
  }
  function showRoomLink(id, url, blocked) {
    var box = roomLinkBox(id);
    if (!box) { if (blocked) toast('Popup blocked by browser; allow popups and click "Open Room UI" again.', 'bad'); return; }
    clear(box);
    box.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: blocked ? 'Popup blocked — click here to open Room UI' : 'Open Room UI in new tab ↗' }));
  }
  function stopRoom(id, btn) {
    if (btn) btn.disabled = true;
    postJson('/lobby/api/stop', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { toast('Failed to stop room: ' + errText(res), 'bad'); return; }
      toast('Stopped room service for ' + id + '.', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; toast('Failed to stop room: launcher unreachable.', 'bad'); });
  }

  function taskForm(room) {
    var ta = h('textarea', { placeholder: 'Describe the objective, e.g. Add --strict mode to parser.mjs; acceptance: node --test parser.test.mjs' });
    var lead = room.seats.filter(function (s) { return s.role === 'lead'; }).map(function (s) { return s.seatId; });
    var rest = room.seats.filter(function (s) { return s.role !== 'lead'; }).map(function (s) { return s.seatId; });
    var order = h('input', { type: 'text', value: lead.concat(rest).join(','), placeholder: 'A,B' });
    var go = h('button', { type: 'button', class: 'primary', text: 'Assign Task & Start', 'data-needs-token': true, disabled: !app.token });
    var status = h('span', { class: 'hint' });
    go.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { toast('Enter a task objective first.', 'bad'); return; }
      var ids = order.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < ids.length; i++) if (!ID_RE.test(ids[i])) { toast('Invalid seat ID in speaking order: "' + ids[i] + '".', 'bad'); return; }
      go.disabled = true;
      status.textContent = 'Submitting…';
      postJson('/lobby/api/open', { id: room.id }).then(function (o) {
        if (o.status !== 200 || !o.json.ok) throw new Error('Open failed: ' + errText(o));
        var payload = ids.length ? { id: room.id, task: text, order: ids } : { id: room.id, task: text };
        return postJson('/lobby/api/start', payload);
      }).then(function (s) {
        if (s.status !== 200 || !s.json.ok) throw new Error('Start failed: ' + errText(s));
        status.textContent = 'Started Round ' + (s.json.roundId || '?') + '.';
        toast('Room ' + room.id + ' started. Open the Room UI to follow the live stream.', 'ok');
        app.taskOpen[room.id] = false;
        refreshRooms();
      }).catch(function (e) {
        status.textContent = '';
        toast(e && e.message ? e.message : 'Submit failed: launcher unreachable.', 'bad');
      }).then(function () { go.disabled = !app.token; });
    });
    return h('div', { class: 'task-form' }, [
      h('label', { class: 'hint', text: 'Room Objective (sent as admin task)' }), ta,
      h('div', { class: 'inline-form' }, [h('span', { class: 'hint', text: 'Turn order (comma-separated seat IDs)' }), order, go, status]),
      h('div', { class: 'hint', text: 'If the room service is stopped, submitting starts it automatically without popping open a window.' }),
    ]);
  }

  function seatChip(s) {
    var ident = seatIdentity(s);
    var metaParts = [ident.label];
    if (s.waitMode) metaParts.push(WAIT_SHORT[s.waitMode] || waitLabel(s.waitMode));
    if (s.wakeThread) metaParts.push('thread:' + s.wakeThread);
    return h('div', { class: 'seat-chip', 'data-family': ident.family, title: s.cwd || '' }, [
      h('span', { class: 'seat-avatar', 'aria-hidden': 'true', text: ident.monogram }),
      h('div', { class: 'seat-chip-body' }, [
        h('div', { class: 'seat-chip-top' }, [
          h('span', { class: 'seat-chip-id', text: 'Seat ' + s.seatId }),
          h('span', { class: 'seat-chip-role', text: ROLE_SHORT[s.role] || s.role }),
        ]),
        h('div', { class: 'seat-chip-meta', text: metaParts.join(' · ') }),
        s.cwd ? h('div', { class: 'seat-chip-cwd', text: s.cwd }) : null,
      ]),
    ]);
  }

  function roomCard(room) {
    var dotCls = room.openedHere ? 'room-status-dot running' : (room.serviceRunning ? 'room-status-dot external' : 'room-status-dot');
    var runningBadge = room.openedHere
      ? h('span', { class: 'badge ok', text: 'Running here' })
      : (room.serviceRunning ? h('span', { class: 'badge warn', text: 'Running elsewhere' }) : h('span', { class: 'badge', text: 'Stopped' }));
    var phaseText = room.closed ? PHASE_LABEL.closed : (PHASE_LABEL[room.phase] || room.phase);
    var head = h('div', { class: 'room-card-head' }, [
      h('div', { class: 'room-card-title-row' }, [
        h('span', { class: dotCls, 'aria-hidden': 'true' }),
        h('span', { class: 'room-id-title', text: room.id }),
        h('span', { class: 'badge info', text: room.preset || 'custom' }),
      ]),
      h('div', { class: 'room-meta-badges' }, [
        h('span', { class: 'badge', text: phaseText }),
        h('span', { class: 'badge tabular', text: 'R' + room.roundId }),
        runningBadge,
      ]),
    ]);

    var seatStrip = room.seats && room.seats.length
      ? h('div', { class: 'seat-strip' }, room.seats.map(seatChip))
      : h('div', { class: 'empty', text: 'No seats registered yet.' });

    var joins = h('details', { class: 'seat-join' }, [
      h('summary', { text: 'Join Prompts (' + (room.seats ? room.seats.length : 0) + ' seats)' }),
    ].concat((room.seats || []).map(joinCard)));

    var openBtn = h('button', { type: 'button', class: 'primary', text: 'Open Room UI', 'data-needs-token': true, disabled: !app.token || (room.serviceRunning && !room.openedHere) });
    openBtn.addEventListener('click', function () { openRoomUi(room.id, openBtn); });
    var stopBtn = h('button', { type: 'button', class: 'danger', text: 'Stop', 'data-needs-token': true, disabled: !app.token || !room.openedHere });
    stopBtn.addEventListener('click', function () { stopRoom(room.id, stopBtn); });
    var taskBtn = h('button', { type: 'button', text: app.taskOpen[room.id] ? 'Hide Task Form' : 'Assign Task & Start', disabled: room.closed || (room.serviceRunning && !room.openedHere) });
    taskBtn.addEventListener('click', function () { app.taskOpen[room.id] = !app.taskOpen[room.id]; renderRooms(true); });

    var footer = h('div', { class: 'room-card-footer' }, [
      h('div', { class: 'room-card-actions' }, [openBtn, taskBtn, stopBtn]),
      h('div', { class: 'room-card-actions' }, [
        room.serviceRunning && !room.openedHere ? h('span', { class: 'hint', text: 'Service is running in another window; manage or stop it there first.' }) : null,
        h('span', { 'data-room-link': room.id }),
      ]),
    ]);

    var children = [head];
    if (room.idMismatch) children.push(h('div', { class: 'hint', text: 'Directory name is "' + room.id + '" while room.json records "' + room.roomId + '"; launcher actions address the directory name.' }));
    if (room.task) children.push(h('div', { class: 'room-task-snippet' }, [h('strong', { text: 'Objective:' }), room.task]));
    children.push(seatStrip, joins, footer);
    if (app.taskOpen[room.id]) children.push(taskForm(room));
    return h('div', { class: 'card room-card', 'data-room': room.id }, children);
  }

  // Re-rendering replaces cards; skip while user is typing inside an inline task form.
  function renderRooms(force) {
    var box = $('rooms');
    if (!box) return;
    if (!force && box.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
    var countEl = $('rooms-count');
    if (countEl) countEl.textContent = String(app.rooms.length);
    clear(box);
    if (!app.rooms.length) {
      box.appendChild(h('div', { class: 'card' }, [h('p', { class: 'empty', text: 'No rooms yet. Click "New Room" to create your first multi-agent workspace.' })]));
      return;
    }
    app.rooms.forEach(function (r) { box.appendChild(roomCard(r)); });
  }
  function applyRoomsSnapshot(payload) {
    if (!payload) return;
    if (payload.daemon) updateDaemonBadge(payload.daemon);
    var list = payload.rooms || [];
    var key = JSON.stringify(list);
    app.rooms = list;
    if (key !== app.lastRooms) { app.lastRooms = key; renderRooms(false); }
  }
  function refreshRooms() {
    return getJson('/lobby/api/rooms').then(function (res) {
      if (res.status !== 200 || !res.json.ok) { toast('Failed to load rooms: ' + errText(res), 'bad'); return; }
      applyRoomsSnapshot(res.json);
    }, function () { /* connection pill already reports offline */ });
  }
  function connectLobbySse() {
    if (typeof EventSource === 'undefined' || app.sse) return;
    var es;
    try { es = new EventSource('/lobby/api/stream'); } catch (e) { return; }
    app.sse = es;
    es.addEventListener('open', function () { app.sseConnected = true; setConn(true); });
    es.addEventListener('rooms', function (ev) {
      try {
        app.sseConnected = true;
        setConn(true);
        applyRoomsSnapshot(JSON.parse(ev.data));
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('error', function () {
      app.sseConnected = false;
      if (es.readyState === 2) app.sse = null;
      setConn(false);
    });
  }

  // ---- create form ----
  function fillSelect(sel, items, value) {
    clear(sel);
    items.forEach(function (it) { sel.appendChild(h('option', { value: it.id, text: it.label || it.id })); });
    if (value !== undefined) sel.value = value;
  }

  function seatRow(init) {
    init = init || {};
    var row = h('div', { class: 'seat-row' });
    var idIn = h('input', { type: 'text', class: 'seat-id', value: init.seatId || '', placeholder: 'Seat ID', 'aria-label': 'Seat ID' });
    var role = h('select', { 'aria-label': 'Role' });
    fillSelect(role, (app.meta.roles || []).map(function (r) { return { id: r.id, label: r.label }; }), init.role || 'participant');
    var agent = h('select', { 'aria-label': 'Agent' });
    var agentItems = (app.meta.agents || []).map(function (a) { return { id: a.id, label: a.label + ' (' + a.id + ')' }; });
    if ((app.meta.hostedTiers || []).length) agentItems.push({ id: HOSTED_PI, label: 'Built-in Pi (room-hosted)' });
    fillSelect(agent, agentItems, init.hosted ? HOSTED_PI : (init.agent || 'generic'));
    var tier = h('select', { 'aria-label': 'Built-in Pi Tier' });
    fillSelect(tier, (app.meta.hostedTiers || []).map(function (t) { return { id: t.id, label: t.label }; }), init.hosted && /^pi:/.test(init.hosted) ? init.hosted.slice(3) : 'discussion');
    var tierRow = [h('label', { text: 'Built-in Pi Tier' }), h('div', {}, [tier, h('div', { class: 'hint', text: 'Hosted directly by the room service; no join prompt needed. Configure ROOM_PI_API_KEY or `admin pi-key --save` before starting.' })])];
    var wait = h('select', { 'aria-label': 'Wait Mode' });
    var waitRow = [h('label', { text: 'Wait Mode' }), wait];
    var cwd = h('input', { type: 'text', value: init.cwd || '', placeholder: 'Absolute path to working directory', 'aria-label': 'Working Directory' });
    var create = h('input', { type: 'checkbox', checked: init.createCwd !== false });
    var thread = h('input', { type: 'text', value: '', placeholder: 'room-<roomId>-A', 'aria-label': 'Codex Wake Thread' });
    var threadRow = [h('label', { text: 'Codex Wake Thread' }), h('div', {}, [thread, h('div', { class: 'hint', text: 'Rename your Codex thread to this unique name so wake pushes can target it automatically. Leave blank to disable wake push.' })])];
    var cwdNote = h('div', { class: 'hint' });
    var remove = h('button', { type: 'button', class: 'btn-small danger', text: 'Remove Seat' });
    row._touched = { cwd: !!init.cwd, thread: false };

    function isPi() { return agent.value === HOSTED_PI; }
    function refreshWait() {
      var a = (app.meta.agents || []).filter(function (x) { return x.id === agent.value; })[0];
      var items = [{ id: '', label: 'Agent default (' + waitLabel(a ? a.wait : 'manual') + ')' }].concat((app.meta.waitModes || []).map(function (w) { return { id: w.id, label: w.label }; }));
      var keep = wait.value;
      fillSelect(wait, items, keep || '');
      waitRow.forEach(function (el) { el.classList.toggle('hidden', isPi()); });
      tierRow.forEach(function (el) { el.classList.toggle('hidden', !isPi()); });
    }
    function refreshThread() {
      var codex = !!CODEX_AGENTS[agent.value];
      threadRow.forEach(function (el) { el.classList.toggle('hidden', !codex); });
      if (!row._touched.thread) {
        var rid = $('room-id').value.trim() || 'demo';
        thread.value = (rid.indexOf('room-') === 0 ? rid : 'room-' + rid) + '-' + (idIn.value.trim() || 'A');
      }
    }
    function checkTypedCwd() {
      var v = cwd.value.trim();
      var mine = ++app.seq;
      row._seq = mine;
      if (!isAbsPath(v)) { cwdNote.textContent = v ? 'Enter a full absolute path (e.g. C:\\Users\\you\\project or /home/you/project).' : ''; return; }
      if (!app.token) return;
      postJson('/lobby/api/folder', { path: v }).then(function (res) {
        if (row._seq !== mine || res.status !== 200 || !res.json.ok) return;
        create.checked = !res.json.exists;
        cwdNote.textContent = !res.json.exists
          ? 'Folder does not exist yet; keep checked to create an empty folder automatically.'
          : (res.json.isDir ? 'Existing folder found and will be used directly ("Create empty folder" unchecked).' : 'This path points to a file, not a directory.');
      }, function () {});
    }
    function refreshCwd() {
      if (row._touched.cwd) return;
      var rid = $('room-id').value.trim();
      var sid = idIn.value.trim();
      if (!ID_RE.test(rid) || !ID_RE.test(sid)) return;
      var mine = ++app.seq;
      row._seq = mine;
      getJson('/lobby/api/seat-defaults?id=' + encodeURIComponent(rid) + '&seat=' + encodeURIComponent(sid)).then(function (res) {
        if (row._seq !== mine || row._touched.cwd || res.status !== 200 || !res.json.ok) return;
        cwd.value = res.json.cwd;
        create.checked = !res.json.exists;
        cwdNote.textContent = res.json.exists
          ? 'Existing folder found and will be used directly.'
          : 'Suggested path; keep checked to create this empty folder automatically.';
      }, function () {});
    }
    row._refreshCwd = refreshCwd;
    row._refreshThread = refreshThread;

    idIn.addEventListener('input', function () { refreshThread(); refreshCwd(); });
    agent.addEventListener('change', function () { refreshWait(); refreshThread(); });
    cwd.addEventListener('input', function () {
      row._touched.cwd = true;
      cwdNote.textContent = 'Checking folder…';
      if (row._cwdTimer) clearTimeout(row._cwdTimer);
      row._cwdTimer = setTimeout(checkTypedCwd, 300);
    });
    thread.addEventListener('input', function () { row._touched.thread = true; });
    remove.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row); });

    // Native folder picker inside the desktop app.
    var browse = null;
    if (APP && typeof APP.pickFolder === 'function') {
      browse = h('button', { type: 'button', class: 'btn-small', text: 'Browse…' });
      browse.addEventListener('click', function () {
        browse.disabled = true;
        APP.pickFolder(cwd.value.trim() || null).then(function (picked) {
          browse.disabled = false;
          if (typeof picked !== 'string' || !picked) return;
          cwd.value = picked;
          row._touched.cwd = true;
          app.seatsEdited = true;
          cwdNote.textContent = 'Checking folder…';
          checkTypedCwd();
        }, function () { browse.disabled = false; toast('Could not open folder picker.', 'bad'); });
      });
    }

    row.appendChild(h('div', { class: 'row-head' }, [h('span', { class: 'hint', text: 'Seat' }), idIn, h('span', { class: 'spacer' }), remove]));
    row.appendChild(h('div', { class: 'row-grid' }, [
      h('label', { text: 'Role' }), role,
      h('label', { text: 'Agent' }), agent,
    ].concat(tierRow, waitRow, [
      h('label', { text: 'Working Dir' }), h('div', {}, [
        h('div', { class: 'cwd-line' }, [cwd, browse]),
        h('label', { class: 'check' }, [create, 'Create empty folder automatically']),
        cwdNote,
      ]),
    ], threadRow)));
    refreshWait();
    refreshThread();
    if (init.wait) wait.value = init.wait;
    row._read = function () {
      var s = { seatId: idIn.value.trim(), role: role.value, cwd: cwd.value.trim(), createCwd: !!create.checked };
      // Built-in Pi seat: hosted 'pi:<tier>', no external agent, wait mode, or Codex thread.
      if (isPi()) { s.hosted = 'pi:' + tier.value; return s; }
      s.agent = agent.value;
      if (wait.value) s.wait = wait.value;
      if (CODEX_AGENTS[agent.value]) s.wakeThread = thread.value.trim();
      return s;
    };
    return row;
  }
  function isAbsPath(v) { return /^[A-Za-z]:[\\/]/.test(v) || /^\\\\[^\\]/.test(v) || /^\//.test(v); }

  function presetSeats(preset) {
    if (preset === 'simplified') return [{ seatId: 'A', role: 'lead', agent: 'codex-desktop' }, { seatId: 'P', role: 'participant', hosted: 'pi:discussion' }];
    return [{ seatId: 'A', role: 'lead', agent: 'codex-desktop' }, { seatId: 'B', role: 'executor', agent: 'claude-code' }];
  }
  function defaultSeats() {
    var box = $('seat-rows');
    clear(box);
    presetSeats($('room-preset').value).forEach(function (s) { box.appendChild(seatRow(s)); });
    app.seatsEdited = false;
    refreshAllCwds();
  }
  function refreshAllCwds() {
    var rows = $('seat-rows').children;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]._refreshCwd) rows[i]._refreshCwd();
      if (rows[i]._refreshThread) rows[i]._refreshThread();
    }
  }
  function nextSeatId() {
    var used = {};
    var rows = $('seat-rows').children;
    for (var i = 0; i < rows.length; i++) used[rows[i]._read().seatId] = 1;
    for (var c = 65; c < 91; c++) { var id = String.fromCharCode(c); if (!used[id]) return id; }
    return 'S' + rows.length;
  }

  function renderPresetDesc() {
    var sel = $('room-preset');
    var p = (app.meta.presets || []).filter(function (x) { return x.id === sel.value; })[0];
    $('preset-desc').textContent = p ? p.desc : '';
  }

  function submitCreate(ev) {
    ev.preventDefault();
    if (!app.token) { toast('Launcher token is not loaded; cannot create room.', 'bad'); return; }
    var id = $('room-id').value.trim();
    if (!ID_RE.test(id)) { toast('Room ID may contain only letters, digits, - and _.', 'bad'); return; }
    var rows = $('seat-rows').children;
    var seats = [];
    for (var i = 0; i < rows.length; i++) seats.push(rows[i]._read());
    if (!seats.length) { toast('Add at least one seat before creating a room.', 'bad'); return; }
    var btn = $('btn-create');
    btn.disabled = true;
    $('create-status').textContent = 'Creating room…';
    var roomLang = $('room-lang') ? $('room-lang').value : 'en';
    postJson('/lobby/api/create', { id: id, preset: $('room-preset').value, lang: roomLang, seats: seats }).then(function (res) {
      btn.disabled = !app.token;
      if (res.status !== 200 || !res.json.ok) {
        clear($('create-status'));
        $('create-status').appendChild(h('span', { class: 'error', text: 'Create failed: ' + errText(res) }));
        toast('Create failed: ' + errText(res), 'bad');
        return;
      }
      $('create-status').textContent = '';
      renderCreated(res.json);
      refreshRooms();
    }, function () { btn.disabled = !app.token; $('create-status').textContent = ''; toast('Create failed: launcher unreachable.', 'bad'); });
  }

  function renderCreated(r) {
    var box = $('created');
    clear(box);
    var room = { id: r.id, seats: r.seats, openedHere: false };
    var openBtn = h('button', { type: 'button', class: 'primary', text: 'Open Room UI', 'data-needs-token': true });
    openBtn.addEventListener('click', function () { openRoomUi(r.id, openBtn); });
    box.appendChild(h('div', { class: 'card created-card' }, [
      h('h4', {}, ['Room ' + r.id + ' created', h('span', { class: 'badge info', text: r.preset || 'custom' })]),
      h('div', { class: 'hint mono', text: r.roomDir }),
      h('p', {}, ['Next step: copy each prompt below into its corresponding agent session (it will read JOIN.md and join automatically), then open the Room UI or assign a task below.']),
      r.roomNotes && r.roomNotes.length ? h('div', { class: 'notice warn' }, [h('b', { text: 'Before starting, resolve:' }), h('ul', {}, r.roomNotes.map(function (n) { return h('li', { text: n }); }))]) : null,
    ].concat(r.seats.map(joinCard)).concat([
      h('div', { class: 'actions' }, [openBtn, h('span', { 'data-room-link': r.id })]),
      taskForm(room),
    ])));
    box.classList.remove('hidden');
    $('form-create').classList.add('hidden');
    box.appendChild(h('div', { class: 'actions' }, [h('button', { type: 'button', text: 'Create Another Room', onclick: function () { box.classList.add('hidden'); $('form-create').classList.remove('hidden'); $('room-id').value = ''; defaultSeats(); } })]));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- boot ----
  function boot() {
    applyTheme(detectInitialTheme());
    if ($('btn-theme')) {
      $('btn-theme').addEventListener('click', function () {
        applyTheme(app.theme === 'dark' ? 'light' : 'dark');
      });
    }
    setToken(takeTokenFromFragment());
    $('token-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = $('token-input').value.trim().replace(/^.*#/, '').replace(/^token=/, '');
      $('token-input').value = '';
      setToken(v);
      renderRooms(true);
    });
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', function (ev) { showView(ev.currentTarget.getAttribute('data-view')); });
    $('btn-refresh').addEventListener('click', function () { app.lastRooms = ''; refreshRooms(); });
    $('btn-goto-create').addEventListener('click', function () { showView('create'); });

    getJson('/lobby/api/meta').then(function (res) {
      if (res.status !== 200 || !res.json.ok) { toast('Failed to load launcher metadata: ' + errText(res), 'bad'); return; }
      app.meta = res.json;
      if (res.json.defaultLang && $('room-lang')) $('room-lang').value = res.json.defaultLang;
      if (res.json.daemon) updateDaemonBadge(res.json.daemon);
      var rootBold = $('hdr-root') && $('hdr-root').querySelector('b');
      if (rootBold) rootBold.textContent = res.json.roomsRoot;
      $('room-dir-hint').textContent = res.json.roomsRoot;
      fillSelect($('room-preset'), res.json.presets.map(function (p) { return { id: p.id, label: p.id }; }), 'implement-review');
      $('room-preset').addEventListener('change', function () {
        renderPresetDesc();
        if (!app.seatsEdited) defaultSeats();
      });
      renderPresetDesc();
      $('seat-rows').addEventListener('input', function () { app.seatsEdited = true; });
      $('seat-rows').addEventListener('change', function () { app.seatsEdited = true; });
      var d = new Date();
      var p2 = function (n) { return String(n).padStart(2, '0'); };
      $('room-id').value = 'room-' + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
      $('room-id').addEventListener('input', refreshAllCwds);
      defaultSeats();
      $('btn-add-seat').addEventListener('click', function () { var row = seatRow({ seatId: nextSeatId(), role: 'participant', agent: 'generic' }); $('seat-rows').appendChild(row); row._refreshCwd(); });
      $('btn-template').addEventListener('click', defaultSeats);
      $('form-create').addEventListener('submit', submitCreate);
      refreshRooms();
      connectLobbySse();
    }, function () { toast('Cannot reach launcher service.', 'bad'); });
    app.pollTimer = setInterval(function () { if (app.view === 'rooms' && !document.hidden && !app.sseConnected) refreshRooms(); }, 3000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
