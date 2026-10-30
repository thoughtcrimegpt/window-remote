// Window Remote: the phone app.
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('wr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wr.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  me: null, ws: null, wsUp: false, mac: {}, windows: [], displays: [], thumbs: {}, needs: [],
  view: null, pc: null, channel: null, basic: false, layout: store.get('layout', true), sendReturn: store.get('sendReturn', true),
  lastReach: Date.now(), backoff: 500, reconnectTimer: null, rtcState: 'new', recents: store.get('recents', []), live: false,
};

// ---------- small helpers ----------

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WR': '1' }, body: JSON.stringify(body) };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180_000);
  try {
    const r = await fetch(path, { ...opts, signal: ctl.signal, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.pair) { showPair(); throw new Error('Pair this device first.'); }
    return data;
  } finally { clearTimeout(t); }
}

let toastTimer;
function toast(text, action, onAction, ms = 4000) {
  const el = $('#toast');
  el.innerHTML = `<p>${esc(text)}</p>${action ? `<button class="btn primary">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  el.classList.toggle('in-viewer', !!S.view);
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Notices can be flicked away upward, like iPhone notifications.
{
  const el = $('#toast'); let y0 = null;
  el.addEventListener('touchstart', (e) => { if (!e.target.closest('button')) y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (y0 === null) return; const dy = Math.min(0, e.touches[0].clientY - y0); el.style.transform = `translateY(${dy}px)`; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    el.style.transition = 'transform .25s';
    if (dy < -30) { el.style.transform = 'translateY(-150%)'; setTimeout(() => { el.hidden = true; el.style.transform = ''; el.style.transition = ''; }, 250); }
    else { el.style.transform = ''; setTimeout(() => { el.style.transition = ''; }, 250); }
  });
}

// A picture that fails to load is hidden (an empty tile), never shown as a broken image.
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.hidden = true; }, true);
document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && e.target.dataset.thumb) e.target.hidden = false; }, true);

// Haptic tick: vibrate where supported; on iPhone (iOS 18+) toggling a hidden switch gives a tap.
const hapticLabel = $('#haptic');
function haptic() {
  try { navigator.vibrate?.(8); } catch { /* not supported */ }
  // Clicking the hidden switch can move the focus to it; put the focus back so the keyboard stays.
  const had = document.activeElement;
  try { hapticLabel.click(); } catch { /* older iOS */ }
  if (had && had !== document.activeElement && had !== document.body) had.focus({ preventScroll: true });
}

// ---------- pairing ----------

const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const onIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
function showPair() {
  $('#pair').hidden = false; $('#main').hidden = true; $('#viewer').hidden = true;
  // In a Safari tab on an iPhone: add to the Home Screen first (the Home Screen app keeps its own sign-in).
  $('#a2hs').hidden = !(onIPhone && !standalone);
}

$('#pairShow').onclick = async () => {
  $('#pairMsg').textContent = '';
  const r = await api('/api/pair/start', {}).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) { $('#pairMsg').textContent = r.message || 'The Mac did not answer.'; return; }
  $('#pairForm').hidden = false; $('#pairHave').hidden = true;
  $('#pairShow').textContent = 'Show a New Code';
  $('#pairShow').classList.replace('filled', 'tinted');
  $('#pairMsg').textContent = 'A code is on your Mac screen now. Type it above.';
  $('#pairCode').focus();
};
$('#pairHave').onclick = () => { $('#pairForm').hidden = false; $('#pairHave').hidden = true; $('#pairCode').focus(); };
$('#pairCode').addEventListener('input', (e) => { if (e.target.value.replace(/\D/g, '').length === 6) $('#pairForm').requestSubmit(); });
$('#pairForm').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('#pairCode').value.trim();
  const r = await api('/api/pair/finish', { code, name: /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Browser' }).catch((err) => ({ ok: false, message: err.message }));
  if (!r.ok) { $('#pairMsg').textContent = r.message; $('#pairCode').select(); return; }
  haptic();
  boot();
};

// ---------- connection ----------

function setConn(kind, text) { const p = $('#conn'); p.className = 'conn ' + kind; p.textContent = text; }

function connect() {
  clearTimeout(S.reconnectTimer);
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    S.wsUp = true; S.backoff = 500; S.lastReach = Date.now();
    setConn('ok', 'Connected');
    send({ t: 'hello', viewport: viewport() });
    refreshWindows(true);
    send({ t: 'needs' });
    if (S.view) startView(S.view, true);
    renderBanner();
  };
  ws.onmessage = (ev) => {
    S.lastReach = Date.now();
    if (typeof ev.data !== 'string') return basicFrame(ev.data);
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.wsUp = false;
    closeRtc();
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
}

async function scheduleReconnect() {
  const away = Date.now() - S.lastReach;
  // Tell "the network is changing" apart from "the Mac cannot be reached at all".
  let reach = false;
  try { const r = await fetch('/api/me', { cache: 'no-store', signal: AbortSignal.timeout?.(3500) }); reach = r.ok; if (r.ok) { S.me = await r.json(); S.lastReach = Date.now(); } } catch { reach = false; }
  if (reach && S.me && !S.me.paired) return showPair();
  if (reach && S.me?.paused) { setConn('bad', 'Paused'); setViewerStatus('Paused from the Mac menu. Try again in a few minutes.', 'Try again', () => connect()); }
  else if (!reach && away > 12_000) { setConn('bad', 'Mac offline'); setViewerStatus('Cannot reach your Mac. Check that Tailscale is on in this iPhone, and that the Mac is awake and online.', 'Try now', () => connect()); }
  else { setConn('wait', 'Reconnecting'); setViewerStatus('Reconnecting'); }
  renderBanner(!reach && away > 12_000);
  S.reconnectTimer = setTimeout(connect, S.backoff);
  S.backoff = Math.min(S.backoff * 1.7, 5000);
}

function send(obj) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(obj)); return true; } return false; }
function sendFast(obj) {
  if (S.channel && S.channel.readyState === 'open') { try { S.channel.send(JSON.stringify(obj)); return true; } catch { /* fall back */ } }
  return send(obj);
}

addEventListener('online', () => { S.backoff = 300; connect(); });
// The Mac sends status every 2 seconds. Silence for 8 seconds means the connection died quietly
// (common when the phone switches between wifi and cellular), so drop it and reconnect at once.
function stale(ms) { return S.ws && S.ws.readyState === 1 && Date.now() - S.lastReach > ms; }
function dropAndReconnect() {
  // A dead connection can take a long time to report closing, so stop waiting for it.
  const old = S.ws; S.ws = null; S.wsUp = false;
  if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* closing */ } }
  setConn('wait', 'Reconnecting');
  S.backoff = 300;
  connect();
}
setInterval(() => { if (document.visibilityState === 'visible' && stale(8000)) dropAndReconnect(); }, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  S.backoff = 300;
  if (stale(4000)) { dropAndReconnect(); return; }
  if (!S.ws || S.ws.readyState > 1) connect();
  else if (S.view && (!S.pc || ['failed', 'disconnected', 'closed'].includes(S.rtcState)) && !S.basic) send({ t: 'restartVideo' });
  send({ t: 'needs' });
});

function viewport() { return { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: devicePixelRatio || 2 }; }
const portrait = () => innerHeight >= innerWidth;
let vpTimer, wasPortrait = portrait();
addEventListener('resize', () => {
  clearTimeout(vpTimer);
  vpTimer = setTimeout(() => {
    send({ t: 'viewport', ...viewport() });
    // Turning the phone sideways shows the window at its own shape; upright reshapes it again.
    if (S.view?.kind === 'window' && S.layout && portrait() !== wasPortrait) send({ t: 'layout', on: portrait(), fit: fitArea() });
    wasPortrait = portrait();
    layoutVideo();
    if (S.view) requestCrop();
  }, 200);
});

