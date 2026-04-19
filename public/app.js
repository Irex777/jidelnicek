// ═══════════════════════════════════════════════════════════════════════
// Jídelníček v3 — Day-by-day generation, parallel week via SSE
// ═══════════════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────────────
let users = [];
let currentUser = null;
let currentWeek = getWeekStart(new Date());
let weekPlans = {}; // { "2026-04-20": { ...plan }, ... }
let selectedDay = 0;
let chatOpen = false;
let chatBusy = false;
let generating = false;

const DAY_NAMES_CS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const DAY_NAMES_FULL = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
const MEAL_TYPES = { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' };
const MEAL_ICONS = { breakfast: '🌅', morning_snack: '🍎', lunch: '🍲', afternoon_snack: '🥤', dinner: '🌙' };

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  setupTextareaResize();
});

// ── Week/Date Helpers ────────────────────────────────────────────────
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function getWeekDates() {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(currentWeek, i));
  return dates;
}

function formatDateRange(ws) {
  const s = new Date(ws);
  const e = new Date(s); e.setDate(e.getDate() + 6);
  const o = { day: 'numeric', month: 'short' };
  return `${s.toLocaleDateString('cs-CZ', o)} — ${e.toLocaleDateString('cs-CZ', o)}`;
}

function changeWeek(delta) {
  const d = new Date(currentWeek);
  d.setDate(d.getDate() + delta * 7);
  currentWeek = getWeekStart(d);
  weekPlans = {};
  selectedDay = 0;
  updateUI();
  if (currentUser) loadWeekPlans();
}

// ── Sidebar ──────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
}

// ── Users ────────────────────────────────────────────────────────────
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    users = await res.json();
    renderUsers();
    updateUI();
    if (users.length > 0) {
      const target = currentUser && users.find(u => u.id === currentUser.id) ? currentUser.id : users[0].id;
      selectUser(target, false);
    }
  } catch (e) { console.error('loadUsers:', e); }
}

function renderUsers() {
  const list = document.getElementById('userList');
  list.innerHTML = users.map(u => `
    <div class="user-item ${currentUser && currentUser.id === u.id ? 'active' : ''}" onclick="selectUser(${u.id})">
      <div class="user-avatar">${u.name.charAt(0).toUpperCase()}</div>
      <div class="user-info">
        <div class="name">${esc(u.name)}</div>
        <div class="meta">${u.weight_current || '?'}kg → ${u.weight_goal || '?'}kg · <span style="color:var(--green)">${u.calories_target || '?'} kcal</span></div>
      </div>
    </div>
  `).join('');
}

function renderChipBar() {
  const bar = document.getElementById('chipBar');
  if (!currentUser) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <button class="week-arrow" onclick="changeWeek(-1)">‹</button>
    ${users.map(u => `
      <div class="chip ${currentUser.id === u.id ? 'active' : ''}" onclick="selectUser(${u.id})">
        ${esc(u.name)} <span class="cal">${u.calories_target || '?'} kcal</span>
      </div>
    `).join('')}
    <button class="week-arrow" onclick="changeWeek(1)">›</button>
  `;
}

async function selectUser(id, loadPlans = true) {
  currentUser = users.find(u => u.id === id);
  renderUsers();
  updateUI();
  closeSidebar();
  if (loadPlans && currentUser) {
    await loadWeekPlans();
    loadChat();
  }
}

// ── User Modal ───────────────────────────────────────────────────────
function showUserModal(userId) {
  const modal = document.getElementById('userModal');
  const user = userId ? users.find(u => u.id === userId) : null;
  document.getElementById('userModalTitle').textContent = user ? 'Upravit profil' : 'Nový profil';
  document.getElementById('editUserId').value = user ? user.id : '';
  document.getElementById('fName').value = user ? user.name : '';
  document.getElementById('fSex').value = user ? (user.sex || '') : '';
  document.getElementById('fWeight').value = user ? (user.weight_current || '') : '';
  document.getElementById('fWeightGoal').value = user ? (user.weight_goal || '') : '';
  document.getElementById('fHeight').value = user ? (user.height || '') : '';
  document.getElementById('fAge').value = user ? (user.age || '') : '';
  const act = user ? (user.activity_level || 'moderate') : 'moderate';
  document.querySelectorAll('#fActivity button').forEach(b => {
    b.classList.toggle('active', b.dataset.v === act);
  });
  document.getElementById('fRestrictions').value = user ? (user.dietary_restrictions || '') : '';
  document.getElementById('fAllergies').value = user ? (user.allergies || '') : '';
  document.getElementById('fFavorites').value = user ? (user.favorite_foods || '') : '';
  modal.classList.add('active');
}

function closeUserModal() { document.getElementById('userModal').classList.remove('active'); }

function setSegment(btn) {
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function getSegmentedValue(id) {
  const active = document.querySelector(`#${id} button.active`);
  return active ? active.dataset.v : '';
}

