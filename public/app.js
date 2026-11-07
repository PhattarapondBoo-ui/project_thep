/* ระบบเช็คลิสต์งานพนักงาน — ฝั่งหน้าเว็บ (ไม่มี framework แก้ได้ตรง ๆ) */

// ===== ข้อความที่แสดง (แก้คำได้ที่นี่) =====
const STATUS = {
  todo:      { label: 'ยังไม่ทำ', icon: '⏳' },
  submitted: { label: 'รอตรวจ',   icon: '📤' },
  done:      { label: 'เสร็จแล้ว', icon: '✅' },
};
const ROLE_TH = { employer: 'นายจ้าง', employee: 'พนักงาน' };

// ===== สถานะของแอป =====
const state = {
  user: null,
  tasks: [],
  users: [],
  templates: [],         // งานที่เคยเพิ่ม (ใช้ซ้ำได้)
  filter: null,        // ตัวกรองสถานะงาน
  employerTab: 'tasks',  // tasks | users
  editingId: null,       // id งานที่กำลังแก้ไข
  templateId: null,      // id งานเดิมที่นำมาใช้ซ้ำในฟอร์มเพิ่มงาน
  pendingPhotos: {},     // รูปที่พนักงานเลือกแต่ยังไม่ส่ง { taskId: dataUrl }
};

// ===== เครื่องมือ =====
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { dateStyle: 'medium' }) : '';
const todayStr = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

async function api(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: 'same-origin',
  });
  let body = null;
  try { body = await res.json(); } catch { /* ไม่มี body */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; render(); }
    throw new Error((body && body.error) || 'เกิดข้อผิดพลาด');
  }
  return body;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

function compressImage(file, maxSize = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('ไม่สามารถอ่านไฟล์รูปนี้ได้')); };
    img.src = url;
  });
}

async function loadData() {
  state.tasks = await api('GET', '/api/tasks');
  if (state.user.role === 'employer') {
    state.users = await api('GET', '/api/users');
    state.templates = await api('GET', '/api/templates');
  }
}

// ===== วาดหน้า =====
function render() {
  const app = $('#app');
  if (!state.user) app.innerHTML = viewLogin();
  else if (state.user.role === 'employer') app.innerHTML = viewEmployer();
  else app.innerHTML = viewEmployee();
}

function viewLogin() {
  return `
  <main class="login-wrap">
    <div class="login-card">
      <div class="brand">
        <div class="logo">✓</div>
        <h1>เช็คลิสต์งาน</h1>
        <p>ระบบตรวจสอบการทำงานของพนักงาน</p>
      </div>
      <form id="login-form">
        <label class="field">ชื่อผู้ใช้
          <input name="username" autocomplete="username" autocapitalize="none" required>
        </label>
        <label class="field">รหัสผ่าน
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <div class="form-error" id="login-error"></div>
        <button class="btn primary block" type="submit">เข้าสู่ระบบ</button>
      </form>
    </div>
  </main>`;
}

function topbar() {
  const u = state.user;
  return `
  <header class="topbar">
    <div class="who">
      <div class="avatar">${esc(u.name.trim().charAt(0) || '?')}</div>
      <div style="min-width:0">
        <div class="who-name">${esc(u.name)}</div>
        <div class="who-role">${ROLE_TH[u.role]} · ${esc(u.username)}</div>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="btn small" data-action="change-password" title="เปลี่ยนรหัสผ่าน">🔑<span class="hide-sm">เปลี่ยนรหัส</span></button>
      <button class="btn small" data-action="logout">ออกจากระบบ</button>
    </div>
  </header>`;
}

function counts() {
  const c = { todo: 0, submitted: 0, done: 0 };
  state.tasks.forEach((t) => c[t.status]++);
  return c;
}

function statsBar() {
  const c = counts();
  const cards = [
    ['all', state.tasks.length, '📋', 'ทั้งหมด'],
    ...Object.keys(STATUS).map((k) => [k, c[k], STATUS[k].icon, STATUS[k].label]),
  ];
  return `<div class="stats">${cards.map(([k, n, icon, label]) => `
    <button class="stat ${k} ${state.filter === k ? 'active' : ''}" data-filter="${k}">
      <div class="num">${n}</div><div class="lbl">${icon} ${label}</div>
    </button>`).join('')}</div>`;
}


