import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = s => document.querySelector(s);

let applications = [];
let roster = [];
let deadlines = [];
let risks = [];
let page = 1;
const pageSize = 20;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
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
function normalizeAdmission(v = "") {
  let n = normalize(v);
  if (n.endsWith("전형")) n = n.slice(0, -"전형".length);
  return n;
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function findDeadline(app) {
  const uniKey = normalizeUniversity(app.university);
  const admKey = normalizeAdmission(app.admissionName);
  const exact = deadlines.find(d =>
    d.universityKey === uniKey && d.admissionKey && d.admissionKey === admKey
  );
  if (exact) return exact;
  return deadlines.find(d => d.universityKey === uniKey && !d.admissionKey) || null;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function deadlineDiff(deadlineAt) {
  const due = parseDate(deadlineAt);
  if (!due) return {bucket:"none", label:""};
  const now = new Date();
  const diffMs = due - now;
  if (diffMs < 0) return {bucket:"overdue", label:"마감 지남"};

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const d = Math.round((dueDay - today) / 86400000);
  if (d <= 0) return {bucket:"today", label:"D-DAY"};
  if (d === 1) return {bucket:"d1", label:"D-1"};
  if (d === 2) return {bucket:"d2", label:"D-2"};
  return {bucket:"later", label:`D-${d}`};
}

function formatDeadline(v) {
  const d = parseDate(v);
  if (!d) return "";
  return d.toLocaleString("ko-KR", {
    month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"
  });
}

function buildRisks() {
  const list = [];

  applications.forEach(app => {
    const status = app.status || "검토중";
    if (status !== "원서접수완료") {
      const deadline = findDeadline(app);
      const diff = deadline ? deadlineDiff(deadline.deadlineAt) : null;

      if (diff && ["overdue","today","d1","d2"].includes(diff.bucket)) {
        list.push({
          type:["overdue","today"].includes(diff.bucket) ? "urgent" : "soon",
          studentKey:app.studentKey,
          classNo:app.classNo,
          studentNo:app.studentNo,
          studentName:app.studentName,
          university:app.university,
          department:app.department,
          admissionName:app.admissionName,
          status,
          deadline,
          diff
        });
      }

      if (status === "최종결정") {
        list.push({
          type:"final",
          studentKey:app.studentKey,
          classNo:app.classNo,
          studentNo:app.studentNo,
          studentName:app.studentName,
          university:app.university,
          department:app.department,
          admissionName:app.admissionName,
          status,
          deadline,
          diff
        });
      }
    }
  });

  const studentMap = new Map();
  applications.forEach(a => {
    if (!studentMap.has(a.studentKey)) studentMap.set(a.studentKey, []);
    studentMap.get(a.studentKey).push(a);
  });

  studentMap.forEach((apps, key) => {
    const submitted = apps.filter(a => (a.status || "검토중") === "원서접수완료").length;
    if (apps.length > 1 && submitted > 0 && submitted < apps.length) {
      const a = apps[0];
      list.push({
        type:"partial",
        studentKey:key,
        classNo:a.classNo,
        studentNo:a.studentNo,
        studentName:a.studentName,
        university:"",
        department:"",
        admissionName:"",
        status:`${submitted}/${apps.length} 접수완료`,
        deadline:null,
        diff:null
      });
    }
  });

  const entered = new Set(applications.map(a => a.studentKey));
  roster.forEach(st => {
    if (!entered.has(st.studentKey)) {
      list.push({
        type:"empty",
        studentKey:st.studentKey,
        classNo:st.classNo,
        studentNo:st.studentNo,
        studentName:st.studentName,
        university:"",
        department:"",
        admissionName:"",
        status:"지원정보 없음",
        deadline:null,
        diff:null
      });
    }
  });

  return list;
}

function typeLabel(type) {
  return ({
    urgent:"오늘·마감 지남",
    soon:"D-1 ~ D-2",
    final:"최종결정 후 미접수",
    partial:"일부만 접수완료",
    empty:"지원정보 없음"
  })[type] || type;
}

function filteredRisks() {
  const type = $("#riskTypeFilter").value;
  const classNo = $("#riskClassFilter").value;
  const q = $("#riskSearch").value.trim().toLowerCase();

  return risks.filter(r => {
    if (type && r.type !== type) return false;
    if (classNo && r.classNo !== classNo) return false;
    if (q && !String(r.studentName || "").toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b) =>
    Number(a.classNo)-Number(b.classNo) ||
    Number(a.studentNo)-Number(b.studentNo) ||
    String(a.studentName).localeCompare(String(b.studentName), "ko")
  );
}

function render() {
  const data = filteredRisks();
  const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
  if (page > totalPages) page = totalPages;

  const start = (page - 1) * pageSize;
  const visible = data.slice(start, start + pageSize);

  $("#riskListCount").textContent = `${data.length}건 · 페이지당 ${pageSize}건`;
  $("#riskPageInfo").textContent = `${page} / ${totalPages}`;
  $("#riskPrevBtn").disabled = page <= 1;
  $("#riskNextBtn").disabled = page >= totalPages;

  $("#riskDetailTable").innerHTML = visible.length
    ? visible.map(r => `
      <tr>
        <td><span class="risk-type-badge type-${r.type}">${escapeHtml(typeLabel(r.type))}</span></td>
        <td>${escapeHtml(r.classNo)}반 ${escapeHtml(r.studentNo)}번 <strong>${escapeHtml(r.studentName)}</strong></td>
        <td>${escapeHtml(r.university || "-")}</td>
        <td>${escapeHtml(r.department || "-")}</td>
        <td>${escapeHtml(r.admissionName || "-")}</td>
        <td>${escapeHtml(r.status || "-")}</td>
        <td>
          ${r.deadline
            ? `<span class="risk-dday ${r.diff?.bucket || ""}">${escapeHtml(r.diff?.label || "")}</span>
               <small class="risk-date">${escapeHtml(formatDeadline(r.deadline.deadlineAt))}</small>`
            : "-"}
        </td>
      </tr>
    `).join("")
    : `<tr><td colspan="7"><div class="empty">조건에 맞는 학생이 없습니다.</div></td></tr>`;
}

function resetPageAndRender() {
  page = 1;
  render();
}

$("#riskTypeFilter").addEventListener("change", resetPageAndRender);
$("#riskClassFilter").addEventListener("change", resetPageAndRender);
$("#riskSearch").addEventListener("input", resetPageAndRender);

$("#riskPrevBtn").addEventListener("click", () => {
  if (page > 1) {
    page--;
    render();
    window.scrollTo({top:0, behavior:"smooth"});
  }
});
$("#riskNextBtn").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(filteredRisks().length / pageSize));
  if (page < totalPages) {
    page++;
    render();
    window.scrollTo({top:0, behavior:"smooth"});
  }
});

