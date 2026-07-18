/* Chores — modern card board. Vanilla JS, no build step. */

const CONFIG = window.CHORE_CONFIG || { apiBase: '', housePassword: '' };

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
  if (u.avatar && /^(https?:|data:image)/i.test(u.avatar)) return `<img class="${cls}" src="${esc(u.avatar)}" alt="${esc(u.name)}" />`;
  return `<div class="${cls}" style="background:${colorFor(u.name)}">${esc(initials(u.name))}</div>`;
}

// Resize/crop a chosen image file to a small square JPEG data URI and save it as
// the roommate's avatar. Keeps photos tiny (~256px) so they load fast.
window.uploadAvatar = (userId, input) => {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      api('/api/users/' + userId, { method: 'PATCH', body: JSON.stringify({ avatar: dataUrl }) })
        .then(() => { toast('Photo updated'); refresh(); });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};

// ── API ────────────────────────────────────────────────────────
function base() { return (CONFIG.apiBase || '').replace(/\/$/, ''); }
async function api(path, opts = {}) {
  const res = await fetch(base() + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-house-password': CONFIG.housePassword, ...(opts.headers || {}) },
  });
  return res.json();
}

// No sign-in — load the board immediately.
refresh();
pollTimer = setInterval(refresh, 15000);

// ── Refresh / render ───────────────────────────────────────────
async function refresh() {
  try {
    const s = await api('/api/state');
    if (!s || !Array.isArray(s.users)) throw new Error('unreachable');
    STATE = s;
    render();
  } catch {
    $('#cards').innerHTML = `<div class="conn-error">Can't reach the chore server.<br /><span>If you're away from the house wifi, the site needs the backend URL set in config.js.</span></div>`;
  }
}

function render() {
  if (!STATE) return;
  $('#weekLabel').textContent = 'Week of ' + STATE.liveWeek.label;
  renderCards();
  renderChoreGuide();
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

// ── Toast ──────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
