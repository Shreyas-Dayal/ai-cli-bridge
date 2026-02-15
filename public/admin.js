(function() {
  'use strict';

  // ── State ──
  let adminKey = sessionStorage.getItem('bridge_admin_key') || '';
  let keys = [];
  let logs = [];
  let refreshInterval = null;
  let countdownInterval = null;
  let countdown = 30;

  // ── DOM ──
  const $ = (s) => document.querySelector(s);
  const loginView = $('#loginView');
  const dashboardView = $('#dashboardView');
  const adminKeyInput = $('#adminKeyInput');
  const loginError = $('#loginError');
  const loginBtn = $('#loginBtn');
  const logoutBtn = $('#logoutBtn');
  const refreshBtn = $('#refreshBtn');
  const refreshTimer = $('#refreshTimer');
  const createKeyBtn = $('#createKeyBtn');
  const keyTableBody = $('#keyTableBody');
  const statsRow = $('#statsRow');
  const modalOverlay = $('#modalOverlay');
  const modalContent = $('#modalContent');
  const toastContainer = $('#toastContainer');
  const logTableBody = $('#logTableBody');
  const logKeyFilter = $('#logKeyFilter');
  const logLimitFilter = $('#logLimitFilter');

  // ── Format helpers ──
  function fmtNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString();
  }

  function fmtCost(n) {
    if (n == null || n === 0) return '$0.00';
    return '$' + Number(n).toFixed(n < 0.01 ? 4 : 2);
  }

  function fmtLimit(n) {
    return (!n || n === 0) ? 'Unlimited' : fmtNum(n);
  }

  function fmtCostLimit(n) {
    return (!n || n === 0) ? 'Unlimited' : fmtCost(n);
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return date + ' ' + time;
  }

  function fmtDuration(ms) {
    if (!ms) return '\u2014';
    return (ms / 1000).toFixed(1) + 's';
  }

  // ── API ──
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer ' + adminKey },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/admin' + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ── Toast ──
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ── Modal ──
  function openModal(html) {
    modalContent.innerHTML = html;
    modalOverlay.classList.add('active');
  }

  function closeModal() {
    modalOverlay.classList.remove('active');
    modalContent.innerHTML = '';
  }

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // ── Auth ──
  async function tryLogin() {
    const key = adminKeyInput.value.trim();
    if (!key) { loginError.textContent = 'Key is required'; return; }
    adminKey = key;
    loginError.textContent = '';
    loginBtn.textContent = 'Authenticating...';
    loginBtn.disabled = true;

    try {
      await api('GET', '/keys');
      sessionStorage.setItem('bridge_admin_key', adminKey);
      showDashboard();
    } catch (err) {
      loginError.textContent = 'Authentication failed \u2014 invalid key';
      adminKey = '';
      loginBtn.textContent = 'Authenticate';
      loginBtn.disabled = false;
    }
  }

  function logout() {
    adminKey = '';
    keys = [];
    sessionStorage.removeItem('bridge_admin_key');
    clearInterval(refreshInterval);
    clearInterval(countdownInterval);
    dashboardView.style.display = 'none';
    loginView.style.display = 'flex';
    adminKeyInput.value = '';
    loginBtn.textContent = 'Authenticate';
    loginBtn.disabled = false;
  }

  // ── Dashboard ──
  function showDashboard() {
    loginView.style.display = 'none';
    dashboardView.style.display = 'block';
    dashboardView.style.animation = 'fadeUp 0.4s ease';
    loadKeys();
    startAutoRefresh();
  }

  function startAutoRefresh() {
    clearInterval(refreshInterval);
    clearInterval(countdownInterval);
    countdown = 30;
    refreshTimer.textContent = 'Refresh in 30s';
    countdownInterval = setInterval(() => {
      countdown--;
      if (countdown <= 0) countdown = 30;
      refreshTimer.textContent = 'Refresh in ' + countdown + 's';
    }, 1000);
    refreshInterval = setInterval(loadKeys, 30000);
  }

  async function loadKeys() {
    try {
      const data = await api('GET', '/keys');
      keys = data.keys || [];
      renderStats();
      renderTable();
      updateLogKeyFilter();
      loadLogs();
      countdown = 30;
    } catch (err) {
      if (err.message.includes('Unauthorized') || err.message.includes('Forbidden')) {
        logout();
        loginError.textContent = 'Session expired \u2014 please re-authenticate';
      } else {
        toast('Failed to load keys: ' + err.message, 'error');
      }
    }
  }

  // ── Stats ──
  function renderStats() {
    const totalKeys = keys.length;
    let todayReqs = 0, todayCost = 0, monthReqs = 0, monthCost = 0;
    for (const k of keys) {
      todayReqs += k.usage?.today?.requests || 0;
      todayCost += k.usage?.today?.costUsd || 0;
      monthReqs += k.usage?.thisMonth?.requests || 0;
      monthCost += k.usage?.thisMonth?.costUsd || 0;
    }

    statsRow.innerHTML = `
      <div class="stat-card">
        <div class="label">Active Keys</div>
        <div class="value">${totalKeys}</div>
      </div>
      <div class="stat-card">
        <div class="label">Today Requests</div>
        <div class="value">${fmtNum(todayReqs)}</div>
        <div class="sub">${fmtCost(todayCost)} spent</div>
      </div>
      <div class="stat-card">
        <div class="label">Month Requests</div>
        <div class="value">${fmtNum(monthReqs)}</div>
        <div class="sub">${fmtCost(monthCost)} spent</div>
      </div>
    `;
  }

  // ── Table ──
  function renderTable() {
    if (keys.length === 0) {
      keyTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">No keys created yet. Click "Create Key" to get started.</td></tr>';
      return;
    }

    keyTableBody.innerHTML = keys.map(k => {
      const l = k.limits || {};
      const td = k.usage?.today || {};
      const tm = k.usage?.thisMonth || {};

      return `<tr>
        <td>
          <div class="key-name">${esc(k.name)}</div>
          <div class="key-date">${fmtDate(k.createdAt)}</div>
        </td>
        <td>
          <div class="limit-grid">
            <div class="limit-row"><span class="limit-label">req/d</span><span class="limit-val ${l.maxRequestsPerDay ? 'active' : ''}">${fmtLimit(l.maxRequestsPerDay)}</span></div>
            <div class="limit-row"><span class="limit-label">req/m</span><span class="limit-val ${l.maxRequestsPerMonth ? 'active' : ''}">${fmtLimit(l.maxRequestsPerMonth)}</span></div>
            <div class="limit-row"><span class="limit-label">tok/m</span><span class="limit-val ${l.maxTokensPerMonth ? 'active' : ''}">${fmtLimit(l.maxTokensPerMonth)}</span></div>
            <div class="limit-row"><span class="limit-label">$/d</span><span class="limit-val ${l.maxCostPerDay ? 'active' : ''}">${fmtCostLimit(l.maxCostPerDay)}</span></div>
            <div class="limit-row"><span class="limit-label">$/m</span><span class="limit-val ${l.maxCostPerMonth ? 'active' : ''}">${fmtCostLimit(l.maxCostPerMonth)}</span></div>
          </div>
        </td>
        <td>
          <div class="usage-grid">
            <div class="usage-row"><span class="usage-label">req</span><span class="usage-val">${fmtNum(td.requests)}</span></div>
            <div class="usage-row"><span class="usage-label">tok</span><span class="usage-val">${fmtNum(td.tokens)}</span></div>
            <div class="usage-row"><span class="usage-label">cost</span><span class="usage-val">${fmtCost(td.costUsd)}</span></div>
          </div>
        </td>
        <td>
          <div class="usage-grid">
            <div class="usage-row"><span class="usage-label">req</span><span class="usage-val">${fmtNum(tm.requests)}</span></div>
            <div class="usage-row"><span class="usage-label">tok</span><span class="usage-val">${fmtNum(tm.tokens)}</span></div>
            <div class="usage-row"><span class="usage-label">cost</span><span class="usage-val">${fmtCost(tm.costUsd)}</span></div>
          </div>
        </td>
        <td>
          <div class="actions">
            <button class="btn btn-sm" onclick="app.editLimits('${esc(k.name)}')">Edit</button>
            <button class="btn btn-sm btn-warn" onclick="app.resetUsage('${esc(k.name)}')">Reset</button>
            <button class="btn btn-sm btn-danger" onclick="app.deleteKey('${esc(k.name)}')">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  // ── Logs ──
  async function loadLogs() {
    try {
      const keyFilter = logKeyFilter.value;
      const limit = logLimitFilter.value;
      let path = '/logs?limit=' + limit;
      if (keyFilter) path += '&key=' + encodeURIComponent(keyFilter);
      const data = await api('GET', path);
      logs = data.logs || [];
      renderLogs();
    } catch (err) {
      // Silently fail — logs are secondary to keys
    }
  }

  function updateLogKeyFilter() {
    const current = logKeyFilter.value;
    logKeyFilter.innerHTML = '<option value="">All Keys</option>';
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k.name;
      opt.textContent = k.name;
      if (k.name === current) opt.selected = true;
      logKeyFilter.appendChild(opt);
    }
  }

  function renderLogs() {
    if (logs.length === 0) {
      logTableBody.innerHTML = '<tr><td colspan="9" class="empty-state">No request logs yet.</td></tr>';
      return;
    }

    logTableBody.innerHTML = logs.map(l => `<tr>
      <td style="white-space: nowrap; font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${fmtTime(l.timestamp)}</td>
      <td><span class="key-name" style="font-size: 12px;">${esc(l.keyName)}</span></td>
      <td><span class="provider-badge ${l.provider}">${esc(l.provider)}</span></td>
      <td style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${esc(l.model)}</td>
      <td><div class="prompt-cell" title="${esc(l.systemPrompt)}">${esc(l.systemPrompt)}</div></td>
      <td><div class="prompt-cell" title="${esc(l.userPrompt)}">${esc(l.userPrompt)}</div></td>
      <td style="font-family: var(--mono); font-size: 11px; white-space: nowrap;">
        <span style="color: var(--text-dim);">${fmtNum(l.inputTokens)}</span>
        <span style="color: var(--text-muted);"> / </span>
        <span style="color: var(--text-dim);">${fmtNum(l.outputTokens)}</span>
      </td>
      <td style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${fmtCost(l.costUsd)}</td>
      <td style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${fmtDuration(l.durationMs)}</td>
    </tr>`).join('');
  }

  // ── Create Key ──
  function showCreateModal() {
    openModal(`
      <div class="modal-head">
        <h3>Create Key</h3>
        <button class="modal-close" onclick="app.closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Name *</label>
          <input type="text" id="createName" placeholder="e.g. alice, project-x">
        </div>
        <div class="field-row">
          <div class="field">
            <label>Requests / Day</label>
            <input type="number" id="createReqDay" value="0" min="0">
            <div class="hint">0 = unlimited</div>
          </div>
          <div class="field">
            <label>Requests / Month</label>
            <input type="number" id="createReqMonth" value="0" min="0">
            <div class="hint">0 = unlimited</div>
          </div>
        </div>
        <div class="field">
          <label>Tokens / Month</label>
          <input type="number" id="createTokMonth" value="0" min="0">
          <div class="hint">Combined input + output. 0 = unlimited</div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Cost / Day (USD)</label>
            <input type="number" id="createCostDay" value="0" min="0" step="0.01">
            <div class="hint">0 = unlimited</div>
          </div>
          <div class="field">
            <label>Cost / Month (USD)</label>
            <input type="number" id="createCostMonth" value="0" min="0" step="0.01">
            <div class="hint">0 = unlimited</div>
          </div>
        </div>
        <div id="createResult"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="app.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="createSubmitBtn" onclick="app.submitCreate()">Create</button>
      </div>
    `);
    setTimeout(() => document.getElementById('createName')?.focus(), 100);
  }

  async function submitCreate() {
    const name = document.getElementById('createName')?.value.trim();
    if (!name) { toast('Name is required', 'error'); return; }

    const btn = document.getElementById('createSubmitBtn');
    btn.textContent = 'Creating...';
    btn.disabled = true;

    try {
      const data = await api('POST', '/keys', {
        name,
        maxRequestsPerDay: Number(document.getElementById('createReqDay')?.value) || 0,
        maxRequestsPerMonth: Number(document.getElementById('createReqMonth')?.value) || 0,
        maxTokensPerMonth: Number(document.getElementById('createTokMonth')?.value) || 0,
        maxCostPerDay: Number(document.getElementById('createCostDay')?.value) || 0,
        maxCostPerMonth: Number(document.getElementById('createCostMonth')?.value) || 0,
      });

      document.getElementById('createResult').innerHTML = `
        <div class="key-reveal">
          <div class="warn">Save this key \u2014 it cannot be retrieved again</div>
          <div class="key-text" id="revealedKey">${esc(data.key)}</div>
          <button class="btn btn-primary btn-sm btn-full" onclick="app.copyKey()">Copy to Clipboard</button>
        </div>
      `;

      btn.textContent = 'Created';
      document.querySelector('.modal-foot').innerHTML = '<button class="btn btn-primary" onclick="app.closeModal()">Done</button>';

      toast('Key created for "' + name + '"');
      loadKeys();
    } catch (err) {
      toast(err.message, 'error');
      btn.textContent = 'Create';
      btn.disabled = false;
    }
  }

  function copyKey() {
    const keyText = document.getElementById('revealedKey')?.textContent;
    if (keyText) {
      navigator.clipboard.writeText(keyText).then(() => toast('Key copied to clipboard'));
    }
  }

  // ── Edit Limits ──
  function editLimits(name) {
    const k = keys.find(k => k.name === name);
    if (!k) return;
    const l = k.limits || {};

    openModal(`
      <div class="modal-head">
        <h3>Edit Limits \u2014 ${esc(name)}</h3>
        <button class="modal-close" onclick="app.closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="field-row">
          <div class="field">
            <label>Requests / Day</label>
            <input type="number" id="editReqDay" value="${l.maxRequestsPerDay || 0}" min="0">
            <div class="hint">0 = unlimited</div>
          </div>
          <div class="field">
            <label>Requests / Month</label>
            <input type="number" id="editReqMonth" value="${l.maxRequestsPerMonth || 0}" min="0">
            <div class="hint">0 = unlimited</div>
          </div>
        </div>
        <div class="field">
          <label>Tokens / Month</label>
          <input type="number" id="editTokMonth" value="${l.maxTokensPerMonth || 0}" min="0">
        </div>
        <div class="field-row">
          <div class="field">
            <label>Cost / Day (USD)</label>
            <input type="number" id="editCostDay" value="${l.maxCostPerDay || 0}" min="0" step="0.01">
            <div class="hint">0 = unlimited</div>
          </div>
          <div class="field">
            <label>Cost / Month (USD)</label>
            <input type="number" id="editCostMonth" value="${l.maxCostPerMonth || 0}" min="0" step="0.01">
            <div class="hint">0 = unlimited</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="app.closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="app.submitEdit('${esc(name)}')">Save</button>
      </div>
    `);
  }

  async function submitEdit(name) {
    try {
      await api('PATCH', '/keys/' + encodeURIComponent(name), {
        maxRequestsPerDay: Number(document.getElementById('editReqDay')?.value) || 0,
        maxRequestsPerMonth: Number(document.getElementById('editReqMonth')?.value) || 0,
        maxTokensPerMonth: Number(document.getElementById('editTokMonth')?.value) || 0,
        maxCostPerDay: Number(document.getElementById('editCostDay')?.value) || 0,
        maxCostPerMonth: Number(document.getElementById('editCostMonth')?.value) || 0,
      });
      closeModal();
      toast('Limits updated for "' + name + '"');
      loadKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Delete ──
  function deleteKey(name) {
    openModal(`
      <div class="modal-head">
        <h3>Delete Key</h3>
        <button class="modal-close" onclick="app.closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p class="confirm-text">Permanently delete key <strong>"${esc(name)}"</strong> and all its usage data? This cannot be undone.</p>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="app.closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="app.confirmDelete('${esc(name)}')">Delete</button>
      </div>
    `);
  }

  async function confirmDelete(name) {
    try {
      await api('DELETE', '/keys/' + encodeURIComponent(name));
      closeModal();
      toast('Key "' + name + '" deleted');
      loadKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Reset Usage ──
  function resetUsage(name) {
    openModal(`
      <div class="modal-head">
        <h3>Reset Usage</h3>
        <button class="modal-close" onclick="app.closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p class="confirm-text">Reset all usage counters for <strong>"${esc(name)}"</strong> to zero? This clears today and monthly tallies.</p>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="app.closeModal()">Cancel</button>
        <button class="btn btn-warn" onclick="app.confirmReset('${esc(name)}')">Reset</button>
      </div>
    `);
  }

  async function confirmReset(name) {
    try {
      await api('POST', '/keys/' + encodeURIComponent(name) + '/reset-usage');
      closeModal();
      toast('Usage reset for "' + name + '"');
      loadKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Events ──
  loginBtn.addEventListener('click', tryLogin);
  adminKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
  logoutBtn.addEventListener('click', logout);
  refreshBtn.addEventListener('click', () => { loadKeys(); startAutoRefresh(); });
  createKeyBtn.addEventListener('click', showCreateModal);
  logKeyFilter.addEventListener('change', loadLogs);
  logLimitFilter.addEventListener('change', loadLogs);

  // ── Public API for inline handlers ──
  window.app = {
    closeModal, editLimits, submitEdit, deleteKey, confirmDelete,
    resetUsage, confirmReset, submitCreate, copyKey,
  };

  // ── Init ──
  if (adminKey) {
    showDashboard();
  }
})();