function onMessage(m) {
  switch (m.t) {
    case 'status': S.mac = m; renderBanner(); if (S.view) checkViewerStatus(); break;
    case 'windows': S.windows = m.windows; S.displays = m.displays; renderWindows(); saveSnapshot(); break;
    case 'thumb': if (S.thumbs[m.id] !== m.v) { S.thumbs[m.id] = m.v; updateThumb(m.id); saveSnapshot(); } break;
    case 'needs': S.needs = m.hits || []; renderNeeds(); break;
    case 'offer': onOffer(m.sdp, m.oid); break;
    case 'streamInfo': onStreamInfo(m); break;
    case 'frameGen': onFrameGen(m.gen); break;
    case 'hb': break;
    case 'quality': onQuality(m); break;
    case 'clicked': onClicked(m); break;
    case 'textFocus': onTextFocus(m); break;
    case 'answered': toast(m.message || (m.ok ? 'Done.' : 'That did not work.')); if (m.ok) haptic(); break;
    case 'clipboard': onClipboard(m.text); break;
    case 'targetGone': toast('That window was closed.'); closeViewer(); break;
    case 'streamError':
      if (m.permission) setViewerStatus('The Mac needs Screen Recording permission for Window Remote. Open Window Remote on the Mac for the steps.', 'Ask again', () => send({ t: 'permissions' }));
      else setViewerStatus(`The Mac could not show this: ${m.message}`, 'Try again', () => startView(S.view));
      break;
    case 'taken': setViewerStatus(`Now showing on ${m.by}.`, 'Show here', () => startView(S.view)); closeRtc(); break;
    case 'paused': setConn('bad', 'Paused'); toast('Paused from the Mac menu for 10 minutes.'); break;
    case 'layout': S.layoutOn = m.on; break;
    case 'pong': if (m.id === S.pingId) S.pingMs = performance.now() - S.pingAt; break;
    case 'error': console.warn('Mac:', m.message); if (!/description|sdp|ice|dtls/i.test(m.message || '')) toast(m.message); break;
  }
}

function renderBanner(offline) {
  const b = $('#banner');
  const m = S.mac;
  let html = '', cls = '';
  if (offline) { html = '<p>Cannot reach your Mac. Is Tailscale on in this iPhone? Is the Mac online?</p><button class="btn" data-b="retry">Try again</button>'; cls = 'bad'; }
  else if (S.wsUp && m.helper === false) html = '<p>The Mac helper is starting. One moment.</p>';
  else if (S.wsUp && m.screen === false) { html = '<p>The Mac needs Screen Recording permission for Window Remote (open Window Remote on the Mac for the steps).</p><button class="btn" data-b="perm">Ask</button>'; cls = 'bad'; }
  else if (S.wsUp && m.locked) html = '<p>Your Mac is locked. Unlock it at the Mac to see windows.</p>';
  else if (S.wsUp && (m.displayAsleep || m.screensaver)) html = '<p>Your Mac screen is asleep.</p><button class="btn" data-b="wake">Wake</button>';
  else if (S.wsUp && m.accessibility === false) { html = '<p>Taps and typing need Accessibility permission for Window Remote on the Mac.</p><button class="btn" data-b="perm">Ask</button>'; cls = 'bad'; }
  if (b.dataset.key === html + cls) return;
  b.dataset.key = html + cls;
  b.innerHTML = html; b.className = 'banner ' + cls; b.hidden = !html;
  b.querySelector('[data-b=retry]')?.addEventListener('click', () => { haptic(); setConn('wait', 'Trying'); S.backoff = 300; if (!S.me) boot(); else dropAndReconnect(); });
  b.querySelector('[data-b=wake]')?.addEventListener('click', () => { haptic(); send({ t: 'wake' }); });
  b.querySelector('[data-b=perm]')?.addEventListener('click', () => { send({ t: 'permissions' }); toast('Check your Mac for the permission request.'); });
}

// ---------- the large title collapses into the bar when you scroll, like iOS ----------

$('#tab-mac').addEventListener('scroll', () => { $('#main').classList.toggle('scrolled', $('#tab-mac').scrollTop > 36); }, { passive: true });

// ---------- windows ----------

let lastThumbAsk = 0;
// Only tiles that are on screen get fresh pictures (saves data on cellular).
const visibleThumbs = new Set();
const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) { const id = e.target.dataset.thumbFor; if (e.isIntersecting) visibleThumbs.add(id); else visibleThumbs.delete(id); }
}, { rootMargin: '200px' }) : null;
function observeThumbs() { if (thumbObserver) $$('#tab-mac .thumb').forEach((el) => { const img = el.querySelector('img[data-thumb]'); if (img && !el.dataset.thumbFor) { el.dataset.thumbFor = img.dataset.thumb; thumbObserver.observe(el); } }); }

function refreshWindows(withThumbs) {
  if (!S.wsUp) return;
  send({ t: 'list' });
  if (withThumbs || Date.now() - lastThumbAsk > 3500) {
    lastThumbAsk = Date.now();
    setTimeout(() => {
      const want = (id) => !thumbObserver || !S.thumbs[id] || visibleThumbs.has(String(id));
      const ids = S.windows.filter((w) => w.onScreen && want(w.id)).slice(0, 18).map((w) => w.id);
      const displays = S.displays.filter((d) => want('d' + d.id)).map((d) => d.id);
      if (ids.length || displays.length) send({ t: 'thumbs', ids, displays, maxW: 560 });
    }, 150);
  }
}

setInterval(() => {
  if (document.visibilityState !== 'visible' || !S.wsUp) return;
  if (!S.view && !$('#main').hidden) refreshWindows(false);
}, 2500);
setInterval(() => {
  if (document.visibilityState !== 'visible' || !S.wsUp || ($('#main').hidden && !S.view)) return;
  send({ t: 'needs' });
}, 6000);

const iconUrl = (w) => (w?.hasIcon ? `/api/icon/${encodeURIComponent(w.bundleId)}.png` : '/icon.svg');
function thumbUrl(id) { return S.thumbs[id] ? `/api/thumb/${id}?v=${S.thumbs[id]}` : ''; }
const thumbImg = (id, cls = '') => { const t = thumbUrl(id); return `<img class="${cls}" data-thumb="${id}" alt="" ${t ? `src="${t}"` : 'hidden'}>`; };
const windowById = (id) => S.windows.find((w) => w.id === id);
const shortTitle = (w) => (w && w.title && w.title !== w.app ? w.title : '');

function setHtml(el, html) { if (el.dataset.key !== html) { el.innerHTML = html; el.dataset.key = html; } }

