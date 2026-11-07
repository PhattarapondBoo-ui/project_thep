/*
 * ส่วนหลังบ้านบน Firebase (Authentication + Firestore)
 * รับคำสั่งแบบเดียวกับ server.py เดิม (เช่น 'POST', '/api/tasks') หน้าเว็บจึงไม่ต้องเปลี่ยน
 *
 * โครงข้อมูลใน Firestore:
 *   users/{uid}      ชื่อ, ชื่อผู้ใช้, role (employer|employee)
 *   tasks/{id}       งาน
 *   photos/{taskId}  รูปที่พนักงานส่ง (แยกไว้ ไม่ให้โหลดรายการงานช้า)
 *   templates/{id}   งานที่เคยเพิ่ม (ใช้ซ้ำ)
 *   meta/setup       มีแล้ว = ตั้งค่าครั้งแรกเสร็จแล้ว
 */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, writeBatch, query, where, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ชื่อผู้ใช้จะถูกแปลงเป็นอีเมลภายใน (Firebase ต้องใช้อีเมล) — พนักงานไม่ต้องรู้เรื่องนี้
const EMAIL_DOMAIN = 'ptep.example.com';
const ROLE_TH = { employer: 'นายจ้าง', employee: 'พนักงาน' };
const USERNAME_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_PHOTO_CHARS = 950_000; // เอกสาร Firestore ใหญ่ได้ไม่เกิน ~1MB

