// ── State ────────────────────────────────────────────────────────────
let users = [];
let currentUser = null;
let currentWeek = getWeekStart(new Date());
let currentPlan = null;
let chatBusy = false;

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadUsers();
  autoResizeTextarea();
});

// ── Week helpers ─────────────────────────────────────────────────────
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function formatDateRange(weekStart) {
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('cs-CZ', opts)} — ${end.toLocaleDateString('cs-CZ', opts)}`;
}

function changeWeek(delta) {
  const d = new Date(currentWeek);
  d.setDate(d.getDate() + delta * 7);
  currentWeek = getWeekStart(d);
  updateWeekLabel();
  if (currentUser) loadPlan();
}

function updateWeekLabel() {
  document.getElementById('weekLabel').textContent = formatDateRange(currentWeek);
}

// ── Users ────────────────────────────────────────────────────────────
async function loadUsers() {
  const res = await fetch('/api/users');
  users = await res.json();
  renderUsers();
  updateWeekLabel();
  // Auto-select last user or first
  if (users.length > 0) {
    selectUser(currentUser && users.find(u => u.id === currentUser.id) ? currentUser.id : users[0].id);
  }
}

function renderUsers() {
  const list = document.getElementById('userList');
  list.innerHTML = users.map(u => `
    <div class="user-item ${currentUser && currentUser.id === u.id ? 'active' : ''}" onclick="selectUser(${u.id})">
      <div class="user-avatar">${u.name.charAt(0).toUpperCase()}</div>
      <div class="user-info">
        <div class="name">${u.name}</div>
        <div class="meta">${u.weight_current || '?'}kg → ${u.weight_goal || '?'}kg · ${u.calories_target || '?'} kcal</div>
      </div>
    </div>
  `).join('');
}

async function selectUser(id) {
  currentUser = users.find(u => u.id === id);
  renderUsers();
  updateWeekLabel();
  await loadPlan();
  loadChat();
}

// ── User Modal ───────────────────────────────────────────────────────
function showUserModal(userId) {
  const modal = document.getElementById('userModal');
  const user = userId ? users.find(u => u.id === userId) : null;
  document.getElementById('userModalTitle').textContent = user ? 'Upravit profil' : 'Nový uživatel';
  document.getElementById('editUserId').value = user ? user.id : '';
  document.getElementById('fName').value = user ? user.name : '';
  document.getElementById('fLocale').value = user ? user.locale : 'cs';
  document.getElementById('fSex').value = user ? (user.sex || '') : '';
  document.getElementById('fWeight').value = user ? (user.weight_current || '') : '';
  document.getElementById('fWeightGoal').value = user ? (user.weight_goal || '') : '';
  document.getElementById('fHeight').value = user ? (user.height || '') : '';
  document.getElementById('fAge').value = user ? (user.age || '') : '';
  document.getElementById('fActivity').value = user ? (user.activity_level || 'moderate') : 'moderate';
  document.getElementById('fRestrictions').value = user ? (user.dietary_restrictions || '') : '';
  modal.classList.add('active');
}

function closeUserModal() {
  document.getElementById('userModal').classList.remove('active');
}

async function saveUser() {
  const id = document.getElementById('editUserId').value;
  const data = {
    name: document.getElementById('fName').value,
    locale: document.getElementById('fLocale').value,
    sex: document.getElementById('fSex').value || null,
    weight_current: parseFloat(document.getElementById('fWeight').value) || null,
    weight_goal: parseFloat(document.getElementById('fWeightGoal').value) || null,
    height: parseFloat(document.getElementById('fHeight').value) || null,
    age: parseInt(document.getElementById('fAge').value) || null,
    activity_level: document.getElementById('fActivity').value,
    dietary_restrictions: document.getElementById('fRestrictions').value,
  };

  if (!data.name) return alert('Zadejte jméno');

  if (id) {
    await fetch(`/api/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } else {
    await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }

  closeUserModal();
  await loadUsers();
  if (!id && users.length > 0) selectUser(users[users.length - 1].id);
}