function filteredTasks() {
  const f = state.filter;
  const list = !f || f === 'all' ? state.tasks : state.tasks.filter((t) => t.status === f);
  const order = state.user.role === 'employer' ? { submitted: 0, todo: 1, done: 2 } : { todo: 0, submitted: 1, done: 2 };
  return [...list].sort((a, b) => order[a.status] - order[b.status] || b.id - a.id);
}

function taskMeta(t) {
  const overdue = t.due_date && t.status !== 'done' && t.due_date < todayStr();
  return `<div class="meta">
    ${t.zone ? `<span>📍 ${esc(t.zone)}</span>` : ''}
    <span>👤 ${t.assignee_name ? esc(t.assignee_name) : 'ทุกคน'}</span>
    ${t.due_date ? `<span class="${overdue ? 'overdue' : ''}">📅 ${fmtDate(t.due_date)}${overdue ? ' (เลยกำหนด)' : ''}</span>` : ''}
  </div>`;
}

function taskProof(t) {
  if (!t.photo || t.status === 'todo') return '';
  return `<div class="proof">
    <img src="/uploads/${esc(t.photo)}" alt="รูปผลงาน" data-zoom loading="lazy">
    <div class="proof-info">
      <div>ส่งโดย <strong>${esc(t.submitter_name || '-')}</strong></div>
      <div>${fmtTime(t.submitted_at)}</div>
      ${t.comment ? `<div style="margin-top:4px">💬 ${esc(t.comment)}</div>` : ''}
      ${t.status === 'done' ? `<div style="margin-top:4px;color:var(--done)">✔ ตรวจผ่านเมื่อ ${fmtTime(t.approved_at)}</div>` : ''}
    </div>
  </div>`;
}

function taskCardHead(t) {
  return `<div class="task-head">
      <h3>${esc(t.title)}</h3>
      <span class="badge ${t.status}">${STATUS[t.status].label}</span>
    </div>
    ${taskMeta(t)}
    ${t.detail ? `<p class="detail">${esc(t.detail)}</p>` : ''}
    ${t.reject_note && t.status === 'todo' ? `<div class="note warn">↩ นายจ้างส่งกลับ: ${esc(t.reject_note)}</div>` : ''}`;
}

function emptyBox(text) { return `<div class="card empty">${text}</div>`; }

// ----- ฝั่งพนักงาน -----
function viewEmployee() {
  if (state.filter === null) state.filter = 'todo';
  const list = filteredTasks();
  return `${topbar()}
  <main class="container">
    ${statsBar()}
    <div class="task-list">
      ${list.length ? list.map(employeeTaskCard).join('') : emptyBox('🎉 ไม่มีงานในหมวดนี้')}
    </div>
  </main>`;
}

function employeeTaskCard(t) {
  let body = '';
  if (t.status === 'todo') {
    const p = state.pendingPhotos[t.id];
    body = `<div class="submit-box">
      <label class="upload">
        <input type="file" accept="image/*" data-photo-for="${t.id}">
        <span>📷 ${p ? 'เปลี่ยนรูป' : 'ถ่ายรูป / เลือกรูปงานที่ทำเสร็จ'}</span>
      </label>
      ${p ? `<img class="preview" src="${p}" alt="ตัวอย่างรูป">` : ''}
      <input class="input" placeholder="หมายเหตุ (ถ้ามี)" data-comment-for="${t.id}" maxlength="500">
      <button class="btn primary block" data-action="submit" data-id="${t.id}" ${p ? '' : 'disabled'}>ส่งงาน</button>
    </div>`;
  } else if (t.status === 'submitted') {
    body = taskProof(t) + `<div class="note info">⏳ รอนายจ้างตรวจสอบ — ถ้าต้องการเปลี่ยนรูป ให้แจ้งนายจ้างส่งกลับ</div>`;
  } else {
    body = taskProof(t);
  }
  return `<article class="card task ${t.status}">${taskCardHead(t)}${body}</article>`;
}