export const configured = !!(firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR'));

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const nowSec = () => Math.floor(Date.now() / 1000);
const toEmail = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

let auth, db, authReady;
if (configured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  authReady = new Promise((resolve) => { const off = onAuthStateChanged(auth, () => { off(); resolve(); }); });
}

// ---------- ผู้ใช้ ----------
let profile = null;            // ผู้ที่ล็อกอินอยู่
const users = new Map();       // uid -> ข้อมูลผู้ใช้ (ใช้แสดงชื่อ)

async function loadUsers() {
  const snap = await getDocs(collection(db, 'users'));
  users.clear();
  snap.forEach((d) => users.set(d.id, { id: d.id, ...d.data() }));
  return [...users.values()];
}

async function me() {
  await authReady;
  const u = auth.currentUser;
  if (!u) fail(401, 'กรุณาเข้าสู่ระบบ');
  if (profile && profile.id === u.uid) return profile;
  const snap = await getDoc(doc(db, 'users', u.uid));
  if (!snap.exists()) { await signOut(auth); fail(401, 'บัญชีนี้ถูกลบหรือปิดการใช้งานแล้ว'); }
  const d = snap.data();
  profile = { id: u.uid, username: d.username, name: d.name, role: d.role };
  return profile;
}

async function need(role) {
  const p = await me();
  if (p.role !== role) fail(403, `เฉพาะ${ROLE_TH[role]}เท่านั้น`);
  if (!users.size) await loadUsers();
  return p;
}

// ---------- งาน ----------
function taskOut(id, d) {
  return {
    id,
    title: d.title || '',
    zone: d.zone || '',
    detail: d.detail || '',
    assigned_to: d.assigned_to ?? null,
    due_date: d.due_date || '',
    status: d.status || 'todo',
    photo: d.photo_at ? String(d.photo_at) : '',   // เวอร์ชันรูป (ตัวรูปอยู่ใน photos/{id})
    comment: d.comment || '',
    reject_note: d.reject_note || '',
    submitted_by: d.submitted_by ?? null,
    submitted_at: d.submitted_at ?? null,
    approved_at: d.approved_at ?? null,
    created_at: d.created_at || 0,
    assignee_name: d.assigned_to ? (users.get(d.assigned_to)?.name ?? null) : null,
    submitter_name: d.submitted_by ? (users.get(d.submitted_by)?.name ?? null) : null,
  };
}

async function getTask(id) {
  const snap = await getDoc(doc(db, 'tasks', id));
  if (!snap.exists()) fail(404, 'ไม่พบงานนี้');
  return taskOut(snap.id, snap.data());
}

function taskFields(d) {
  const title = str(d.title, 200);
  if (!title) fail(400, 'กรุณาใส่ชื่องาน');
  const assigned = d.assigned_to ? String(d.assigned_to) : null;
  if (assigned && users.get(assigned)?.role !== 'employee') fail(400, 'ไม่พบพนักงานที่เลือก');
  const due = str(d.due_date, 20);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(400, 'รูปแบบวันที่ไม่ถูกต้อง');
  return { title, zone: str(d.zone, 100), detail: str(d.detail, 2000), assigned_to: assigned, due_date: due };
}

// ---------- งานที่เคยเพิ่ม ----------
function templateId(f) {
  // แฮชสั้น ๆ ของ ชื่อ|โซน|รายละเอียด (งานเดียวกัน = เอกสารเดียวกัน)
  const key = [f.title, f.zone, f.detail].map((s) => (s || '').trim().toLowerCase()).join('|');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 't' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + key.length.toString(16);
}

function rememberTemplate(f, ts) {
  return setDoc(doc(db, 'templates', templateId(f)), {
    title: f.title, zone: f.zone, detail: f.detail, assigned_to: f.assigned_to,
    use_count: increment(1), last_used_at: ts,
  }, { merge: true });
}

// ---------- คำสั่งทั้งหมด ----------
const routes = [
  // ตั้งค่าครั้งแรก
  ['GET', /^\/api\/setup$/, async () => ({ needed: !(await getDoc(doc(db, 'meta', 'setup'))).exists() })],
  ['POST', /^\/api\/setup$/, async (d) => {
    const name = str(d.name, 100) || 'นายจ้าง';
    const username = str(d.username, 50);
    const password = String(d.password ?? '');
    if (!USERNAME_RE.test(username)) fail(400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z, 0-9, _ . -');
    if (password.length < 6) fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
    if ((await getDoc(doc(db, 'meta', 'setup'))).exists()) fail(403, 'ตั้งค่าไปแล้ว กรุณาเข้าสู่ระบบ');
    const cred = await createUserWithEmailAndPassword(auth, toEmail(username), password);
    try {
      const b = writeBatch(db);
      b.set(doc(db, 'users', cred.user.uid), { username, name, role: 'employer', created_at: nowSec() });
      b.set(doc(db, 'meta', 'setup'), { done: true, at: nowSec() });
      await b.commit();
    } catch (e) {
      await cred.user.delete().catch(() => {});
      throw e;
    }
    await signOut(auth);
    profile = null;
    return { ok: true };
  }],

  // เข้าสู่ระบบ / ออก / เปลี่ยนรหัส
  ['POST', /^\/api\/login$/, async (d) => {
    const username = str(d.username, 50);
    if (!USERNAME_RE.test(username)) fail(400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    await signInWithEmailAndPassword(auth, toEmail(username), String(d.password ?? ''));
    profile = null;
    return me();
  }],
  ['POST', /^\/api\/logout$/, async () => {
    await signOut(auth);
    profile = null;
    users.clear();
    return { ok: true };
  }],
  ['GET', /^\/api\/me$/, () => me()],
  ['POST', /^\/api\/me\/password$/, async (d) => {
    await me();
    const newPw = String(d.new_password ?? '');
    if (newPw.length < 6) fail(400, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร');
    const u = auth.currentUser;
    try {
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, String(d.old_password ?? '')));
    } catch (e) {
      if (/invalid-credential|wrong-password/.test(e.code || '')) fail(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
      throw e;
    }
    await updatePassword(u, newPw);
    return { ok: true };
  }],

  // งาน
  ['GET', /^\/api\/tasks$/, async () => {
    const p = await me();
    await loadUsers();
    let docs;
    if (p.role === 'employer') {
      docs = (await getDocs(collection(db, 'tasks'))).docs;
    } else {
      const [mine, everyone] = await Promise.all([
        getDocs(query(collection(db, 'tasks'), where('assigned_to', '==', p.id))),
        getDocs(query(collection(db, 'tasks'), where('assigned_to', '==', null))),
      ]);
      docs = [...mine.docs, ...everyone.docs];
    }
    return docs.map((d) => taskOut(d.id, d.data())).sort((a, b) => b.created_at - a.created_at);
  }],
  ['POST', /^\/api\/tasks$/, async (d) => {
    await need('employer');
    const f = taskFields(d);
    const ts = nowSec();
    const data = {
      ...f, status: 'todo', photo_at: null, comment: '', reject_note: '',
      submitted_by: null, submitted_at: null, approved_at: null, created_at: ts,
    };
    const ref = await addDoc(collection(db, 'tasks'), data);
    await rememberTemplate(f, ts);
    return taskOut(ref.id, data);
  }],
  ['PUT', /^\/api\/tasks\/([\w-]+)$/, async (d, id) => {
    await need('employer');
    await getTask(id);
    await updateDoc(doc(db, 'tasks', id), taskFields(d));
    return getTask(id);
  }],
  ['DELETE', /^\/api\/tasks\/([\w-]+)$/, async (d, id) => {
    await need('employer');
    const b = writeBatch(db);
    b.delete(doc(db, 'tasks', id));
    b.delete(doc(db, 'photos', id));
    await b.commit();
    return { ok: true };
  }],
  ['POST', /^\/api\/tasks\/([\w-]+)\/submit$/, async (d, id) => {
    const p = await need('employee');
    const photo = String(d.photo ?? '');
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(photo)) fail(400, 'กรุณาแนบรูปภาพ');
    if (photo.length > MAX_PHOTO_CHARS) fail(413, 'รูปใหญ่เกินไป ลองถ่ายใหม่หรือเลือกรูปอื่น');
    const t = await getTask(id);
    if (t.assigned_to && t.assigned_to !== p.id) fail(404, 'ไม่พบงานนี้');
    if (t.status === 'done') fail(400, 'งานนี้นายจ้างตรวจผ่านแล้ว');
    const ts = nowSec();
    const b = writeBatch(db);
    b.set(doc(db, 'photos', id), { data: photo, updated_at: ts });
    b.update(doc(db, 'tasks', id), {
      status: 'submitted', comment: str(d.comment, 500), reject_note: '',
      submitted_by: p.id, submitted_at: ts, photo_at: ts,
    });
    await b.commit();
    return getTask(id);
  }],
  ['POST', /^\/api\/tasks\/([\w-]+)\/(approve|reject|undo)$/, async (d, id, action) => {
    await need('employer');
    const t = await getTask(id);
    const ref = doc(db, 'tasks', id);
    if (action === 'approve') {
      if (t.status !== 'submitted') fail(400, 'งานนี้ยังไม่ได้ส่งหรือตรวจไปแล้ว');
      await updateDoc(ref, { status: 'done', approved_at: nowSec() });
    } else if (action === 'reject') {
      if (t.status === 'todo') fail(400, 'งานนี้ยังไม่ได้ส่ง');
      await updateDoc(ref, { status: 'todo', reject_note: str(d.note, 500) || 'กรุณาทำใหม่', approved_at: null });
    } else {
      if (t.status !== 'done') fail(400, 'งานนี้ยังไม่ได้กด complete');
      await updateDoc(ref, { status: 'submitted', approved_at: null });
    }
    return getTask(id);
  }],

  // งานที่เคยเพิ่ม
  ['GET', /^\/api\/templates$/, async () => {
    await need('employer');
    const snap = await getDocs(collection(db, 'templates'));
    return snap.docs.map((s) => {
      const t = s.data();
      return { id: s.id, ...t, assignee_name: t.assigned_to ? (users.get(t.assigned_to)?.name ?? null) : null };
    }).sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0));
  }],
  ['DELETE', /^\/api\/templates\/([\w-]+)$/, async (d, id) => {
    await need('employer');
    const b = writeBatch(db);
    b.delete(doc(db, 'templates', id));
    await b.commit();
    return { ok: true };
  }],

  // ผู้ใช้
  ['GET', /^\/api\/users$/, async () => {
    await need('employer');
    const list = await loadUsers();
    return list.sort((a, b) => (a.role === b.role ? (a.created_at || 0) - (b.created_at || 0) : a.role === 'employer' ? -1 : 1));
  }],
  ['POST', /^\/api\/users$/, async (d) => {
    await need('employer');
    await loadUsers();
    const name = str(d.name, 100);
    const username = str(d.username, 50);
    const password = String(d.password ?? '');
    const role = d.role in ROLE_TH ? d.role : 'employee';
    if (!name || !username) fail(400, 'กรุณากรอกชื่อและชื่อผู้ใช้');
    if (!USERNAME_RE.test(username)) fail(400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z, 0-9, _ . -');
    if (password.length < 6) fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
    if ([...users.values()].some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) {
      fail(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
    }
    // สร้างบัญชีผ่านแอปสำรอง เพื่อไม่ให้นายจ้างหลุดจากระบบ
    const second = initializeApp(firebaseConfig, `create-user-${Date.now()}`);
    try {
      const secondAuth = initializeAuth(second, { persistence: inMemoryPersistence });
      const cred = await createUserWithEmailAndPassword(secondAuth, toEmail(username), password);
      const data = { username, name, role, created_at: nowSec() };
      await setDoc(doc(db, 'users', cred.user.uid), data);
      await signOut(secondAuth);
      users.set(cred.user.uid, { id: cred.user.uid, ...data });
      return { id: cred.user.uid, ...data };
    } finally {
      await deleteApp(second).catch(() => {});
    }
  }],
  ['DELETE', /^\/api\/users\/([\w-]+)$/, async (d, uid) => {
    const p = await need('employer');
    if (uid === p.id) fail(400, 'ลบบัญชีตัวเองไม่ได้');
    // งานที่มอบหมายให้คนนี้ → เปลี่ยนเป็น "ทุกคน"
    const [tasks, templates] = await Promise.all([
      getDocs(query(collection(db, 'tasks'), where('assigned_to', '==', uid))),
      getDocs(query(collection(db, 'templates'), where('assigned_to', '==', uid))),
    ]);
    const b = writeBatch(db);
    tasks.forEach((s) => b.update(s.ref, { assigned_to: null }));
    templates.forEach((s) => b.update(s.ref, { assigned_to: null }));
    b.delete(doc(db, 'users', uid));
    await b.commit();
    users.delete(uid);
    return { ok: true };
  }],
];

// ---------- แปลงข้อผิดพลาดของ Firebase เป็นข้อความไทย ----------
const ERRORS = {
  'auth/invalid-credential': [400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  'auth/wrong-password': [400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  'auth/user-not-found': [400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  'auth/invalid-email': [400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  'auth/user-disabled': [400, 'บัญชีนี้ถูกปิดการใช้งาน'],
  'auth/email-already-in-use': [400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว หรือเคยถูกใช้แล้ว — ลองชื่ออื่น'],
  'auth/weak-password': [400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'],
  'auth/too-many-requests': [429, 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'],
  'auth/network-request-failed': [503, 'เชื่อมต่ออินเทอร์เน็ตไม่ได้'],
  'auth/operation-not-allowed': [503, 'ยังไม่ได้เปิดการล็อกอินแบบ Email/Password ใน Firebase'],
  'auth/configuration-not-found': [503, 'ยังไม่ได้เปิด Firebase Authentication (Email/Password)'],
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': [503, 'ค่า apiKey ใน firebase-config.js ไม่ถูกต้อง'],
  'permission-denied': [403, 'ไม่มีสิทธิ์ทำรายการนี้ (ตรวจกฎ Firestore Rules)'],
  'unavailable': [503, 'เชื่อมต่ออินเทอร์เน็ตไม่ได้'],
  'not-found': [503, 'ยังไม่ได้สร้าง Firestore Database ในโปรเจกต์ Firebase'],
  'failed-precondition': [503, 'ยังไม่ได้สร้าง Firestore Database ในโปรเจกต์ Firebase'],
};

function translate(e) {
  if (e instanceof ApiError) return e;
  const hit = ERRORS[e && e.code];
  if (hit) return new ApiError(hit[0], hit[1]);
  console.error(e);
  return new ApiError(500, 'เกิดข้อผิดพลาด: ' + ((e && (e.code || e.message)) || 'ไม่ทราบสาเหตุ'));
}

/** เรียกแบบเดียวกับ API เดิม เช่น request('POST', '/api/tasks', {...}) */
export async function request(method, url, data) {
  if (!configured) fail(503, 'ยังไม่ได้ตั้งค่า Firebase — ใส่ค่าในไฟล์ public/firebase-config.js');
  for (const [m, re, fn] of routes) {
    const match = m === method && url.match(re);
    if (match) {
      try { return await fn(data || {}, ...match.slice(1)); } catch (e) { throw translate(e); }
    }
  }
  fail(404, 'ไม่พบคำสั่ง');
}

/** โหลดรูปของงาน (data URL) */
export async function photo(taskId) {
  const snap = await getDoc(doc(db, 'photos', taskId));
  return snap.exists() ? snap.data().data : null;
}