async function saveUser() {
  const id = document.getElementById('editUserId').value;
  const data = {
    name: document.getElementById('fName').value,
    sex: document.getElementById('fSex').value || null,
    weight_current: parseFloat(document.getElementById('fWeight').value) || null,
    weight_goal: parseFloat(document.getElementById('fWeightGoal').value) || null,
    height: parseFloat(document.getElementById('fHeight').value) || null,
    age: parseInt(document.getElementById('fAge').value) || null,
    activity_level: getSegmentedValue('fActivity'),
    dietary_restrictions: document.getElementById('fRestrictions').value,
    allergies: document.getElementById('fAllergies').value,
    favorite_foods: document.getElementById('fFavorites').value,
  };
  if (!data.name) return;

  if (id) {
    await fetch(`/api/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } else {
    await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }
  closeUserModal();
  await loadUsers();
  if (!id && users.length > 0) selectUser(users[users.length - 1].id);
}

// ── Week Plans (new API) ─────────────────────────────────────────────
async function loadWeekPlans() {
  if (!currentUser) return;
  try {
    const dates = getWeekDates();
    const from = dates[0];
    const to = dates[6];
    const res = await fetch(`/api/plan/${currentUser.id}?from=${from}&to=${to}`);
    const plans = await res.json();
    weekPlans = {};
    plans.forEach(p => { weekPlans[p.date] = p; });
    renderDayTabs();
    renderContent();
  } catch (e) { console.error('loadWeekPlans:', e); }
}

function updateUI() {
  document.getElementById('weekLabel').textContent = formatDateRange(currentWeek);
  renderChipBar();
  renderDayTabs();
  renderContent();
}

// ── Day Tabs ─────────────────────────────────────────────────────────
function renderDayTabs() {
  const tabs = document.getElementById('dayTabs');
  const dates = getWeekDates();
  tabs.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const date = dates[i];
    const plan = weekPlans[date];
    const tab = document.createElement('button');
    tab.className = `day-tab ${i === selectedDay ? 'active' : plan ? 'has-plan' : ''}`;
    tab.innerHTML = `<div class="day-name">${DAY_NAMES_CS[i]}</div><div class="day-cal">${plan ? (plan.total_calories || '?') : '—'}</div>`;
    tab.onclick = () => { selectedDay = i; renderDayTabs(); renderContent(); };
    tabs.appendChild(tab);
  }
}

// ── Content Rendering ────────────────────────────────────────────────
function renderContent() {
  const el = document.getElementById('content');
  if (!currentUser) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🍽️</div><h2>Vytvořte si jídelníček</h2><p>Přidejte profil a nechte AI<br>vytvořit váš týdenní plán</p></div>`;
    return;
  }

  const dates = getWeekDates();
  const date = dates[selectedDay];
  const plan = weekPlans[date];

  if (!plan) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">✨</div><h2>${DAY_NAMES_FULL[selectedDay]} — bez plánu</h2><p>Klikněte na "Den" pro generování<br>tohoto dne, nebo "Týden" pro všech 7</p></div>`;
    return;
  }

  renderDay(plan);
}