// ----- ฝั่งนายจ้าง -----
function viewEmployer() {
  if (state.filter === null) state.filter = 'all';
  const tab = state.employerTab;
  const waiting = counts().submitted;
  const navItems = [
    ['tasks', '📋', 'รายการงาน', waiting],
    ['add', state.editingId ? '✏️' : '➕', state.editingId ? 'แก้ไขงาน' : 'เพิ่มงานใหม่', 0],
    ['users', '👥', 'จัดการพนักงาน', 0],
  ];
  const pages = { tasks: employerTasks, add: taskForm, users: employerUsers };
  return `${topbar()}
  <nav class="main-nav" aria-label="เมนูนายจ้าง">
    <div class="main-nav-inner">
      ${navItems.map(([key, icon, label, n]) => `
        <button data-employer-tab="${key}" class="${tab === key ? 'active' : ''}" ${tab === key ? 'aria-current="page"' : ''}>
          <span class="nav-icon">${icon}</span>
          <span class="nav-label">${label}</span>
          ${n ? `<span class="nav-count" title="รอตรวจ">${n}</span>` : ''}
        </button>`).join('')}
    </div>
  </nav>
  <main class="container">
    ${pages[tab]()}
  </main>`;
}

function employeeOptions(selected) {
  const emps = state.users.filter((u) => u.role === 'employee');
  return `<option value="">— ทุกคน (ใครก็ได้) —</option>` +
    emps.map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}

// รายการ "งานที่เคยเพิ่ม" เก็บในฐานข้อมูลแยกจากงานจริง (ลบงานแล้วยังอยู่)
function historyList() {
  const items = state.templates;
  if (!items.length) return '';
  return `
  <div class="history-head">
    <h2 class="section-title">🕘 งานที่เคยเพิ่ม <span class="muted">(${items.length})</span></h2>
    <input class="input history-search" type="search" placeholder="🔍 ค้นหางานที่เคยเพิ่ม…" data-history-search>
  </div>
  <div class="card history-list">
    ${items.map((t) => `
      <div class="history-row" data-history-text="${esc([t.title, t.zone, t.detail, t.assignee_name].join(' ').toLowerCase())}">
        <div class="info">
          <div class="history-title">${esc(t.title)}</div>
          <div class="meta">
            ${t.zone ? `<span>📍 ${esc(t.zone)}</span>` : ''}
            <span>👤 ${t.assignee_name ? esc(t.assignee_name) : 'ทุกคน'}</span>
            <span>🔁 ${t.use_count} ครั้ง</span>
            <span>🕘 ${fmtTime(t.last_used_at)}</span>
          </div>
        </div>
        <div class="history-actions">
          <button class="btn small" data-action="use-template" data-id="${t.id}" title="ใส่ข้อมูลลงฟอร์มเพื่อแก้ก่อนเพิ่ม">📝 ใช้ซ้ำ</button>
          <button class="btn small primary" data-action="quick-add" data-id="${t.id}" title="เพิ่มงานนี้อีกครั้งทันที">➕ เพิ่มเลย</button>
          <button class="btn small danger-ghost" data-action="delete-template" data-id="${t.id}" title="เอาออกจากรายการที่เคยเพิ่ม">🗑</button>
        </div>
      </div>`).join('')}
    <div class="empty history-empty" hidden>ไม่พบงานที่ค้นหา</div>
  </div>`;
}

