/* Chores — modern card board. Vanilla JS, no build step. */

const LS = {
  get api() { return localStorage.getItem('cd_api') || ''; },
  set api(v) { localStorage.setItem('cd_api', v); },
  get pw() { return localStorage.getItem('cd_pw') || ''; },
  set pw(v) { localStorage.setItem('cd_pw', v); },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let STATE = null;
let pollTimer = null;

// deterministic pastel color from a name, for initials avatars
function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 58%)`;
}
function initials(name) {
  return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}
function avatarHTML(u, cls = 'avatar') {
  if (u.avatar && /^https?:\/\//i.test(u.avatar)) return `<img class="${cls}" src="${esc(u.avatar)}" alt="${esc(u.name)}" />`;
  return `<div class="${cls}" style="background:${colorFor(u.name)}">${esc(initials(u.name))}</div>`;
}

// ── API ────────────────────────────────────────────────────────
function base() { return (LS.api || '').replace(/\/$/, ''); }
async function api(path, opts = {}) {
  const res = await fetch(base() + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-house-password': LS.pw, ...(opts.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  return res.json();
}

// ── Login ──────────────────────────────────────────────────────
$('#apiBase').value = LS.api;
$('#loginBtn').addEventListener('click', doLogin);
$('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  LS.api = $('#apiBase').value.trim();
  $('#loginError').textContent = '';
  try {
    const res = await fetch(base() + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }),
    }).then((r) => r.json());
    if (!res.ok) { $('#loginError').textContent = 'Wrong password.'; return; }
    LS.pw = $('#password').value;
    enterApp();
  } catch { $('#loginError').textContent = 'Could not reach the server. Check the URL.'; }
}
function logout() { LS.pw = ''; clearInterval(pollTimer); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#logoutBtn').addEventListener('click', logout);

function enterApp() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  refresh();
  pollTimer = setInterval(refresh, 15000);
}
if (LS.pw) enterApp();

// ── Refresh / render ───────────────────────────────────────────
async function refresh() {
  try { STATE = await api('/api/state'); render(); } catch { /* handled in api() */ }
}

function render() {
  if (!STATE) return;
  $('#weekLabel').textContent = 'Week of ' + STATE.liveWeek.label;
  $('#channelBadge').textContent = STATE.channel;
  renderCards();
  renderChoreGuide();
  if (!$('#drawer').classList.contains('hidden')) renderDrawer();
}

function renderCards() {
  $('#cards').innerHTML = STATE.users.map(cardHTML).join('');
}

function renderChoreGuide() {
  const el = $('#choreGuide');
  if (!STATE.chores.length) { el.innerHTML = ''; return; }
  const items = STATE.chores.map((c, i) => `
    <div class="guide-item">
      <div class="guide-index">${String(i + 1).padStart(2, '0')}</div>
      <div class="guide-body">
        <div class="guide-name">${esc(c.name)}</div>
        <div class="guide-desc">${esc(c.description || 'No details added yet.')}</div>
      </div>
    </div>`).join('');
  el.innerHTML = `
    <h2 class="guide-title">Chore guide</h2>
    <p class="guide-sub">What each chore actually involves.</p>
    <div class="guide-list">${items}</div>`;
}

function cardHTML(u) {
  const allDone = u.total > 0 && u.done === u.total;
  const names = u.chores.map((c) => c.name).join('  +  ');

  const tooltip = u.chores.length
    ? `<div class="tooltip">${u.chores.map((c) => `<div class="row"><b>${esc(c.name)}</b>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ''}</div>`).join('')}</div>`
    : '';

  const choreBlock = u.away
    ? `<span class="out-badge">OUT</span>`
    : u.chores.length
      ? `<div class="chore ${u.chores.length > 1 ? 'multi' : ''}">${esc(names)}</div>${tooltip}`
      : `<div class="chore">No chore this week</div>`;

  const checkbox = u.away || u.total === 0
    ? ''
    : `<div class="checkbox ${allDone ? 'done' : ''}" onclick="togglePerson(${u.id})" role="checkbox" aria-checked="${allDone}" aria-label="Mark ${esc(u.name)}'s chore done">${CHECK_SVG}</div>`;

  // Nudge is available even when done — a chore may need doing again.
  const nudge = !u.away && u.total > 0
    ? `<button class="nudge-btn" onclick="nudge(${u.id})">Nudge</button>`
    : '';

  return `<div class="card ${u.away ? 'out' : ''}">
    <div class="card-left">
      ${avatarHTML(u)}
      <div class="name">${esc(u.name)}</div>
    </div>
    <div class="card-right">
      <div class="chore-wrap">${choreBlock}</div>
      ${checkbox}
      ${nudge}
    </div>
  </div>`;
}

// ── Actions ────────────────────────────────────────────────────
window.togglePerson = async (userId) => {
  const u = STATE.users.find((x) => x.id === userId);
  if (!u || !u.chores.length) return;
  const allDone = u.done === u.total;
  for (const c of u.chores) {
    if (allDone && c.status === 'done') await api(`/api/assignments/${c.id}/undo`, { method: 'POST' });
    else if (!allDone && c.status === 'todo') await api(`/api/assignments/${c.id}/done`, { method: 'POST' });
  }
  toast(allDone ? 'Marked not done' : `Nice — ${u.name}'s chore is done`);
  refresh();
};