/** Recently opened windows, matched again by app and title when the Mac gives them new numbers. */
function recentWindows() {
  const out = [];
  for (const r of S.recents) {
    const w = windowById(r.id) || S.windows.find((x) => x.onScreen && x.app === r.app && x.title === r.title);
    if (w && w.layer === 0 && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 6);
}
function remember(v) {
  if (v.kind !== 'window') return;
  S.recents = [{ id: v.id, app: v.label, title: v.title || '' }, ...S.recents.filter((r) => !(r.id === v.id || (r.app === v.label && r.title === v.title)))].slice(0, 10);
  store.set('recents', S.recents);
}

function tile(w, big) {
  return `<button class="win ${big ? 'big' : ''}" data-id="${w.id}"><div class="thumb">${thumbImg(w.id)}<img class="app-badge" src="${iconUrl(w)}" alt=""></div>
    <div class="label"><b>${esc(shortTitle(w) || w.app)}</b><span>${esc(shortTitle(w) ? w.app : '')}</span></div></button>`;
}

function renderWindows() {
  const recents = recentWindows();
  const onScreen = S.windows.filter((w) => w.onScreen && w.layer === 0);
  const more = S.windows.filter((w) => !w.onScreen);
  setHtml($('#recent'), recents.map((w) => tile(w, true)).join(''));
  $('#recentWrap').hidden = !recents.length;
  setHtml($('#grid'), onScreen.map((w) => tile(w)).join(''));
  $('#gridEmpty').hidden = onScreen.length > 0 || !S.wsUp;
  setHtml($('#screens'), S.displays.map((d) => `<button class="win display-tile" data-display="${d.id}"><div class="thumb" data-ar="${(d.frame.w / d.frame.h).toFixed(3)}">${thumbImg('d' + d.id)}</div>
      <div class="label"><b>${esc(d.name)}</b><span>${d.main ? 'main screen' : ''}</span></div></button>`).join(''));
  $$('#screens [data-ar]').forEach((el) => { el.style.aspectRatio = Math.max(1.2, Math.min(3, Number(el.dataset.ar))); });
  $('#screensWrap').hidden = !S.displays.length;
  $('#moreWrap').hidden = !more.length;
  observeThumbs();
  setHtml($('#more'), more.slice(0, 30).map((w) => `<button class="r" data-id="${w.id}"><img class="row-icon" src="${iconUrl(w)}" alt=""><span>${esc(w.app)}<small>${esc(w.title)}</small></span></button>`).join(''));
}

function updateThumb(id) {
  const url = thumbUrl(id);
  document.querySelectorAll(`img[data-thumb="${id}"]`).forEach((img) => { if (img.getAttribute('src') !== url) img.src = url; img.hidden = false; });
}

$('#tab-mac').addEventListener('click', (e) => {
  const act = e.target.closest('[data-answer]');
  if (act) { e.stopPropagation(); return answerNeed(act); }
  const b = e.target.closest('[data-id],[data-display],[data-need]');
  if (!b) return;
  haptic();
  if (b.dataset.display) { const d = S.displays.find((x) => x.id === Number(b.dataset.display)); return openView({ kind: 'display', id: Number(b.dataset.display), label: 'Whole screen', title: d?.name || '' }, b); }
  const id = Number(b.dataset.id || b.dataset.need);
  const w = windowById(id);
  openView({ kind: 'window', id, label: w ? w.app : 'Window', title: w?.title || '' }, b);
});

// ---------- long-press a window for a menu, like iOS ----------

const CTX = { timer: null, fired: false, w: null };
$('#tab-mac').addEventListener('touchstart', (e) => {
  const b = e.target.closest('.win[data-id], .win[data-display]');
  if (!b || e.touches.length !== 1) return;
  CTX.fired = false;
  const x0 = e.touches[0].clientX, y0 = e.touches[0].clientY;
  const cancel = () => { clearTimeout(CTX.timer); b.removeEventListener('touchmove', onMove); };
  const onMove = (ev) => { if (Math.hypot(ev.touches[0].clientX - x0, ev.touches[0].clientY - y0) > 10) cancel(); };
  b.addEventListener('touchmove', onMove, { passive: true });
  b.addEventListener('touchend', cancel, { once: true, passive: true });
  CTX.timer = setTimeout(() => { CTX.fired = true; cancel(); openCtx(b); }, 480);
}, { passive: true });
// A long press must not also open the window when the finger lifts.
$('#tab-mac').addEventListener('click', (e) => { if (CTX.fired) { CTX.fired = false; e.stopPropagation(); e.preventDefault(); } }, true);

function openCtx(b) {
  haptic();
  const id = b.dataset.id ? Number(b.dataset.id) : null;
  const display = b.dataset.display ? Number(b.dataset.display) : null;
  CTX.w = { id, display, el: b };
  const img = b.querySelector('img[data-thumb]');
  $('#ctxImg').src = img?.getAttribute('src') || '';
  $('[data-ctx=front]').hidden = !id;
  $('[data-ctx=screen]').hidden = !!display;
  $('#ctx').hidden = false;
}
function closeCtx() { $('#ctx').hidden = true; CTX.w = null; }
$('#ctx').addEventListener('click', (e) => {
  const a = e.target.closest('[data-ctx]');
  const w = CTX.w;
  closeCtx();
  if (!a || !w) return;
  haptic();
  if (a.dataset.ctx === 'open') w.el.click();
  else if (a.dataset.ctx === 'front') { send({ t: 'focus', id: w.id }); toast('Brought to the front on your Mac.', null, null, 1600); }
  else if (a.dataset.ctx === 'screen') { const d = S.displays.find((x) => x.main) || S.displays[0]; if (d) openView({ kind: 'display', id: d.id, label: 'Whole screen', title: d.name }); }
});

function renderNeeds() {
  const hits = S.needs || [];
  const html = hits.map((h, i) => {
    const w = windowById(h.id);
    // The "go ahead" answer (Yes, Allow, Approve...) is highlighted; never "Don't Allow" or "No".
    const acts = (h.actions || []);
    const main = acts.findIndex((a) => /^(\W*)(yes|allow|approve|accept|continue|ok|run|trust|proceed)\b/i.test(a.label) && !/don.?t|not\b/i.test(a.label));
    const actsHtml = acts.map((a, j) => `<button class="ans ${j === main ? 'first' : ''}" data-answer="${i}:${j}">${esc(a.label)}</button>`).join('');
    return `<div class="need" data-need="${h.id}">
      <div class="need-head"><img src="${h.app === 'macOS' ? '/macos.svg' : iconUrl(w)}" alt=""><div><b>${esc(h.app)}</b><span>${esc(shortTitle(w) || 'is asking')}</span></div>${thumbImg(h.id, 't')}<svg class="go" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></div>
      <p>${esc(h.reason)}</p>
      ${actsHtml ? `<div class="answers">${actsHtml}</div>` : '<p class="need-hint">Tap to open it</p>'}</div>`;
  }).join('');
  setHtml($('#needs'), html);
  $('#needsWrap').hidden = !html;
  // The number on the home screen icon (where the iPhone allows it: the secure address).
  try { if (hits.length) navigator.setAppBadge?.(hits.length); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
  // In the viewer, a chip offers a jump to whatever else is waiting.
  const other = hits.find((h) => !S.view || h.id !== S.view.id);
  const chip = $('#needsChip');
  chip.hidden = !(S.view && other);
  if (other) { chip.textContent = `${other.app} needs you`; chip.onclick = () => { haptic(); const w = windowById(other.id); openView({ kind: 'window', id: other.id, label: other.app, title: w?.title || '' }); }; }
}

function answerNeed(btn) {
  const [i, j] = btn.dataset.answer.split(':').map(Number);
  const h = S.needs[i]; const a = h?.actions?.[j];
  if (!a) return;
  haptic();
  btn.classList.add('sending'); btn.textContent = 'Sending…';
  send({ t: 'answer', id: h.id, action: a });
}

// ---------- viewer ----------

const video = $('#video');
const canvas = $('#canvas');
const stage = $('#stage');
const ph = $('#ph');
const Z = { s: 1, cx: 0.5, cy: 0.5 }; // zoom: scale over "fit", and the target point at the view centre
let target = { w: 1, h: 1 }; // what is streamed, in Mac points
let shownCrop = { x: 0, y: 0, w: 1, h: 1 };
let pendingCrop = null;

function openView(v, fromEl) {
  S.view = v;
  remember(v);
  $('#viewer').hidden = false;
  $('#vApp').textContent = v.label || '';
  $('#vTitle').textContent = v.kind === 'window' ? (v.title && v.title !== v.label ? v.title : '') : v.title;
  $('#needsChip').hidden = true; $('#typeBubble').hidden = true;
  closeSheets();
  Z.s = 1; Z.cx = 0.5; Z.cy = 0.5;
  shownCrop = { x: 0, y: 0, w: 1, h: 1 }; pendingCrop = null;
  // Start with the last picture of the window in place, so it feels instant while video connects.
  const w = v.kind === 'window' ? windowById(v.id) : S.displays.find((d) => d.id === v.id);
  if (w?.frame) { target.w = w.frame.w; target.h = w.frame.h; }
  const thumbId = v.kind === 'window' ? v.id : 'd' + v.id;
  if (thumbUrl(thumbId)) { ph.src = thumbUrl(thumbId); ph.hidden = false; } else ph.hidden = true;
  video.style.opacity = 0;
  canvas.hidden = true;
  layoutVideo();
  if (fromEl) zoomFrom(fromEl);
  updateZoomPill();
  showBar();
  if (S.mac.displayAsleep || S.mac.screensaver) send({ t: 'wake' });
  startView(v);
  if (!store.get('guideSeen', false)) setTimeout(() => { if (S.view) $('#guide').hidden = false; }, 600);
}

/** A short zoom from the tapped tile into the full viewer. */
function zoomFrom(el) {
  const r = el.querySelector('.thumb')?.getBoundingClientRect() || el.getBoundingClientRect();
  const v = $('#viewer');
  v.style.transformOrigin = `${r.left + r.width / 2}px ${r.top + r.height / 2}px`;
  v.animate?.([{ transform: `scale(${Math.max(0.2, r.width / innerWidth)})`, opacity: 0.4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function startView(v, reconnecting) {
  if (reconnecting) setViewerStatus('Reconnecting');
  else setViewerStatus(ph.hidden ? 'Connecting video' : null);
  S.firstFrame = false;
  if (!S.basic && typeof RTCPeerConnection === 'undefined') S.basic = true; // no live video in this browser
  video.hidden = S.basic;
  const fit = v.kind === 'window' && S.layout && portrait();
  send({ t: 'view', kind: v.kind, id: v.id, label: v.label, crop: Z.s > 1.02 ? visibleCrop(true) : { x: 0, y: 0, w: 1, h: 1 }, phoneLayout: fit, fit: fitArea(), basic: S.basic });
  if (!S.basic) {
    clearTimeout(S.fallbackTimer);
    // If live video cannot get through within 8 seconds, switch to basic video automatically.
    S.fallbackTimer = setTimeout(() => {
      if (S.view === v && !S.firstFrame && !S.basic) { setBasic(true); toast('Using basic video on this connection.'); }
    }, 8000);
  }
}

function closeViewer() {
  send({ t: 'stop' });
  closeRtc();
  S.view = null;
  $('#viewer').hidden = true;
  closeSheets(); $('#keys').hidden = true; $('#guide').hidden = true;
  hideLoupe();
  $('#msg').blur();
  video.srcObject = null;
  refreshWindows(true);
  renderWindows();
}
$('#back').onclick = () => { haptic(); closeViewer(); };

function setViewerStatus(text, btnText, onBtn) {
  if (!S.view) return;
  const el = $('#vstatus');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('stopped', !!btnText);
  $('#vstatusText').textContent = text;
  const b = $('#vstatusBtn');
  b.hidden = !btnText;
  if (btnText) { b.textContent = btnText; b.onclick = () => { haptic(); onBtn?.(); }; }
}

function checkViewerStatus() {
  const m = S.mac;
  if (m.locked) setViewerStatus('Your Mac is locked. Unlock it at the Mac, then come back here.', 'Check again', () => startView(S.view));
  else if (m.displayAsleep || m.screensaver) setViewerStatus('Your Mac screen is asleep.', 'Wake it', () => send({ t: 'wake' }));
  else if (m.helper === false) setViewerStatus('The Mac helper is restarting');
  else if (S.firstFrame || !ph.hidden) setViewerStatus(null);
}

// WebRTC
function closeRtc() {
  clearTimeout(S.fallbackTimer);
  if (S.pc) { try { S.pc.close(); } catch { /* closed */ } }
  S.pc = null; S.channel = null; S.rtcState = 'closed';
}

async function onOffer(sdp, oid) {
  closeRtc();
  const pc = new RTCPeerConnection({ iceServers: [] });
  S.pc = pc;
  pc.ontrack = (e) => {
    const ms = e.streams[0] || new MediaStream([e.track]);
    try { e.receiver.jitterBufferTarget = 0; } catch { /* not supported */ }
    try { e.receiver.playoutDelayHint = 0; } catch { /* not supported */ }
    video.srcObject = ms;
    video.play().catch(() => {});
  };
  pc.ondatachannel = (e) => {
    S.channel = e.channel;
    e.channel.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ } };
  };
  pc.onconnectionstatechange = () => {
    S.rtcState = pc.connectionState;
    if (S.pc !== pc) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setViewerStatus('Reconnecting video');
      clearTimeout(S.rtcRetry);
      S.rtcRetry = setTimeout(() => { if (S.pc === pc && pc.connectionState !== 'connected' && S.view && !S.basic) send({ t: 'restartVideo' }); }, pc.connectionState === 'failed' ? 200 : 2500);
    }
  };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
  } catch (e) { console.warn('video offer not used', e); return; }
  // Wait briefly for this phone's candidates; the Mac also learns the address from the first check.
  await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 1200); });
  if (S.pc !== pc) return; // a newer offer arrived meanwhile
  send({ t: 'rtcAnswer', sdp: pc.localDescription.sdp, oid });
}