function taskForm() {
  const editTask = state.tasks.find((x) => x.id === state.editingId);
  const template = !editTask && state.templates.find((x) => x.id === state.templateId);
  // งานที่ใช้ซ้ำ: คัดลอกทุกอย่าง ยกเว้นวันกำหนดเสร็จ
  const t = editTask || (template ? { ...template, id: undefined, due_date: '' } : {});
  const editing = !!editTask;
  return `<form class="card" id="task-form">
    <h2 class="section-title" style="margin-top:0">${editing ? '✏️ แก้ไขงาน' : '➕ เพิ่มงานใหม่'}</h2>
    <div class="form-grid">
      <label class="field full">ชื่องาน *
        <input name="title" required maxlength="200" placeholder="เช่น ทำความสะอาดห้องน้ำ" value="${esc(t.title)}">
      </label>
      <label class="field">โซน / สถานที่
        <input name="zone" maxlength="100" placeholder="เช่น โซน A ชั้น 2" value="${esc(t.zone)}">
      </label>
      <label class="field">มอบหมายให้
        <select name="assigned_to">${employeeOptions(t.assigned_to)}</select>
      </label>
      <label class="field">กำหนดเสร็จ
        <input name="due_date" type="date" value="${esc(t.due_date)}">
      </label>
      <label class="field full">รายละเอียด
        <textarea name="detail" maxlength="2000" placeholder="สิ่งที่ต้องทำ (ถ้ามี)">${esc(t.detail)}</textarea>
      </label>
    </div>
    <div class="form-actions" style="margin-top:12px">
      ${editing ? '<button type="button" class="btn" data-action="cancel-edit">ยกเลิก</button>' : ''}
      ${template ? '<button type="button" class="btn" data-action="clear-form">ล้างฟอร์ม</button>' : ''}
      <button class="btn primary" type="submit">${editing ? 'บันทึก' : 'เพิ่มงาน'}</button>
    </div>
  </form>
  ${editing ? '' : historyList()}`;
}

function employerTasks() {
  const list = filteredTasks();
  return `
    ${statsBar()}
    <div class="task-list">
      ${list.length ? list.map(employerTaskCard).join('') : emptyBox('ไม่มีงานในหมวดนี้')}
    </div>`;
}

function employerTaskCard(t) {
  let actions = '';
  if (t.status === 'submitted') {
    actions += `<button class="btn success" data-action="approve" data-id="${t.id}">✔ Checklist Complete</button>
                <button class="btn" data-action="reject" data-id="${t.id}">↩ ส่งกลับให้ทำใหม่</button>`;
  } else if (t.status === 'done') {
    actions += `<button class="btn small" data-action="undo" data-id="${t.id}">ยกเลิก Complete</button>`;
  }
  actions += `<span class="spacer"></span>
    <button class="btn small" data-action="edit" data-id="${t.id}">✏️ แก้ไข</button>
    <button class="btn small danger-ghost" data-action="delete" data-id="${t.id}">🗑 ลบ</button>`;
  return `<article class="card task ${t.status}">
    ${taskCardHead(t)}
    ${taskProof(t)}
    <div class="task-actions">${actions}</div>
  </article>`;
}

function employerUsers() {
  return `
  <form class="card" id="user-form">
    <h2 class="section-title" style="margin-top:0">➕ เพิ่มบัญชีผู้ใช้</h2>
    <div class="form-grid">
      <label class="field">ชื่อที่แสดง *<input name="name" required maxlength="100" placeholder="เช่น สมชาย"></label>
      <label class="field">ประเภทบัญชี
        <select name="role"><option value="employee">พนักงาน</option><option value="employer">นายจ้าง</option></select>
      </label>
      <label class="field">ชื่อผู้ใช้ (ใช้ล็อกอิน) *<input name="username" required maxlength="50" autocapitalize="none" placeholder="เช่น somchai"></label>
      <label class="field">รหัสผ่าน *<input name="password" required minlength="4" placeholder="อย่างน้อย 4 ตัว"></label>
    </div>
    <div class="form-actions" style="margin-top:12px"><button class="btn primary" type="submit">เพิ่มบัญชี</button></div>
  </form>
  <h2 class="section-title">บัญชีทั้งหมด (${state.users.length})</h2>
  <div class="card">
    ${state.users.map((u) => `
      <div class="user-row">
        <div class="avatar">${esc(u.name.trim().charAt(0) || '?')}</div>
        <div class="info">
          <div><strong>${esc(u.name)}</strong> <span class="badge ${u.role === 'employer' ? 'submitted' : 'done'}">${ROLE_TH[u.role]}</span></div>
          <small>ชื่อผู้ใช้: ${esc(u.username)}</small>
        </div>
        ${u.id === state.user.id ? '<small style="color:var(--muted)">(คุณ)</small>'
          : `<button class="btn small danger-ghost" data-action="delete-user" data-id="${u.id}">ลบ</button>`}
      </div>`).join('')}
  </div>`;
}