function renderDay(plan) {
  const el = document.getElementById('content');
  const cal = plan.total_calories || 0;
  const target = currentUser?.calories_target || 2000;
  const pct = Math.min(100, Math.round((cal / target) * 100));

  let html = `<div class="day-view">
    <div class="day-summary">
      <div class="day-summary-left">
        <h3>${plan.day_name || DAY_NAMES_FULL[selectedDay]}</h3>
        <div class="cal-target">${plan.date} · Cíl: ${target} kcal</div>
      </div>
      <div class="day-summary-right">
        <div class="cal-big">${cal}</div>
        <div class="cal-unit">kcal (${pct}%)</div>
      </div>
    </div>
    <div class="macro-bar">
      <div class="macro-pill protein"><div class="macro-v">${plan.total_protein || 0}g</div><div class="macro-l">Bílkoviny</div></div>
      <div class="macro-pill carbs"><div class="macro-v">${plan.total_carbs || 0}g</div><div class="macro-l">Sacharidy</div></div>
      <div class="macro-pill fat"><div class="macro-v">${plan.total_fat || 0}g</div><div class="macro-l">Tuky</div></div>
    </div>`;

  for (const [type, label] of Object.entries(MEAL_TYPES)) {
    const meal = (plan.meals || {})[type];
    if (!meal) continue;
    html += `
      <div class="meal-card">
        <div class="meal-card-header">
          <div class="meal-type-label"><span class="dot"></span>${MEAL_ICONS[type] || ''} ${label}</div>
          <div class="meal-cal-badge">${meal.calories || 0} kcal</div>
        </div>
        <div class="meal-card-body">
          <div class="meal-name">${esc(meal.name)}</div>
          <div class="meal-macros">
            <span class="p">B:${meal.protein || 0}g</span>
            <span class="c">S:${meal.carbs || 0}g</span>
            <span class="f">T:${meal.fat || 0}g</span>
          </div>
          ${meal.ingredients?.length ? `<div class="meal-ingredients">${meal.ingredients.map(esc).join(' · ')}</div>` : ''}
          ${meal.prep_time ? `<div class="meal-prep-time">${esc(meal.prep_time)}</div>` : ''}
        </div>
      </div>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

// ── Generate single day ──────────────────────────────────────────────
async function generateCurrentDay() {
  if (!currentUser || generating) return;
  generating = true;

  const dates = getWeekDates();
  const date = dates[selectedDay];
  const dayName = DAY_NAMES_FULL[selectedDay];

  const btnDay = document.getElementById('btnGenerateDay');
  const btnWeek = document.getElementById('btnGenerateWeek');
  btnDay.disabled = true;
  btnWeek.disabled = true;

  const el = document.getElementById('content');
  el.innerHTML = `<div class="gen-progress">
    <div class="gen-ring"></div>
    <div class="gen-text">Generuji ${dayName}...</div>
    <div class="gen-sub">AI vytváří jídelníček (~30s)</div>
  </div>`;

  // Mark tab as generating
  const tabs = document.querySelectorAll('.day-tab');
  if (tabs[selectedDay]) {
    tabs[selectedDay].classList.add('generating');
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

    const res = await fetch('/api/generate-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, date }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Chyba generování');
    }

    const plan = await res.json();
    weekPlans[date] = plan;
    renderDayTabs();
    renderContent();
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Požadavek vypršel (timeout 120s). Zkuste to prosím znovu.'
      : esc(err.message);
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><h2>Chyba při generování</h2><p>${msg}</p></div>`;
  } finally {
    btnDay.disabled = false;
    btnWeek.disabled = false;
    generating = false;
  }
}

// ── Generate week (parallel SSE) ─────────────────────────────────────
async function generateWeek() {
  if (!currentUser || generating) return;
  generating = true;

  const btnDay = document.getElementById('btnGenerateDay');
  const btnWeek = document.getElementById('btnGenerateWeek');
  btnDay.disabled = true;
  btnWeek.disabled = true;

  const el = document.getElementById('content');
  el.innerHTML = `<div class="gen-progress">
    <div class="gen-ring"></div>
    <div class="gen-text" id="genText">Generuji celý týden paralelně...</div>
    <div class="gen-sub" id="genSub">0/7 dní hotovo</div>
    <div class="gen-progress-bar"><div class="gen-progress-fill" id="genFill"></div></div>
  </div>`;

  let completed = 0;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min for full week

    const res = await fetch('/api/generate-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, weekStart: currentWeek }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));

          if (evt.type === 'day_done') {
            completed++;
            weekPlans[evt.date] = evt.plan;

            // Update progress
            const genSub = document.getElementById('genSub');
            const genFill = document.getElementById('genFill');
            const genText = document.getElementById('genText');
            if (genSub) genSub.textContent = `${completed}/7 dní hotovo`;
            if (genFill) genFill.style.width = `${(completed / 7) * 100}%`;
            if (genText) genText.textContent = `${evt.name} hotovo!`;

            // Update tab
            renderDayTabs();
          }
          else if (evt.type === 'day_error') {
            console.warn(`Day ${evt.name} failed: ${evt.error}`);
          }
          else if (evt.type === 'complete') {
            const genText = document.getElementById('genText');
            if (genText) genText.textContent = `Hotovo! ${evt.total}/7 dní vygenerováno`;
          }
          else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        } catch (e) {
          if (e.message && !String(e.message).includes('JSON')) throw e;
        }
      }
    }

    // Final render
    renderDayTabs();
    renderContent();
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Požadavek vypršel (timeout 5 min). Zkuste to prosím znovu.'
      : esc(err.message);
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><h2>Chyba při generování</h2><p>${msg}</p></div>`;
  } finally {
    btnDay.disabled = false;
    btnWeek.disabled = false;
    generating = false;
  }
}

// ── Delete week plans ────────────────────────────────────────────────
async function deleteWeekPlans() {
  if (!currentUser) return;
  if (!confirm('Smazat všechny plány pro tento týden?')) return;

  const dates = getWeekDates();
  for (const date of dates) {
    const plan = weekPlans[date];
    if (plan) {
      await fetch(`/api/plan/${plan.id}`, { method: 'DELETE' });
    }
  }
  weekPlans = {};
  selectedDay = 0;
  renderDayTabs();
  renderContent();
}

// ── Chat (SSE streaming) ─────────────────────────────────────────────
function toggleChat() {
  const panel = document.getElementById('chatPanel');
  chatOpen = !chatOpen;
  panel.classList.toggle('open', chatOpen);
  if (chatOpen) {
    const msgs = document.getElementById('chatMessages');
    msgs.scrollTop = msgs.scrollHeight;
  }
}

async function loadChat() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/chat/${currentUser.id}`);
    const msgs = await res.json();
    const container = document.getElementById('chatMessages');
    container.innerHTML = '<div class="chat-msg system">Ahoj! Pomůžu ti upravit jídelníček podle tvých přání 🌿</div>';
    msgs.forEach(m => {
      container.innerHTML += `<div class="chat-msg ${m.role}">${esc(m.content)}</div>`;
    });
    container.scrollTop = container.scrollHeight;
  } catch (e) { console.error('loadChat:', e); }
}