video.addEventListener('resize', () => layoutVideo());
video.addEventListener('playing', () => firstFrame());
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const tick = () => { if (video.videoWidth) firstFrame(); video.requestVideoFrameCallback(tick); };
  video.requestVideoFrameCallback(tick);
}
function firstFrame() {
  if (S.firstFrame || !S.view) return;
  S.firstFrame = true;
  clearTimeout(S.fallbackTimer);
  video.style.opacity = 1;
  setTimeout(() => { if (S.firstFrame) ph.hidden = true; }, 150);
  setViewerStatus(null);
  checkViewerStatus();
  layoutVideo();
}

const cropByGen = new Map();
function onStreamInfo(m) {
  target.w = m.frame.w; target.h = m.frame.h;
  pendingCrop = m.crop;
  if (m.gen !== undefined) cropByGen.set(m.gen, m.crop);
  if (cropByGen.size > 20) cropByGen.delete(cropByGen.keys().next().value);
  // Normally the region switches when its first frame is on screen (see onFrameGen); this is a
  // safety net in case that message is missed.
  clearTimeout(S.cropTimer);
  S.cropTimer = setTimeout(applyPendingCrop, S.basic ? 0 : 400);
  S.macScale = m.scale || 2;
  layoutVideo();
  // Give "Fit window to phone" a moment to reshape the window before suggesting a turn.
  clearTimeout(S.rotCheck); S.rotCheck = setTimeout(maybeRotateHint, 1200);
}
// A wide picture on an upright phone: suggest turning the phone (once per window, briefly).
let hintShownFor = null;
function maybeRotateHint() {
  const wide = target.w / target.h > 1.3 && portrait() && Z.s <= 1.02;
  const key = S.view && `${S.view.kind}${S.view.id}`;
  const h = $('#rotateHint');
  if (!wide || !S.view || hintShownFor === key) { if (!wide) h.hidden = true; return; }
  hintShownFor = key;
  h.hidden = false;
  clearTimeout(S.rotTimer);
  S.rotTimer = setTimeout(() => { h.hidden = true; }, 4500);
}
/** The first frame of a new region has been sent: switch when it reaches the screen. */
function onFrameGen(gen) {
  const crop = cropByGen.get(gen);
  if (!crop) return;
  const wait = Math.min(120, Math.max(0, (S.est?.jbMs ?? 15) + (S.est?.decodeMs ?? 3)));
  setTimeout(() => { if (pendingCrop === crop || (pendingCrop && JSON.stringify(pendingCrop) === JSON.stringify(crop))) { clearTimeout(S.cropTimer); applyPendingCrop(); } else { shownCrop = crop; layoutVideo(); } }, wait);
}
function applyPendingCrop() { if (pendingCrop) { shownCrop = pendingCrop; pendingCrop = null; layoutVideo(); } }

// Geometry: where the whole target sits on screen at the current zoom. The space under the top
// bar and above the message bar is used, so nothing important hides behind them.
function stageBox() {
  const W = stage.clientWidth;
  const barTop = $('#compose').getBoundingClientRect().top;
  const H = Math.max(100, Math.min(stage.clientHeight, barTop || stage.clientHeight));
  const top = portrait() ? Math.min(56, H * 0.07) : 0;
  return { W, H, top };
}
/** The phone area the picture gets (between the top bar and the message bar), in points. */
function fitArea() { const b = stageBox(); return { w: Math.round(b.W), h: Math.round(b.H - b.top) }; }
function fitRect() {
  const { W, H, top } = stageBox();
  const aspect = target.w / target.h;
  const availH = H - top;
  let fw = W, fh = W / aspect;
  if (fh > availH) { fh = availH; fw = availH * aspect; }
  const dw = fw * Z.s, dh = fh * Z.s;
  let x = W / 2 - Z.cx * dw, y = top + availH / 2 - Z.cy * dh;
  // Keep the picture on screen: centred if smaller, edges pinned if larger.
  x = dw <= W ? (W - dw) / 2 : Math.min(0, Math.max(W - dw, x));
  y = dh <= availH ? top + (availH - dh) / 2 : Math.min(top, Math.max(H - dh, y));
  return { x, y, w: dw, h: dh, W, H, top };
}

function place(el, r, c) {
  el.style.width = `${c.w * r.w}px`;
  el.style.height = `${c.h * r.h}px`;
  el.style.transform = `translate(${r.x + c.x * r.w}px, ${r.y + c.y * r.h}px)`;
}
function layoutVideo() {
  if (!S.view) return;
  const r = fitRect();
  place(S.basic ? canvas : video, r, shownCrop);
  place(ph, r, { x: 0, y: 0, w: 1, h: 1 });
}

/** The part of the target visible now (0...1), with a margin so small pans stay sharp. */
function visibleCrop(pad) {
  const r = fitRect();
  let x0 = Math.max(0, -r.x / r.w), y0 = Math.max(0, (r.top - r.y) / r.h);
  let x1 = Math.min(1, (r.W - r.x) / r.w), y1 = Math.min(1, (r.H - r.y) / r.h);
  if (pad) {
    const px = (x1 - x0) * 0.12, py = (y1 - y0) * 0.12;
    x0 = Math.max(0, x0 - px); y0 = Math.max(0, y0 - py); x1 = Math.min(1, x1 + px); y1 = Math.min(1, y1 + py);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

let cropTimer;
function requestCrop() {
  clearTimeout(cropTimer);
  cropTimer = setTimeout(() => send({ t: 'crop', crop: Z.s > 1.02 ? visibleCrop(true) : { x: 0, y: 0, w: 1, h: 1 } }), 120);
}

function updateZoomPill() {
  const p = $('#zoomPill');
  p.hidden = Z.s <= 1.02;
  p.textContent = `${Z.s.toFixed(1)}×  ·  reset`;
}
function resetZoom() { Z.s = 1; Z.cx = 0.5; Z.cy = 0.5; layoutVideo(); updateZoomPill(); requestCrop(); }
$('#zoomPill').onclick = () => { haptic(); resetZoom(); };

/** Keep the zoom centre where the picture still covers the view (no dead zone at the edges). */
function clampCentre() {
  const { W, H, top } = stageBox();
  const r = fitRect();
  const availH = H - top;
  const hx = r.w > W ? W / (2 * r.w) : 0.5, hy = r.h > availH ? availH / (2 * r.h) : 0.5;
  Z.cx = Math.min(1 - hx, Math.max(hx, Z.cx));
  Z.cy = Math.min(1 - hy, Math.max(hy, Z.cy));
}

/** Stage point (CSS px) to target position (0...1), and back. */
function toTarget(px, py) { const r = fitRect(); return { x: (px - r.x) / r.w, y: (py - r.y) / r.h }; }
function toStage(nx, ny) { const r = fitRect(); return { x: r.x + nx * r.w, y: r.y + ny * r.h }; }
const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const clamp01 = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });
function pointsPerCssPx() { return target.w / fitRect().w; }