window.nudge = async (toUserId) => {
  const message = prompt('Add a message to your nudge? (optional)') || '';
  await api('/api/nudge', { method: 'POST', body: JSON.stringify({ toUserId, message }) });
  toast('Nudge sent');
  refresh();
};

window.toggleAway = async (userId, away) => {
  await api('/api/away', { method: 'POST', body: JSON.stringify({ userId, away, week: STATE.liveWeek.start }) });
  toast(away ? 'Marked away — chore reassigned' : 'Welcome back');
  refresh();
};

// ── Settings drawer ────────────────────────────────────────────
$('#settingsBtn').addEventListener('click', openDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
function openDrawer() { $('#drawer').classList.remove('hidden'); $('#drawerScrim').classList.remove('hidden'); renderDrawer(); }
function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawerScrim').classList.add('hidden'); }

function renderDrawer() {
  const users = STATE.users.map((u) => `
    <div class="list-item">
      ${avatarHTML(u, 'li-av')}
      <div class="li-main">${esc(u.name)}<div class="li-sub">${u.phone ? esc(u.phone) : 'no number'}</div></div>
      <button class="x" onclick="delUser(${u.id})" title="Remove">✕</button>
    </div>`).join('');
  const chores = STATE.chores.map((c) => `
    <div class="list-item">
      <span class="li-av" style="background:#eef0f3;color:#374151">${c.icon || '•'}</span>
      <div class="li-main">${esc(c.name)}<div class="li-sub">${esc(c.description || '')}</div></div>
      <button class="x" onclick="delChore(${c.id})" title="Remove">✕</button>
    </div>`).join('');
  const feed = STATE.events.slice(0, 15).map((e) => `<div class="f">${esc(e.message)}<div class="ts">${esc(e.ts)}</div></div>`).join('');

  $('#drawer').innerHTML = `
    <button class="icon-btn close" onclick="closeDrawer()">✕</button>
    <h2>Settings</h2>
    <p class="hint">Manage roommates, chores, and messaging.</p>

    <h3>Roommates</h3>
    ${users}
    <div class="addrow"><input id="nuName" placeholder="Name" /><input id="nuPhone" placeholder="+1 phone (Signal)" /></div>
    <div class="addrow"><input id="nuAvatar" placeholder="Photo URL (optional)" /><button class="btn btn-sm" onclick="addUser()">Add</button></div>

    <h3>Chores</h3>
    ${chores}
    <div class="addrow"><input id="ncName" placeholder="Chore name" /></div>
    <div class="addrow"><input id="ncDesc" placeholder="Full details (shown on hover)" /><button class="btn btn-sm" onclick="addChore()">Add</button></div>

    <h3>Send now (testing)</h3>
    <p class="hint">These normally send on a schedule. Trigger one to preview it.</p>
    <div class="jobs">
      <button class="btn btn-sm" onclick="runJob('proposal')">Proposal (Sun)</button>
      <button class="btn btn-sm" onclick="runJob('final')">Final list (Mon)</button>
      <button class="btn btn-sm" onclick="runJob('reminders')">Reminders (Sat)</button>
    </div>

    <h3>Activity</h3>
    <div class="feed">${feed || '<div class="f">Nothing yet.</div>'}</div>`;
}
window.closeDrawer = closeDrawer;

window.addUser = async () => {
  const name = $('#nuName').value.trim(); if (!name) return;
  await api('/api/users', { method: 'POST', body: JSON.stringify({ name, phone: $('#nuPhone').value.trim(), avatar: $('#nuAvatar').value.trim() || undefined }) });
  refresh();
};
window.delUser = async (id) => { if (confirm('Remove this roommate?')) { await api('/api/users/' + id, { method: 'DELETE' }); refresh(); } };
window.addChore = async () => {
  const name = $('#ncName').value.trim(); if (!name) return;
  await api('/api/chores', { method: 'POST', body: JSON.stringify({ name, description: $('#ncDesc').value.trim() }) });
  refresh();
};
window.delChore = async (id) => { if (confirm('Remove this chore?')) { await api('/api/chores/' + id, { method: 'DELETE' }); refresh(); } };
window.runJob = async (job) => { await api('/api/admin/run/' + job, { method: 'POST' }); toast('Sent'); refresh(); };

// ── Toast ──────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