// ===== การกระทำ =====
async function refresh() {
  await loadData();
  render();
}

function replaceTask(task) {
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task);
}

const actions = {
  async logout() {
    await api('POST', '/api/logout').catch(() => {});
    Object.assign(state, { user: null, tasks: [], users: [], templates: [], templateId: null, filter: null, editingId: null, pendingPhotos: {} });
    render();
  },
  async 'change-password'() {
    const old_password = prompt('รหัสผ่านเดิม');
    if (old_password === null) return;
    const new_password = prompt('รหัสผ่านใหม่ (อย่างน้อย 4 ตัว)');
    if (new_password === null) return;
    await api('POST', '/api/me/password', { old_password, new_password });
    toast('เปลี่ยนรหัสผ่านแล้ว');
  },
  async submit(id, btn) {
    const photo = state.pendingPhotos[id];
    if (!photo) return toast('กรุณาแนบรูปก่อน', true);
    const comment = ($(`[data-comment-for="${id}"]`) || {}).value || '';
    btn.disabled = true; btn.textContent = 'กำลังส่ง…';
    try {
      replaceTask(await api('POST', `/api/tasks/${id}/submit`, { photo, comment }));
      delete state.pendingPhotos[id];
      toast('ส่งงานเรียบร้อย ✓');
      render();
    } catch (e) { btn.disabled = false; btn.textContent = 'ส่งงาน'; throw e; }
  },
  async approve(id) {
    replaceTask(await api('POST', `/api/tasks/${id}/approve`));
    toast('ทำเครื่องหมาย Complete แล้ว ✓');
    render();
  },
  async reject(id) {
    const note = prompt('เหตุผลที่ส่งกลับ / สิ่งที่ต้องแก้ไข', 'กรุณาทำใหม่ให้เรียบร้อย');
    if (note === null) return;
    replaceTask(await api('POST', `/api/tasks/${id}/reject`, { note }));
    toast('ส่งงานกลับให้พนักงานแล้ว');
    render();
  },
  async undo(id) {
    replaceTask(await api('POST', `/api/tasks/${id}/undo`));
    render();
  },
  edit(id) {
    state.editingId = id;
    state.employerTab = 'add';
    render();
    window.scrollTo(0, 0);
  },
  'cancel-edit'() { state.editingId = null; state.employerTab = 'tasks'; render(); },
  'use-template'(id) {
    state.templateId = id;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('[name="title"]').focus({ preventScroll: true });
    toast('ใส่ข้อมูลลงฟอร์มแล้ว แก้ไขได้ก่อนกดเพิ่มงาน');
  },
  'clear-form'() { state.templateId = null; render(); },
  async 'quick-add'(id, btn) {
    const t = state.templates.find((x) => x.id === id);
    if (!t) return;
    btn.disabled = true;
    try {
      replaceTask(await api('POST', '/api/tasks', {
        title: t.title, zone: t.zone, detail: t.detail, assigned_to: t.assigned_to || '',
      }));
      state.templates = await api('GET', '/api/templates');
      toast(`เพิ่มงาน "${t.title}" แล้ว`);
      render();
    } catch (e) { btn.disabled = false; throw e; }
  },
  async 'delete-template'(id) {
    const t = state.templates.find((x) => x.id === id);
    if (!confirm(`เอา "${t ? t.title : ''}" ออกจากรายการที่เคยเพิ่ม?\n(งานในหน้ารายการงานจะไม่ถูกลบ)`)) return;
    await api('DELETE', `/api/templates/${id}`);
    state.templates = state.templates.filter((x) => x.id !== id);
    if (state.templateId === id) state.templateId = null;
    render();
  },
  async delete(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!confirm(`ลบงาน "${t ? t.title : ''}" ?`)) return;
    await api('DELETE', `/api/tasks/${id}`);
    state.tasks = state.tasks.filter((x) => x.id !== id);
    if (state.editingId === id) state.editingId = null;
    toast('ลบงานแล้ว');
    render();
  },
  async 'delete-user'(id) {
    const u = state.users.find((x) => x.id === id);
    if (!confirm(`ลบบัญชี "${u ? u.name : ''}" ? (งานที่มอบหมายไว้จะเปลี่ยนเป็น "ทุกคน")`)) return;
    await api('DELETE', `/api/users/${id}`);
    toast('ลบบัญชีแล้ว');
    await refresh();
  },
};