const initialFilter = new URLSearchParams(location.search).get("filter") || "";
if (["urgent","soon","final","partial","empty"].includes(initialFilter)) {
  $("#riskTypeFilter").value = initialFilter;
}

onAuthStateChanged(auth, user => {
  if (!user || user.providerData?.[0]?.providerId !== "password") {
    $("#riskLoginWait").innerHTML = `
      <h2>교사 로그인이 필요합니다.</h2>
      <p class="helper">먼저 관리자 대시보드에서 교사 계정으로 로그인해 주세요.</p>
      <a class="link-button" href="./admin.html">관리자 로그인으로 이동</a>
    `;
    return;
  }

  $("#riskLoginWait").classList.add("hidden");
  $("#riskDashboard").classList.remove("hidden");

  onSnapshot(collection(db, "applications"), snap => {
    applications = snap.docs.map(d => ({id:d.id, ...d.data()}));
    risks = buildRisks();
    render();
    $("#riskPageSync").textContent = `실시간 동기화 중 · ${new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}`;
  });

  onSnapshot(collection(db, "students"), snap => {
    roster = snap.docs.map(d => ({id:d.id, ...d.data()}));
    risks = buildRisks();
    render();
  });

  onSnapshot(collection(db, "applicationDeadlines"), snap => {
    deadlines = snap.docs.map(d => ({id:d.id, ...d.data()}));
    risks = buildRisks();
    render();
  });
});