// ── Meal Plan ────────────────────────────────────────────────────────
async function loadPlan() {
  if (!currentUser) return;
  const res = await fetch(`/api/plans/${currentUser.id}/${currentWeek}`);
  const plan = await res.json();
  currentPlan = plan;
  renderPlan();
}

function renderPlan() {
  const area = document.getElementById('planArea');
  const empty = document.getElementById('emptyState');

  if (!currentUser) {
    area.innerHTML = '<div class="empty-state"><div class="icon">🍽️</div><h2>Začněte vytvořením profilu</h2><p>Přidejte uživatele a vygenerujte týdenní jídelníček</p></div>';
    return;
  }

  if (!currentPlan) {
    area.innerHTML = '<div class="empty-state"><div class="icon">✨</div><h2>Žádný plán pro tento týden</h2><p>Klikněte na "Generovat týden" pro vytvoření AI jídelníčku</p></div>';
    return;
  }

  const meals = currentPlan.meals;
  if (!meals) return;

  const dayNames = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
  const mealLabels = { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' };

  let html = '<div class="day-grid">';

  for (let i = 0; i < 7; i++) {
    const day = meals[i];
    if (!day) continue;

    html += `
      <div class="day-card">
        <div class="day-card-header">
          <h3>${day.day || dayNames[i]}</h3>
          <span class="day-calories">${day.total_calories || '?'} kcal</span>
        </div>
        <div class="day-macros">
          <div class="macro protein"><span class="macro-label">B:</span><span class="macro-val">${day.total_protein || '?'}g</span></div>
          <div class="macro carbs"><span class="macro-label">S:</span><span class="macro-val">${day.total_carbs || '?'}g</span></div>
          <div class="macro fat"><span class="macro-label">T:</span><span class="macro-val">${day.total_fat || '?'}g</span></div>
        </div>`;

    for (const [type, label] of Object.entries(mealLabels)) {
      const meal = (day.meals || {})[type];
      if (!meal) continue;

      html += `
        <div class="meal-item" title="${(meal.ingredients || []).join('\n')}">
          <div class="meal-type">${label}</div>
          <div class="meal-name">${meal.name}</div>
          <div class="meal-meta">${meal.calories || '?'} kcal · B:${meal.protein || '?'}g S:${meal.carbs || '?'}g T:${meal.fat || '?'}g</div>
          ${meal.ingredients ? `<div class="meal-ingredients">${meal.ingredients.join(', ')}</div>` : ''}
        </div>`;
    }

    html += '</div>';
  }

  html += '</div>';
  area.innerHTML = html;
}

// ── Generate ─────────────────────────────────────────────────────────
async function generatePlan() {
  if (!currentUser) return alert('Nejdříve vyberte uživatele');

  const btn = document.getElementById('btnGenerate');
  btn.disabled = true;
  btn.textContent = '⏳ Generuji...';

  const area = document.getElementById('planArea');
  area.innerHTML = '<div class="loading"><div class="spinner"></div> AI vytváří váš jídelníček...</div>';

  try {
    const res = await fetch(`/api/generate/${currentUser.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_start: currentWeek }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.details || err.error || 'Generation failed');
    }

    const data = await res.json();
    currentPlan = { meals: data.meals };
    renderPlan();
    loadChat();
  } catch (err) {
    alert('Chyba: ' + err.message);
    area.innerHTML = '<div class="empty-state"><div class="icon">❌</div><h2>Chyba při generování</h2><p>' + err.message + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generovat týden';
  }
}

async function deletePlan() {
  if (!currentUser) return;
  if (!confirm('Smazat plán pro tento týden?')) return;
  await fetch(`/api/plans/${currentUser.id}/${currentWeek}`, { method: 'DELETE' });
  currentPlan = null;
  renderPlan();
}

// ── Chat ─────────────────────────────────────────────────────────────
async function loadChat() {
  if (!currentUser) return;
  const res = await fetch(`/api/chat/${currentUser.id}`);
  const msgs = await res.json();
  const container = document.getElementById('chatMessages');
  container.innerHTML = '<div class="chat-msg system">AI asistent vám pomůže upravit jídelníček podle vašich přání</div>';
  msgs.forEach(m => {
    container.innerHTML += `<div class="chat-msg ${m.role}">${escapeHtml(m.content)}</div>`;
  });
  container.scrollTop = container.scrollHeight;
}

async function sendChat() {
  if (!currentUser || chatBusy) return;
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  autoResizeTextarea();
  chatBusy = true;

  const container = document.getElementById('chatMessages');
  container.innerHTML += `<div class="chat-msg user">${escapeHtml(msg)}</div>`;
  container.innerHTML += '<div class="chat-msg assistant" id="chatLoading"><div class="spinner" style="width:16px;height:16px;"></div></div>';
  container.scrollTop = container.scrollHeight;

  try {
    const res = await fetch(`/api/chat/${currentUser.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, week_start: currentWeek }),
    });

    const data = await res.json();

    // Remove loading
    const loading = document.getElementById('chatLoading');
    if (loading) loading.remove();

    container.innerHTML += `<div class="chat-msg assistant">${escapeHtml(data.message)}</div>`;

    // If plan was updated, refresh
    if (data.updatedPlan) {
      currentPlan = { meals: data.updatedPlan };
      renderPlan();
    }

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    const loading = document.getElementById('chatLoading');
    if (loading) loading.remove();
    container.innerHTML += `<div class="chat-msg assistant">❌ Chyba: ${err.message}</div>`;
  } finally {
    chatBusy = false;
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

function autoResizeTextarea() {
  const ta = document.getElementById('chatInput');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Shopping List ────────────────────────────────────────────────────
async function showShopping() {
  if (!currentUser) return;
  const res = await fetch(`/api/shopping/${currentUser.id}/${currentWeek}`);
  let items = await res.json();

  if (items.length === 0) {
    alert('Nejprve vygenerujte jídelníček');
    return;
  }

  renderShoppingList(items);
  document.getElementById('shopOverlay').classList.add('active');
}

function renderShoppingList(items) {
  const container = document.getElementById('shopItems');
  container.innerHTML = items.map((item, i) => `
    <div class="shop-item ${item.checked ? 'checked' : ''}">
      <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="toggleShopItem(${i})">
      <span>${item.name}</span>
    </div>
  `).join('');
}

async function toggleShopItem(index) {
  const res = await fetch(`/api/shopping/${currentUser.id}/${currentWeek}`);
  const items = await res.json();
  items[index].checked = !items[index].checked;
  await fetch(`/api/shopping/${currentUser.id}/${currentWeek}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  renderShoppingList(items);
}

function closeShop() { document.getElementById('shopOverlay').classList.remove('active'); }
function closeShopIfBg(e) { if (e.target === e.currentTarget) closeShop(); }

// ── Prep Guide ───────────────────────────────────────────────────────
async function showPrep() {
  if (!currentUser) return;
  const res = await fetch(`/api/prep/${currentUser.id}/${currentWeek}`);
  const data = await res.json();

  if (!data.days || data.days.length === 0) {
    alert('Nejprve vygenerujte jídelníček');
    return;
  }

  const mealLabels = { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' };

  const container = document.getElementById('prepContent');
  container.innerHTML = data.days.map(day => `
    <div class="prep-day">
      <h3>${day.day}</h3>
      ${day.meals.map(m => `
        <div class="prep-meal">
          <div class="type">${mealLabels[m.type] || m.type}</div>
          <div class="name">${m.name}</div>
          <div class="steps">${m.prep || ''}</div>
          ${m.ingredients ? `<div class="ing-list">📦 ${(Array.isArray(m.ingredients) ? m.ingredients : [m.ingredients]).join(', ')}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');

  document.getElementById('prepOverlay').classList.add('active');
}

function closePrep() { document.getElementById('prepOverlay').classList.remove('active'); }
function closePrepIfBg(e) { if (e.target === e.currentTarget) closePrep(); }