// ---------- touch ----------
//
// One finger: tap = click (near-misses snap to the nearest button), swipe = scroll (pans instead
// when zoomed in), touch and hold = magnifier for exact aim and lift to click, keep holding = grab
// and drag, tap then touch-and-move = drag. Two fingers: pinch = zoom, swipe = scroll, tap = right click.

const ring = $('#ring'), hl = $('#hl'), pointer = $('#pointer'), loupe = $('#loupe');
function showRing(x, y, kind) {
  ring.style.left = `${x}px`; ring.style.top = `${y}px`;
  ring.className = 'ring';
  void ring.offsetWidth;
  ring.className = `ring ${kind || ''} go`;
}

const T = { mode: null, start: null, last: null, holdTimer: null, grabTimer: null, lastTap: { t: 0, x: 0, y: 0, n: 0, end: 0 }, two: null, scroll: null, momentum: null, seq: 0 };
const pt = (t) => { const b = stage.getBoundingClientRect(); return { x: t.clientX - b.left, y: t.clientY - b.top }; };
const input = (e) => sendFast({ t: 'input', e });
const HOLD_MS = 320, GRAB_MS = 650, MOVE_PX = 9;

// Swipe in from the left edge = back, like other iPhone apps.
const EDGE = { on: false };
$('#viewer').addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  EDGE.on = e.touches.length === 1 && t.clientX < 18 && !T.mode && (stage.contains(e.target) || $('#vstatus').contains(e.target));
  if (EDGE.on) { EDGE.x0 = t.clientX; EDGE.y0 = t.clientY; e.stopPropagation(); e.preventDefault(); }
}, { capture: true, passive: false });
$('#viewer').addEventListener('touchmove', (e) => {
  if (!EDGE.on) return;
  e.stopPropagation(); e.preventDefault();
  const dx = Math.max(0, e.touches[0].clientX - EDGE.x0);
  $('#viewer').style.transform = `translateX(${dx}px)`;
}, { capture: true, passive: false });
$('#viewer').addEventListener('touchend', (e) => {
  if (!EDGE.on) return;
  EDGE.on = false; e.stopPropagation(); e.preventDefault();
  const v = $('#viewer');
  const dx = e.changedTouches[0].clientX - EDGE.x0;
  if (dx > innerWidth * 0.3) {
    haptic();
    v.animate?.([{ transform: v.style.transform }, { transform: `translateX(${innerWidth}px)` }], { duration: 160, easing: 'ease-out' });
    setTimeout(() => { v.style.transform = ''; closeViewer(); }, 150);
  } else {
    v.animate?.([{ transform: v.style.transform }, { transform: 'translateX(0)' }], { duration: 160, easing: 'ease-out' });
    v.style.transform = '';
  }
}, { capture: true, passive: false });

stage.addEventListener('touchstart', (e) => {
  e.preventDefault();
  cancelMomentum();
  showBar();
  closeSheets(); $('#typeBubble').hidden = true;
  if (document.activeElement === $('#msg') && !$('#msg').value) $('#msg').blur();
  const ts = e.touches;
  if (ts.length === 1) {
    const p = pt(ts[0]);
    const L = T.lastTap;
    const now = performance.now();
    // Touching again right after a tap: if this one moves, it is a drag ("tap and a half").
    T.mode = now - L.end < 300 && Math.hypot(p.x - L.x, p.y - L.y) < 36 ? 'maybeDrag' : 'pending';
    T.start = { ...p, t: now }; T.last = p;
    clearTimeout(T.holdTimer);
    T.holdTimer = setTimeout(() => { if (T.mode === 'pending' || T.mode === 'maybeDrag') startLoupe(T.last); }, HOLD_MS);
  } else if (ts.length === 2) {
    clearTimeout(T.holdTimer); clearTimeout(T.grabTimer);
    if (T.mode === 'drag' || T.mode === 'grab') endDrag();
    hideLoupe();
    const a = pt(ts[0]), b = pt(ts[1]);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    flushScroll();
    T.mode = 'two';
    T.two = { d0: Math.hypot(a.x - b.x, a.y - b.y), s0: Z.s, c0: c, anchor: toTarget(c.x, c.y), t0: performance.now() };
    T.scroll = { last: c, vx: 0, vy: 0, lt: performance.now(), began: false };
  }
}, { passive: false });

stage.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const ts = e.touches;
  if (ts.length === 1 && T.start) {
    const p = pt(ts[0]);
    const moved = Math.hypot(p.x - T.start.x, p.y - T.start.y) > MOVE_PX;
    if (T.mode === 'maybeDrag' && moved) { clearTimeout(T.holdTimer); beginDrag(T.start); }
    else if (T.mode === 'pending' && moved) {
      clearTimeout(T.holdTimer);
      T.mode = Z.s > 1.02 ? 'pan' : 'scroll1';
      T.scroll = { last: T.start, vx: 0, vy: 0, lt: performance.now(), began: false };
      T.pan = { x: T.start.x, y: T.start.y };
    }
    if (T.mode === 'scroll1') scrollMove(p);
    else if (T.mode === 'pan') {
      const r = fitRect();
      Z.cx -= (p.x - T.pan.x) / r.w;
      Z.cy -= (p.y - T.pan.y) / r.h;
      clampCentre();
      T.pan = { x: p.x, y: p.y };
      layoutVideo();
    } else if (T.mode === 'loupe') {
      T.last = p; moveLoupe(p);
      if (Math.hypot(p.x - T.loupeAnchor.x, p.y - T.loupeAnchor.y) > 6) { T.loupeAnchor = p; armGrab(); }
    } else if (T.mode === 'drag' || T.mode === 'grab') {
      T.last = p;
      if (T.mode === 'grab') moveLoupe(p);
      ring.style.left = `${p.x}px`; ring.style.top = `${p.y}px`;
      if (!T.raf) T.raf = requestAnimationFrame(() => { T.raf = 0; const q = clamp01(toTarget(T.last.x, T.last.y)); input({ kind: 'move', x: q.x, y: q.y }); });
    }
  } else if (ts.length === 2 && ['two', 'pinch', 'scroll2'].includes(T.mode)) {
    const a = pt(ts[0]), b = pt(ts[1]);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (T.mode === 'two') {
      if (Math.abs(d / T.two.d0 - 1) > 0.08) T.mode = 'pinch';
      else if (Math.hypot(c.x - T.two.c0.x, c.y - T.two.c0.y) > 10) T.mode = 'scroll2';
    }
    if (T.mode === 'pinch') {
      Z.s = Math.min(maxZoom(), Math.max(1, T.two.s0 * d / T.two.d0));
      // Keep the point that was under the fingers under the fingers.
      const r = fitRect();
      Z.cx = Math.min(1, Math.max(0, (r.W / 2 - (c.x - T.two.anchor.x * r.w)) / r.w));
      Z.cy = Math.min(1, Math.max(0, (r.top + (r.H - r.top) / 2 - (c.y - T.two.anchor.y * r.h)) / r.h));
      clampCentre();
      layoutVideo(); updateZoomPill();
    } else if (T.mode === 'scroll2') scrollMove(c);
  }
}, { passive: false });