async function sendChat() {
  if (!currentUser || chatBusy) return;
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.style.height = 'auto';
  chatBusy = true;

  if (!chatOpen) toggleChat();

  const container = document.getElementById('chatMessages');
  container.innerHTML += `<div class="chat-msg user">${esc(msg)}</div>`;

  const streamEl = document.createElement('div');
  streamEl.className = 'chat-msg assistant streaming';
  streamEl.textContent = '';
  container.appendChild(streamEl);
  container.scrollTop = container.scrollHeight;

  // Get current day date for context
  const dates = getWeekDates();
  const planDate = dates[selectedDay];

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, message: msg, planDate }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'token') {
            fullContent += evt.content;
            streamEl.textContent = fullContent;
            container.scrollTop = container.scrollHeight;
          }
          else if (evt.type === 'done') {
            fullContent = evt.message || fullContent;
          }
          else if (evt.type === 'error') {
            fullContent = '❌ ' + evt.message;
          }
        } catch (e) { }
      }
    }

    streamEl.remove();
    container.innerHTML += `<div class="chat-msg assistant">${esc(fullContent)}</div>`;
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    streamEl.remove();
    container.innerHTML += `<div class="chat-msg assistant">❌ Chyba: ${esc(err.message)}</div>`;
  } finally {
    chatBusy = false;
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function setupTextareaResize() {
  const ta = document.getElementById('chatInput');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
  });
}

// ── Shopping List ────────────────────────────────────────────────────
async function showShopping() {
  if (!currentUser) return;
  try {
    const dates = getWeekDates();
    const from = dates[0];
    const to = dates[6];
    const res = await fetch(`/api/shopping-list/${currentUser.id}?from=${from}&to=${to}`);
    const data = await res.json();
    if (!data.items?.length) {
      alert('Žádné plány pro tento týden — nejdřív vygenerujte jídelníček.');
      return;
    }
    renderShoppingList(data.items);
    document.getElementById('shopOverlay').classList.add('active');
  } catch (e) { console.error('showShopping:', e); }
}

function renderShoppingList(items) {
  const container = document.getElementById('shopItems');
  const groups = {};
  items.forEach((item, i) => {
    const cat = item.category || '📦 Ostatní';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ ...item, _idx: i });
  });
  let html = '';
  for (const [cat, catItems] of Object.entries(groups)) {
    html += `<div class="shop-category">${cat}</div>`;
    catItems.forEach(item => {
      html += `<div class="shop-item ${item.checked ? 'checked' : ''}">
        <input type="checkbox" ${item.checked ? 'checked' : ''}>
        <span>${esc(item.display || item.name)}</span>
      </div>`;
    });
  }
  container.innerHTML = html;
}

function closeShop() { document.getElementById('shopOverlay').classList.remove('active'); }

function closePanelIfBg(e, id) { if (e.target === e.currentTarget) document.getElementById(id).classList.remove('active'); }

// ── Utility ──────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
