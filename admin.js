import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = (s) => document.querySelector(s);
const toastEl = $("#toast");
let rows = [];
let unsubscribe = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function normalize(v = "") {
  return String(v).toLowerCase().replace(/\s+/g, "").replace(/[()·ㆍ\-_.]/g, "");
}
function normalizeUniversity(v = "") {
  let n = normalize(v);
  if (n.endsWith("교육대학교")) n = n.slice(0, -"교육대학교".length) + "교대";
  else if (n.endsWith("대학교")) n = n.slice(0, -"대학교".length);
  else if (n.endsWith("대학")) n = n.slice(0, -"대학".length);
  else if (n.endsWith("대") && !n.endsWith("교대")) n = n.slice(0, -1);
  return n;
}
function normalizeDepartment(v = "") {
  let n = normalize(v);
  if (n.endsWith("학과")) n = n.slice(0, -"학과".length);
  else if (n.endsWith("학부")) n = n.slice(0, -"학부".length);
  return n;
}
function normalizeAdmission(v = "") {
  let n = normalize(v);
  if (n.endsWith("전형")) n = n.slice(0, -"전형".length);
  return n;
}
function refreshComparisonKeys(row) {
  return {
    ...row,
    universityKey: normalizeUniversity(row.university),
    departmentKey: [normalizeUniversity(row.university), normalizeDepartment(row.department)].join("|"),
    exactKey: [
      normalizeUniversity(row.university),
      normalizeDepartment(row.department),
      normalizeAdmission(row.admissionName)
    ].join("|")
  };
}
function groupBy(key) {
  const m = new Map();
  rows.forEach(r => {
    const k = r[key] || "";
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  return [...m.entries()].filter(([,v]) => new Set(v.map(x=>x.studentKey)).size >= 2);
}
function duplicatesSet(key) {
  const set = new Set();
  groupBy(key).forEach(([,v]) => v.forEach(x => set.add(x.id)));
  return set;
}
function filteredRows() {
  const c = $("#filterClass").value;
  const type = $("#filterType").value;
  const q = $("#searchInput").value.trim().toLowerCase();
  const mode = $("#viewMode").value;
  const exact = duplicatesSet("exactKey");
  const dept = duplicatesSet("departmentKey");
  const uni = duplicatesSet("universityKey");

  return rows.filter(r => {
    if (c && r.classNo !== c) return false;
    if (type && r.admissionType !== type) return false;
    if (q && ![r.studentName,r.university,r.department,r.admissionType,r.admissionName].join(" ").toLowerCase().includes(q)) return false;
    if (mode === "exact" && !exact.has(r.id)) return false;
    if (mode === "department" && !dept.has(r.id)) return false;
    if (mode === "university" && !uni.has(r.id)) return false;
    return true;
  }).sort((a,b) => Number(a.classNo)-Number(b.classNo) || Number(a.studentNo)-Number(b.studentNo) || (a.priority||9)-(b.priority||9));
}
function statusClass(s) {
  if (s === "최종결정") return "final";
  if (s === "원서접수완료") return "submitted";
  return "";
}
function renderStats() {
  const students = new Set(rows.map(r => r.studentKey));
  $("#studentCount").textContent = students.size;
  $("#applicationCount").textContent = rows.length;
  $("#exactCount").textContent = groupBy("exactKey").length;
  $("#deptCount").textContent = groupBy("departmentKey").length;
}
function renderClassStatus() {
  const host = $("#classStatusGrid");
  const counts = {};
  for (let i = 1; i <= 9; i++) counts[String(i)] = new Set();

  rows.forEach(r => {
    if (counts[r.classNo]) counts[r.classNo].add(r.studentKey);
  });

  host.innerHTML = Object.entries(counts).map(([classNo, set]) => `
    <button type="button" class="class-status-item" data-class="${classNo}">
      <span class="class-label">${classNo}반</span>
      <strong>${set.size}</strong>
      <small>명 입력</small>
    </button>
  `).join("");

  host.querySelectorAll(".class-status-item").forEach(btn => {
    btn.addEventListener("click", () => {
      $("#filterClass").value = btn.dataset.class;
      renderTable();
      document.querySelector(".filters").scrollIntoView({behavior:"smooth", block:"center"});
    });
  });
}

function renderDuplicates() {
  const host = $("#duplicateGroups");
  const exactGroups = groupBy("exactKey").sort((a,b)=>b[1].length-a[1].length);
  const exactKeys = new Set(exactGroups.map(x=>x[0]));
  const deptGroups = groupBy("departmentKey").filter(([k]) => {
    const related = rows.filter(r=>r.departmentKey===k);
    return new Set(related.map(r=>r.exactKey)).size > 1;
  }).sort((a,b)=>b[1].length-a[1].length);

  const cards = [];
  exactGroups.forEach(([,g]) => {
    const first = g[0];
    const people = [...new Map(g.map(x=>[x.studentKey,x])).values()];
    cards.push(`
      <div class="dup-card exact">
        <div class="dup-tag">🔴 완전 중복 · ${people.length}명</div>
        <div class="dup-title">${escapeHtml(first.university)} · ${escapeHtml(first.department)}</div>
        <div class="dup-sub">${escapeHtml(first.admissionName)} / ${escapeHtml(first.admissionType)}</div>
        <div class="dup-people">${people.map(x=>`<span class="person-chip">${escapeHtml(x.classNo)}반 ${escapeHtml(x.studentName)}</span>`).join("")}</div>
      </div>`);
  });
  deptGroups.forEach(([,g]) => {
    const first = g[0];
    const people = [...new Map(g.map(x=>[x.studentKey,x])).values()];
    cards.push(`
      <div class="dup-card department">
        <div class="dup-tag">🟠 동일 대학·학과 · ${people.length}명</div>
        <div class="dup-title">${escapeHtml(first.university)} · ${escapeHtml(first.department)}</div>
        <div class="dup-sub">전형이 서로 다르므로 확인이 필요합니다.</div>
        <div class="dup-people">${people.map(x=>`<span class="person-chip">${escapeHtml(x.classNo)}반 ${escapeHtml(x.studentName)} · ${escapeHtml(x.admissionName)}</span>`).join("")}</div>
      </div>`);
  });
  host.innerHTML = cards.length ? cards.join("") : `<div class="empty">현재 탐지된 중복지원 그룹이 없습니다.</div>`;
}
function renderTable() {
  const data = filteredRows();
  $("#visibleCount").textContent = `${data.length}건 표시`;
  $("#applicationTable").innerHTML = data.length ? data.map(r => `
    <tr>
      <td class="student-cell">${escapeHtml(r.classNo)}반 ${escapeHtml(r.studentNo)}번<br>${escapeHtml(r.studentName)}</td>
      <td>${escapeHtml(r.university)}</td>
      <td>${escapeHtml(r.department)}</td>
      <td>${escapeHtml(r.admissionType)}</td>
      <td>${escapeHtml(r.admissionName)}</td>
      <td><span class="status-pill ${statusClass(r.status)}">${escapeHtml(r.status || "검토중")}</span></td>
    </tr>`).join("") : `<tr><td colspan="6"><div class="empty">조건에 맞는 지원정보가 없습니다.</div></td></tr>`;
}
function render() {
  renderStats();
  renderClassStatus();
  renderDuplicates();
  renderTable();
}
["filterClass","filterType","viewMode"].forEach(id => $("#"+id).addEventListener("change", renderTable));
$("#searchInput").addEventListener("input", renderTable);

$("#loginBtn").addEventListener("click", async () => {
  $("#loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value);
  } catch(e) {
    $("#loginError").textContent = "로그인에 실패했습니다. 이메일과 비밀번호를 확인해 주세요.";
  }
});
$("#logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  if (user) {
    $("#loginPanel").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    if (unsubscribe) unsubscribe();
    unsubscribe = onSnapshot(collection(db, "applications"), snap => {
      rows = snap.docs.map(d=>refreshComparisonKeys({id:d.id,...d.data()}));
      $("#syncText").textContent = `실시간 동기화 중 · ${new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})} 기준`;
      render();
    }, err => {
      console.error(err);
      $("#syncText").textContent = "데이터 조회 권한을 확인해 주세요.";
    });
  } else {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    rows = [];
    $("#dashboard").classList.add("hidden");
    $("#loginPanel").classList.remove("hidden");
  }
});

$("#exportBtn").addEventListener("click", () => {
  const headers = ["반","번호","이름","지원순위","대학","학과","전형유형","전형명","상태","메모"];
  const body = rows.sort((a,b)=>Number(a.classNo)-Number(b.classNo)||Number(a.studentNo)-Number(b.studentNo)||(a.priority||9)-(b.priority||9))
    .map(r=>[r.classNo,r.studentNo,r.studentName,r.priority,r.university,r.department,r.admissionType,r.admissionName,r.status,r.memo]);
  const csv = "\ufeff" + [headers,...body].map(row=>row.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download=`수시지원현황_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast("CSV 파일을 내려받았습니다.");
});