// ===== ผูกเหตุการณ์ (ครั้งเดียว ใช้ event delegation) =====
document.addEventListener('click', async (e) => {
  const lb = $('#lightbox');
  if (e.target.closest('#lightbox')) { lb.hidden = true; return; }
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) { $('img', lb).src = zoom.src; lb.hidden = false; return; }

  const tabBtn = e.target.closest('[data-employer-tab]');
  if (tabBtn) {
    const next = tabBtn.dataset.employerTab;
    // ออกจากหน้าแก้ไขโดยไม่บันทึก = ยกเลิกการแก้ไข
    if (next !== 'add' || state.employerTab !== 'add') { state.editingId = null; state.templateId = null; }
    state.employerTab = next;
    render();
    return;
  }

  const filterBtn = e.target.closest('[data-filter]');
  if (filterBtn) {
    const f = filterBtn.dataset.filter;
    state.filter = state.filter === f && f !== 'all' ? 'all' : f;
    render();
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) {
    try { await actions[btn.dataset.action](Number(btn.dataset.id), btn); }
    catch (err) { toast(err.message, true); }
  }
});

// ค้นหางานที่เคยเพิ่ม (กรองทันทีโดยไม่วาดหน้าใหม่ เพื่อไม่ให้ช่องค้นหาหลุดโฟกัส)
document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-history-search]')) return;
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('[data-history-text]').forEach((row) => {
    const match = !q || row.dataset.historyText.includes(q);
    row.hidden = !match;
    if (match) shown++;
  });
  $('.history-empty').hidden = shown > 0;
});

document.addEventListener('keydown',(e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-photo-for]');
  if (!input || !input.files[0]) return;
  const id = Number(input.dataset.photoFor);
  const comment = ($(`[data-comment-for="${id}"]`) || {}).value || '';
  try {
    state.pendingPhotos[id] = await compressImage(input.files[0]);
    render();
    const c = $(`[data-comment-for="${id}"]`);
    if (c) c.value = comment;
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    if (form.id === 'login-form') {
      $('#login-error').textContent = '';
      // ระบบดูประเภทบัญชี (พนักงาน/นายจ้าง) จากชื่อผู้ใช้เอง
      state.user = await api('POST', '/api/login', data);
      state.filter = null;
      await refresh();
      return;
    }
    if (form.id === 'task-form') {
      if (state.editingId) {
        replaceTask(await api('PUT', `/api/tasks/${state.editingId}`, data));
        state.editingId = null;
        toast('บันทึกการแก้ไขแล้ว');
      } else {
        replaceTask(await api('POST', '/api/tasks', data));
        state.templates = await api('GET', '/api/templates');
        toast('เพิ่มงานแล้ว');
      }
      state.employerTab = 'tasks';
      state.templateId = null;
      state.filter = 'all';
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (form.id === 'user-form') {
      await api('POST', '/api/users', data);
      toast('เพิ่มบัญชีแล้ว');
      await refresh();
      return;
    }
  } catch (err) {
    if (form.id === 'login-form') $('#login-error').textContent = err.message;
    else toast(err.message, true);
  }
  if (document.body.contains(btn)) btn.disabled = false;
});

// ===== เริ่มต้น =====
(async function init() {
  try {
    state.user = await api('GET', '/api/me');
    await loadData();
  } catch { state.user = null; }
  render();
})();