stage.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (e.touches.length > 0) return;
  clearTimeout(T.holdTimer);
  const mode = T.mode;
  T.mode = null;
  if (mode === 'pending' || mode === 'maybeDrag') tap(T.start);
  else if (mode === 'loupe') { clearTimeout(T.grabTimer); const p = T.last; hideLoupe(); click(p, { precise: true }); }
  else if (mode === 'drag' || mode === 'grab') endDrag();
  else if (mode === 'scroll1' || mode === 'scroll2') startMomentum();
  else if (mode === 'pan' || mode === 'pinch') requestCrop();
  else if (mode === 'two' && performance.now() - T.two.t0 < 350) {
    // Two-finger tap = right click, like a Mac trackpad.
    const p = T.two.c0;
    showRing(p.x, p.y, 'right'); haptic();
    const q = toTarget(p.x, p.y);
    if (inside(q)) input({ kind: 'click', button: 'right', x: q.x, y: q.y, count: 1 });
  }
}, { passive: false });
stage.addEventListener('touchcancel', () => {
  clearTimeout(T.holdTimer); clearTimeout(T.grabTimer);
  if (T.mode === 'drag' || T.mode === 'grab') endDrag();
  hideLoupe(); T.mode = null; ring.className = 'ring';
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

function tap(p) {
  const now = performance.now();
  const L = T.lastTap;
  const n = now - L.t < 380 && Math.hypot(p.x - L.x, p.y - L.y) < 30 ? Math.min(3, L.n + 1) : 1;
  T.lastTap = { t: now, x: p.x, y: p.y, n, end: now };
  click(p, { count: n });
}

function click(p, { count = 1, precise = false } = {}) {
  const q = toTarget(p.x, p.y);
  if (!inside(q)) return;
  showRing(p.x, p.y, precise ? 'precise' : '');
  haptic();
  // A fingertip covers about 14 screen points; tell the Mac how far to look for a button.
  const snap = precise || count > 1 ? 0 : 14 * pointsPerCssPx();
  input({ kind: 'click', button: 'left', x: q.x, y: q.y, count, snap, seq: ++T.seq });
}

/** The Mac says where the click really landed: slide the ring there and outline what was hit. */
function onClicked(m) {
  if (!S.view) return;
  const at = toStage(m.x, m.y);
  ring.style.left = `${at.x}px`; ring.style.top = `${at.y}px`;
  if (m.rect) {
    const a = toStage(m.rect.x, m.rect.y);
    const r = fitRect();
    hl.style.transform = `translate(${a.x - 3}px, ${a.y - 3}px)`;
    hl.style.width = `${m.rect.w * r.w + 6}px`; hl.style.height = `${m.rect.h * r.h + 6}px`;
    hl.className = 'hl'; void hl.offsetWidth; hl.className = 'hl go';
  }
}

function onTextFocus(m) {
  const b = $('#typeBubble');
  if (!m.on || document.activeElement === $('#msg')) { b.hidden = true; return; }
  const { H } = stageBox();
  const r = m.rect ? toStage(m.rect.x, m.rect.y + m.rect.h) : null;
  b.style.top = `${Math.min(H - 60, Math.max(70, r ? r.y + 8 : H - 120))}px`;
  b.hidden = false;
  clearTimeout(S.bubbleTimer);
  S.bubbleTimer = setTimeout(() => { b.hidden = true; }, 7000);
}
$('#typeBubble').onclick = () => { $('#typeBubble').hidden = true; $('#msg').focus(); };

// Magnifier (hold) for exact aim. Lift to click; hold still a moment longer to grab and drag.
const lctx = loupe.getContext('2d');
function startLoupe(p) {
  T.mode = 'loupe';
  T.last = p; T.loupeAnchor = p;
  haptic();
  pointer.hidden = false;
  loupe.hidden = false;
  moveLoupe(p);
  armGrab();
  drawLoupe();
}
function armGrab() {
  clearTimeout(T.grabTimer);
  T.grabTimer = setTimeout(() => { if (T.mode === 'loupe') beginDrag(T.last, true); }, GRAB_MS);
}
function moveLoupe(p) {
  pointer.style.transform = `translate(${p.x}px, ${p.y}px)`;
  const size = 150;
  const lx = Math.min(innerWidth - size - 6, Math.max(6, p.x - size / 2));
  const ly = p.y - size - 70 < 50 ? p.y + 70 : p.y - size - 70;
  loupe.style.transform = `translate(${lx}px, ${ly}px)`;
}
function drawLoupe() {
  if (loupe.hidden) return;
  // Magnify the live picture, or the last still picture until live video arrives.
  const live = S.basic ? canvas.width > 0 : video.videoWidth > 0;
  const src = live ? (S.basic ? canvas : video) : ph;
  const vw = live ? (S.basic ? canvas.width : video.videoWidth) : ph.naturalWidth;
  const vh = live ? (S.basic ? canvas.height : video.videoHeight) : ph.naturalHeight;
  const p = T.last;
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 300, 300);
  if (vw && p) {
    const r = fitRect();
    const c = src === ph ? { x: 0, y: 0, w: 1, h: 1 } : shownCrop;
    // Point under the finger in picture pixels.
    const nx = ((p.x - r.x) / r.w - c.x) / c.w, ny = ((p.y - r.y) / r.h - c.y) / c.h;
    const pxPerCss = vw / (c.w * r.w);
    const half = (150 / 2.6) * pxPerCss / 2; // about 2.6x magnification
    try { lctx.drawImage(src, nx * vw - half, ny * vh - half, half * 2, half * 2, 0, 0, 300, 300); } catch { /* not ready */ }
  }
  lctx.strokeStyle = T.mode === 'grab' ? 'rgba(255, 143, 163, .95)' : 'rgba(255, 209, 102, .95)'; lctx.lineWidth = 3;
  lctx.beginPath(); lctx.moveTo(150, 118); lctx.lineTo(150, 182); lctx.moveTo(118, 150); lctx.lineTo(182, 150); lctx.stroke();
  requestAnimationFrame(drawLoupe);
}
function hideLoupe() { loupe.hidden = true; pointer.hidden = true; clearTimeout(T.grabTimer); }

function beginDrag(p, fromLoupe) {
  T.mode = fromLoupe ? 'grab' : 'drag';
  haptic();
  const q = clamp01(toTarget(p.x, p.y));
  input({ kind: 'down', x: q.x, y: q.y });
  ring.className = 'ring hold'; ring.style.left = `${p.x}px`; ring.style.top = `${p.y}px`;
  if (fromLoupe) pointer.classList.add('grab');
}
function endDrag() {
  const q = clamp01(toTarget(T.last.x, T.last.y));
  input({ kind: 'up', x: q.x, y: q.y });
  ring.className = 'ring';
  pointer.classList.remove('grab');
  hideLoupe();
}

// Scrolling, with momentum after the finger lifts.
let scrollAcc = null;
function scrollMove(c) {
  const now = performance.now();
  const dx = c.x - T.scroll.last.x, dy = c.y - T.scroll.last.y;
  const dt = Math.max(1, now - T.scroll.lt);
  T.scroll.vx = 0.7 * T.scroll.vx + 0.3 * (dx / dt); T.scroll.vy = 0.7 * T.scroll.vy + 0.3 * (dy / dt);
  T.scroll.last = c; T.scroll.lt = now;
  // Gather moves and send once per frame.
  if (!scrollAcc) {
    scrollAcc = { dx: 0, dy: 0, c, phase: T.scroll.began ? 'change' : 'begin' };
    requestAnimationFrame(flushScroll);
  }
  scrollAcc.dx += dx; scrollAcc.dy += dy; scrollAcc.c = c;
  T.scroll.began = true;
}
function sendScroll(dx, dy, phase, c) {
  const k = pointsPerCssPx();
  const q = clamp01(toTarget(c.x, c.y));
  input({ kind: 'scroll', x: q.x, y: q.y, dx: dx * k, dy: dy * k, phase });
}
/** Send any gathered scroll movement now (so it is never sent after the "end" of a scroll). */
function flushScroll() {
  if (!scrollAcc) return;
  const a = scrollAcc; scrollAcc = null;
  sendScroll(a.dx, a.dy, a.phase, a.c);
}
function startMomentum() {
  flushScroll();
  const c = T.scroll.last;
  let vx = T.scroll.vx * 16, vy = T.scroll.vy * 16; // px per frame
  sendScroll(0, 0, 'end', c);
  // A finger that stopped before lifting means no fling.
  if (performance.now() - T.scroll.lt > 80 || Math.hypot(vx, vy) < 2) return;
  let first = true;
  const step = () => {
    vx *= 0.95; vy *= 0.95;
    if (Math.hypot(vx, vy) < 0.5) { T.momentum = null; sendScroll(0, 0, 'mend', c); return; }
    sendScroll(vx, vy, first ? 'mbegin' : 'momentum', c);
    first = false;
    T.momentum = requestAnimationFrame(step);
  };
  T.momentum = requestAnimationFrame(step);
}
function cancelMomentum() { if (T.momentum) { cancelAnimationFrame(T.momentum); T.momentum = null; if (T.scroll) sendScroll(0, 0, 'mend', T.scroll.last); } }

/** Zoom until one Mac pixel is about one phone pixel (no point going further). */
function maxZoom() {
  const r = fitRect();
  const fitScale = (r.w / Z.s) / target.w; // CSS px per Mac point at "fit"
  const macPx = S.macScale || 2, phonePx = devicePixelRatio || 2;
  return Math.max(2.5, Math.min(8, (macPx / phonePx) / fitScale * 1.5));
}

// Mouse and trackpad, for using it from a desktop browser.
stage.addEventListener('mousedown', (e) => {
  if (e.sourceCapabilities?.firesTouchEvents) return;
  const b = stage.getBoundingClientRect(); const p = { x: e.clientX - b.left, y: e.clientY - b.top };
  if (e.button === 2) { const q = toTarget(p.x, p.y); if (inside(q)) input({ kind: 'click', button: 'right', x: q.x, y: q.y, count: 1 }); } else click(p, { count: e.detail || 1 });
});
stage.addEventListener('wheel', (e) => { e.preventDefault(); const b = stage.getBoundingClientRect(); sendScroll(-e.deltaX, -e.deltaY, 'change', { x: e.clientX - b.left, y: e.clientY - b.top }); }, { passive: false });
stage.addEventListener('contextmenu', (e) => e.preventDefault());

// Top bar fades after a few seconds of watching.
let barTimer;
function showBar() {
  $('#vbar').classList.remove('hide');
  clearTimeout(barTimer);
  barTimer = setTimeout(() => { if ($('#menu').hidden && $('#switcher').hidden) $('#vbar').classList.add('hide'); }, 3500);
}

// ---------- menu, switcher, guide ----------

$('#menuBtn').onclick = () => {
  haptic();
  syncSwitches();
  if ($('#menu').hidden) openSheet($('#menu')); else closeSheets();
  showBar();
};
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  haptic();
  const act = b.dataset.act;
  if (act === 'layout') { S.layout = !S.layout; store.set('layout', S.layout); send({ t: 'layout', on: S.layout && portrait(), fit: fitArea() }); syncSwitches(); return; }
  else if (act === 'return') { S.sendReturn = !S.sendReturn; store.set('sendReturn', S.sendReturn); syncSwitches(); return; }
  else if (act === 'basic') { setBasic(!S.basic); syncSwitches(); return; }
  else if (act === 'full') { const d = S.displays.find((x) => x.main) || S.displays[0]; if (d) openView({ kind: 'display', id: d.id, label: 'Whole screen', title: d.name }); }
  else if (act === 'gestures') $('#guide').hidden = false;
  else if (act === 'refresh') startView(S.view);
  closeSheets();
});

/** The iOS-style switches in the ... menu (the whole row is the control). */
function syncSwitches() {
  for (const [id, on] of [['#layoutState', S.layout], ['#returnState', S.sendReturn], ['#basicState', S.basic]]) {
    const el = $(id); el.className = 'switch' + (on ? ' on' : ''); el.textContent = on ? 'On' : 'Off';
  }
}

// ---------- sheets: dimmed background, tap outside or swipe down to close ----------

function openSheet(el) {
  closeSheets(true);
  $('#scrim').hidden = false;
  el.hidden = false;
  el.style.transform = '';
}
function closeSheets(quiet) {
  for (const el of [$('#menu'), $('#switcher')]) el.hidden = true;
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', () => closeSheets());
$('#scrim').addEventListener('touchstart', (e) => { e.preventDefault(); closeSheets(); }, { passive: false });
for (const sheet of [$('#menu'), $('#switcher')]) {
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    // Drag down from the top area, or anywhere when the sheet is scrolled to its top.
    const fromTop = e.touches[0].clientY - sheet.getBoundingClientRect().top < 44;
    y0 = (fromTop || sheet.scrollTop <= 0) ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    sheet.style.transition = 'transform .3s cubic-bezier(.2,.9,.25,1.05)';
    if (dy > 90) { sheet.style.transform = 'translateY(100%)'; setTimeout(() => { sheet.style.transition = ''; closeSheets(); }, 220); }
    else sheet.style.transform = '';
  });
}
$('#guideOk').onclick = () => { haptic(); store.set('guideSeen', true); $('#guide').hidden = true; };

$('#vTitleBtn').onclick = () => {
  haptic();
  const sw = $('#switcher');
  if (!sw.hidden) { closeSheets(); return; }
  send({ t: 'list' });
  const needIds = new Set((S.needs || []).map((n) => n.id));
  const list = [...S.windows.filter((w) => needIds.has(w.id)), ...recentWindows(), ...S.windows.filter((w) => w.onScreen && w.layer === 0)]
    .filter((w, i, a) => a.indexOf(w) === i && w.id !== S.view?.id).slice(0, 12);
  $('#switchGrid').innerHTML = list.map((w) => `<button class="sw" data-id="${w.id}"><div class="thumb">${thumbImg(w.id)}</div><span><img src="${iconUrl(w)}" alt="">${esc(shortTitle(w) || w.app)}</span>${needIds.has(w.id) ? '<i>needs you</i>' : ''}</button>`).join('')
    + S.displays.map((d) => `<button class="sw" data-display="${d.id}"><div class="thumb">${thumbImg('d' + d.id)}</div><span>${esc(d.name)}</span></button>`).join('');
  openSheet(sw);
  showBar();
};
$('#switchGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id],[data-display]');
  if (!b) return;
  haptic();
  closeSheets();
  if (b.dataset.display) { const d = S.displays.find((x) => x.id === Number(b.dataset.display)); return openView({ kind: 'display', id: d.id, label: 'Whole screen', title: d.name }); }
  const w = windowById(Number(b.dataset.id));
  if (w) openView({ kind: 'window', id: w.id, label: w.app, title: w.title });
});

function setBasic(on) {
  S.basic = on;
  video.hidden = on; canvas.hidden = !on;
  if (on) { closeRtc(); send({ t: 'basic', on: true }); }
  if (S.view) startView(S.view);
}

// Basic video: JPEG pictures over the WebSocket.
let basicBusy = false;
async function basicFrame(buf) {
  if (!S.basic || basicBusy || !S.view) return;
  basicBusy = true;
  try {
    const dv = new DataView(buf);
    const ml = dv.getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, ml)));
    const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 4 + ml)], { type: 'image/jpeg' }));
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    shownCrop = meta.crop; pendingCrop = null;
    canvas.hidden = false;
    S.basicFrames = (S.basicFrames || 0) + 1;
    if (!S.firstFrame) { S.firstFrame = true; clearTimeout(S.fallbackTimer); ph.hidden = true; setViewerStatus(null); checkViewerStatus(); }
    layoutVideo();
  } catch { /* skip a bad frame */ }
  basicBusy = false;
}

// ---------- quality and stats ----------

let prev = null;
setInterval(async () => {
  if (!S.view) return;
  if (S.basic) {
    const fps = S.basicFrames || 0; S.basicFrames = 0;
    setQuality('warn', 'basic', `Basic video, ${fps} pictures a second`);
    return;
  }
  if (!S.pc) return;
  S.pingId = (S.pingId || 0) + 1; S.pingAt = performance.now();
  sendFast({ t: 'ping', id: S.pingId });
  let inb = null, pair = null;
  try {
    const st = await S.pc.getStats();
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
      if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
    });
  } catch { return; }
  if (!inb) return;
  const now = { t: performance.now(), frames: inb.framesDecoded || 0, lost: inb.packetsLost || 0, recv: inb.packetsReceived || 0,
    jbd: inb.jitterBufferDelay || 0, jbe: inb.jitterBufferEmittedCount || 0, freezes: inb.freezeCount || 0, decode: inb.totalDecodeTime || 0, nack: inb.nackCount || 0 };
  if (prev) {
    const dt = (now.t - prev.t) / 1000;
    const frames = now.frames - prev.frames;
    const fps = Math.round(frames / dt);
    const lost = now.lost - prev.lost, recv = now.recv - prev.recv;
    const loss = recv + lost > 0 ? Math.max(0, lost) / (recv + lost) : 0;
    const jb = now.jbe > prev.jbe ? (now.jbd - prev.jbd) / (now.jbe - prev.jbe) : 0;
    const decodeMs = frames > 0 ? ((now.decode - prev.decode) / frames) * 1000 : 0;
    const rtt = pair?.currentRoundTripTime ?? (S.pingMs ? S.pingMs / 1000 : null);
    const nackRate = recv > 0 ? Math.max(0, now.nack - prev.nack) / recv : 0;
    sendFast({ t: 'stats', fps, loss, nackRate, rtt, jitterBuffer: jb, freezes: now.freezes - prev.freezes, decodeMs });
    S.est = { fps, rttMs: rtt != null ? rtt * 1000 : null, jbMs: jb * 1000, decodeMs, loss };
    renderQuality();
  }
  prev = now;
}, 1000);

function onQuality(m) { S.serverQ = m; renderQuality(); }
function renderQuality() {
  const e = S.est; if (!e) return;
  const mac = S.serverQ?.macDelayMs ?? 8;
  const delay = Math.round(mac + (e.rttMs ?? 20) / 2 + e.jbMs + e.decodeMs + 8);
  const kind = delay > 180 || e.loss > 0.05 ? 'bad' : delay > 100 ? 'warn' : 'good';
  setQuality(kind, `${delay} ms`, `${e.fps} frames a second, about ${delay} ms behind the Mac${S.serverQ ? `, ${(S.serverQ.bitrate / 1e6).toFixed(1)} Mbps` : ''}.`);
}
function setQuality(kind, text, detail) {
  const q = $('#quality');
  q.className = `qbadge ${kind}`;
  q.querySelector('span').textContent = text;
  q.dataset.detail = detail || text;
}
$('#quality').onclick = () => { haptic(); toast($('#quality').dataset.detail || 'Connecting'); };

// ---------- message bar and keys ----------

const msg = $('#msg');
const mods = new Set();
function autoGrow() { msg.style.height = 'auto'; msg.style.height = `${Math.min(120, msg.scrollHeight)}px`; layoutVideo(); }
msg.addEventListener('focus', () => { $('#keys').hidden = false; $('#typeBubble').hidden = true; setTimeout(layoutVideo, 300); });
msg.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== msg) { $('#keys').hidden = true; layoutVideo(); } }, 150); });
$('#keysBtn').onclick = () => { haptic(); const k = $('#keys'); k.hidden = !k.hidden; layoutVideo(); };

function sendMessage() {
  haptic();
  const text = msg.value;
  if (!text) { input({ kind: 'key', key: 'Return', mods: [] }); toast('Pressed return on the Mac.', null, null, 1200); return; }
  input({ kind: 'paste', text });
  if (S.sendReturn) setTimeout(() => input({ kind: 'key', key: 'Return', mods: [] }), 300);
  msg.value = ''; autoGrow();
  toast(S.sendReturn ? 'Sent to the Mac.' : 'Pasted into the Mac.', null, null, 1500);
}
/**
 * A button that never takes the focus, so the iPhone keyboard stays up while you use it. Touch acts
 * on lift (a swipe across the key row still scrolls it); mouse and keyboard act on click.
 */
function keepKeyboard(el, handler) {
  let t0 = null;
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY, target: e.target }; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!t0) return;
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 10;
    const target = t0.target; t0 = null;
    e.preventDefault(); // no blur, no extra click
    if (!moved) handler(target);
  });
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => handler(e.target));
}
keepKeyboard($('#send'), () => sendMessage());

// Return on the iPhone keyboard sends; dictation and paste can still add new lines.
msg.addEventListener('keydown', (e) => {
  // In live keys the box stays empty, and iPhone does not report Backspace in an empty box any
  // other way, so catch it here.
  if (S.live && e.key === 'Backspace') { e.preventDefault(); pressKey('Backspace'); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (S.live) pressKey('Return'); else sendMessage();
});
msg.addEventListener('input', () => {
  if (S.live) { if (msg.value) { input({ kind: 'text', text: msg.value }); msg.value = ''; } }
  else autoGrow();
});

// Live keys: every key goes straight to the Mac (for terminals and shortcuts).
keepKeyboard($('#liveBtn'), () => {
  haptic();
  S.live = !S.live;
  $('#liveBtn').classList.toggle('on', S.live);
  msg.placeholder = S.live ? 'Live: each key goes to the Mac' : 'Message to the Mac';
  msg.classList.toggle('live', S.live);
  // Live keys go to terminals and shortcuts: no automatic capitals or corrections.
  msg.setAttribute('autocapitalize', S.live ? 'off' : 'sentences');
  msg.setAttribute('autocorrect', S.live ? 'off' : 'on');
  msg.blur(); msg.focus(); // the keyboard picks up the new settings
  msg.focus();
});
msg.addEventListener('beforeinput', (e) => {
  if (!S.live) return;
  const t = e.inputType;
  if (t === 'insertText' && e.data) { e.preventDefault(); if (mods.size && e.data.length === 1) pressKey(e.data); else input({ kind: 'text', text: e.data }); }
  else if (t === 'deleteContentBackward') { e.preventDefault(); pressKey('Backspace'); }
  else if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); pressKey('Return'); }
  else if (t === 'insertFromPaste' || t === 'insertReplacementText') { e.preventDefault(); const tx = e.dataTransfer?.getData('text/plain') || e.data || ''; if (tx) input({ kind: 'paste', text: tx }); }
});

// Special keys keep the iPhone keyboard up.
keepKeyboard($('#keys'), (t) => {
  const b = t.closest?.('button');
  if (!b || b.id === 'liveBtn') return;
  haptic();
  if (b.dataset.mod) { const m = b.dataset.mod; if (mods.has(m)) mods.delete(m); else mods.add(m); b.classList.toggle('on', mods.has(m)); return; }
  if (b.dataset.key) { pressKey(b.dataset.key); return; }
  if (b.dataset.combo) {
    const [m, k] = b.dataset.combo.split('+');
    input({ kind: 'key', key: k, mods: [m] });
    if (k === 'c') setTimeout(() => send({ t: 'clipboard' }), 350);
  }
});
function pressKey(key) {
  if (mods.has('cmd') && key.toLowerCase() === 'c') setTimeout(() => send({ t: 'clipboard' }), 350);
  input({ kind: 'key', key, mods: [...mods] });
  mods.clear(); $$('#keys [data-mod]').forEach((b) => b.classList.remove('on'));
}

// After Copy on the Mac, offer that text on the iPhone.
function onClipboard(text) {
  if (!text) return;
  const short = text.length > 60 ? text.slice(0, 57) + '…' : text;
  toast(`Copied on the Mac: "${short}"`, 'Copy to iPhone', () => copyText(text), 7000);
}

// Keep the message bar above the iPhone keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const lift = () => {
    const covered = Math.max(0, innerHeight - (vv.height + vv.offsetTop));
    $('#compose').style.transform = covered ? `translateY(${-covered}px)` : '';
    $('#compose').classList.toggle('kb-open', covered > 0);
    layoutVideo();
  };
  vv.addEventListener('resize', lift);
  vv.addEventListener('scroll', lift);
}

// ---------- copying to the iPhone ----------

function copyText(text) {
  toast(copyQuiet(text) ? 'Copied.' : 'Could not copy here.', null, null, 1800);
}
/** Copies to the iPhone's clipboard; true when it worked. It must run during a tap. */
function copyQuiet(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ---------- pull to refresh ----------

function pullToRefresh(el, onRefresh) {
  const ind = document.createElement('div');
  ind.className = 'ptr'; ind.innerHTML = '<div class="spinner"></div>';
  el.prepend(ind);
  let y0 = null, dy = 0;
  el.addEventListener('touchstart', (e) => { y0 = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0 && el.scrollTop <= 0) {
      const h = Math.min(70, dy * 0.45);
      ind.style.height = `${h}px`; ind.style.opacity = Math.min(1, h / 50);
      ind.classList.toggle('ready', h >= 50);
    }
  }, { passive: true });
  el.addEventListener('touchend', async () => {
    if (y0 === null) return;
    y0 = null;
    if (ind.classList.contains('ready')) {
      haptic();
      ind.classList.add('busy');
      try { await onRefresh(); } catch { /* shown elsewhere */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    ind.classList.remove('ready', 'busy');
    ind.style.height = '0px'; ind.style.opacity = 0;
  });
}
pullToRefresh($('#tab-mac'), async () => { if (!S.wsUp) dropAndReconnect(); refreshWindows(true); send({ t: 'needs' }); });

// ---------- start ----------

// The last window list is kept on the phone, so the app opens straight onto your windows.
let snapTimer;
function saveSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => store.set('snapshot', { windows: S.windows.slice(0, 30), displays: S.displays, thumbs: S.thumbs, at: Date.now() }), 1000);
}
(() => {
  const snap = store.get('snapshot', null);
  if (!snap || Date.now() - snap.at > 24 * 3600_000) return;
  S.windows = snap.windows || []; S.displays = snap.displays || []; S.thumbs = snap.thumbs || {};
  renderWindows();
  $('#main').hidden = false;
})();
async function boot() {
  clearTimeout(S.bootTimer);
  let me;
  // Give up after 5 seconds: an unreachable Mac can otherwise keep the phone waiting for a minute.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try { me = await (await fetch('/api/me', { cache: 'no-store', signal: ctl.signal })).json(); } catch { me = null; } finally { clearTimeout(timer); }
  if (!me) { $('#main').hidden = false; setConn('bad', 'Mac offline'); renderBanner(true); S.bootTimer = setTimeout(boot, 3000); return; }
  S.me = me;
  if (!me.paired) return showPair();
  $('#pair').hidden = true; $('#main').hidden = false;
  connect();
}
boot();
// On the secure address, keep a copy of the app for opening while the Mac is unreachable.
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
