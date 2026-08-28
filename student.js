import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, query, where, getDocs, getDoc, setDoc, writeBatch, doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
let currentUser = null;

await signInAnonymously(auth);
await new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => {
    if (user) {
      currentUser = user;
      off();
      resolve();
    }
  });
});

const $ = (s) => document.querySelector(s);
const applicationsEl = $("#applications");
const toastEl = $("#toast");
let loadedStudentKey = null;
let verifiedStudentKey = null;
let verifiedAccessId = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function normalize(v = "") {
  return v.toLowerCase().replace(/\s+/g, "").replace(/[()·ㆍ\-_.]/g, "");
}

// 비교용 표준화: 학생이 입력한 원문은 그대로 저장하고,
// 중복 탐지용 키만 표기 차이를 줄여서 생성합니다.
function normalizeUniversity(v = "") {
  let n = normalize(v);

  // 흔한 대학 표기 차이 통일
  if (n.endsWith("교육대학교")) n = n.slice(0, -"교육대학교".length) + "교대";
  else if (n.endsWith("대학교")) n = n.slice(0, -"대학교".length);
  else if (n.endsWith("대학")) n = n.slice(0, -"대학".length);
  else if (n.endsWith("대") && !n.endsWith("교대")) n = n.slice(0, -1);

  return n;
}

function normalizeDepartment(v = "") {
  let n = normalize(v);

  // 학과/학부 표기 차이를 비교용으로만 통일
  if (n.endsWith("학과")) n = n.slice(0, -"학과".length);
  else if (n.endsWith("학부")) n = n.slice(0, -"학부".length);

  return n;
}

function normalizeAdmission(v = "") {
  let n = normalize(v);
  if (n.endsWith("전형")) n = n.slice(0, -"전형".length);
  return n;
}

function studentKey() {
  const c = $("#classNo").value.trim();
  const n = $("#studentNo").value.trim().padStart(2, "0");
  const name = $("#studentName").value.trim();
  return `${c}-${n}-${normalize(name)}`;
}
async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function accessIdFor(studentKeyValue, pin) {
  return sha256(`2027-susi-support|${studentKeyValue}|${pin}`);
}
async function verifyPin(id) {
  const pin = $("#studentPin").value.trim();
  if (!/^\d{8}$/.test(pin)) throw new Error("교사가 안내한 8자리 PIN을 입력해 주세요.");
  const accessId = await accessIdFor(id.studentKey, pin);
  const accessSnap = await getDoc(doc(db, "studentAccess", accessId));
  if (!accessSnap.exists() || accessSnap.data().studentKey !== id.studentKey) throw new Error("학생 정보 또는 PIN이 맞지 않습니다.");
  await setDoc(doc(db, "studentSessions", currentUser.uid), {studentKey:id.studentKey, accessId, updatedAt:serverTimestamp()});
  verifiedStudentKey = id.studentKey;
  verifiedAccessId = accessId;
}

function applicationTemplate(data = {}) {
  const div = document.createElement("div");
  div.className = "application-card";
  div.innerHTML = `
    <div class="application-head">
      <div class="application-title">지원 <span class="app-index"></span></div>
      <button type="button" class="remove-btn">삭제</button>
    </div>
    <div class="application-grid">
      <label>대학
        <input class="university" value="${escapeHtml(data.university || "")}" placeholder="예: 강원대학교" />
      </label>
      <label>학과
        <input class="department" value="${escapeHtml(data.department || "")}" placeholder="예: 간호학과" />
      </label>
      <label>전형유형
        <select class="admissionType">
          ${["","학생부교과","학생부종합","논술","실기/실적","기타"].map(x => `<option ${data.admissionType===x?"selected":""}>${x || "선택"}</option>`).join("")}
        </select>
      </label>
      <label>전형명
        <input class="admissionName" value="${escapeHtml(data.admissionName || "")}" placeholder="예: 지역인재전형" />
      </label>
      <label>지원상태
        <select class="status">
          ${["검토중","담임확인","최종결정","원서접수완료"].map(x => `<option ${data.status===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </label>
      <label>메모 <span class="helper">(선택)</span>
        <input class="memo" value="${escapeHtml(data.memo || "")}" placeholder="예: 면접형, 수능최저 확인" />
      </label>
    </div>
  `;
  div.querySelector(".remove-btn").addEventListener("click", () => {
    if (applicationsEl.children.length <= 1) return toast("지원 항목은 최소 1개가 필요합니다.");
    div.remove(); renumber();
  });
  applicationsEl.appendChild(div);
  renumber();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function renumber() {
  [...applicationsEl.children].forEach((el, i) => el.querySelector(".app-index").textContent = i + 1);
}
function getIdentity() {
  const classNo = $("#classNo").value.trim();
  const studentNo = $("#studentNo").value.trim();
  const studentName = $("#studentName").value.trim();
  if (!classNo || !studentNo || !studentName) throw new Error("반, 번호, 이름을 모두 입력해 주세요.");
  return { classNo, studentNo, studentName, studentKey: studentKey() };
}
function collectApplications() {
  return [...applicationsEl.querySelectorAll(".application-card")].map((el, i) => ({
    priority: i + 1,
    university: el.querySelector(".university").value.trim(),
    department: el.querySelector(".department").value.trim(),
    admissionType: el.querySelector(".admissionType").value.trim(),
    admissionName: el.querySelector(".admissionName").value.trim(),
    status: el.querySelector(".status").value,
    memo: el.querySelector(".memo").value.trim(),
  })).filter(a => a.university || a.department || a.admissionName);
}
function validateApplications(apps) {
  if (!apps.length) throw new Error("지원 대학을 1개 이상 입력해 주세요.");
  for (const a of apps) {
    if (!a.university || !a.department || !a.admissionType || !a.admissionName) {
      throw new Error("각 지원 항목의 대학·학과·전형유형·전형명을 모두 입력해 주세요.");
    }
  }
}

$("#addApplicationBtn").addEventListener("click", () => applicationTemplate());
$("#loadBtn").addEventListener("click", async () => {
  try {
    const id = getIdentity();
    $("#loadStatus").textContent = "본인 확인 중...";
    await verifyPin(id);
    $("#loadStatus").textContent = "지원정보 조회 중...";
    const q = query(collection(db, "applications"), where("studentKey", "==", id.studentKey));
    const snap = await getDocs(q);
    applicationsEl.innerHTML = "";
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>(a.priority||99)-(b.priority||99));
    if (!rows.length) {
      applicationTemplate();
      loadedStudentKey = id.studentKey;
      const locked = await getStudentLock(id.studentKey);
      if (locked) {
        document.querySelectorAll("#applications input, #applications select, #applications button.remove-btn, #addApplicationBtn").forEach(el => el.disabled = true);
        $("#submitBtn").disabled = true;
        $("#loadStatus").textContent = "현재 담임교사가 지원안을 잠근 상태입니다.";
      } else {
        $("#loadStatus").textContent = "기존 정보가 없습니다. 새로 입력하세요.";
      }
      return;
    }
    rows.forEach(applicationTemplate);
    loadedStudentKey = id.studentKey;

    const locked = await getStudentLock(id.studentKey);
    document.querySelectorAll("#applications input, #applications select, #applications button.remove-btn, #addApplicationBtn").forEach(el => {
      el.disabled = locked;
    });
    $("#submitBtn").disabled = locked;

    if (locked) {
      $("#loadStatus").textContent = `${rows.length}건을 불러왔습니다. 현재 담임교사가 지원안을 잠근 상태입니다.`;
      toast("지원안이 잠겨 있어 학생은 수정할 수 없습니다.");
    } else {
      $("#loadStatus").textContent = `${rows.length}건의 기존 지원정보를 불러왔습니다.`;
      toast("기존 지원정보를 불러왔습니다.");
    }
  } catch (e) {
    $("#loadStatus").textContent = "";
    toast(e.message || "조회 중 오류가 발생했습니다.");
  }
});


function comparableApp(a = {}) {
  return {
    priority: Number(a.priority || 0),
    university: String(a.university || "").trim(),
    department: String(a.department || "").trim(),
    admissionType: String(a.admissionType || "").trim(),
    admissionName: String(a.admissionName || "").trim(),
    status: String(a.status || "검토중").trim(),
    memo: String(a.memo || "").trim()
  };
}

function appsAreSame(oldApps, newApps) {
  const a = [...oldApps].map(comparableApp).sort((x,y)=>x.priority-y.priority);
  const b = [...newApps].map(comparableApp).sort((x,y)=>x.priority-y.priority);
  return JSON.stringify(a) === JSON.stringify(b);
}

function makeChangeSummary(oldApps, newApps) {
  const oldByPriority = new Map(oldApps.map(a => [Number(a.priority || 0), comparableApp(a)]));
  const newByPriority = new Map(newApps.map(a => [Number(a.priority || 0), comparableApp(a)]));
  const priorities = [...new Set([...oldByPriority.keys(), ...newByPriority.keys()])].sort((a,b)=>a-b);
  const changes = [];

  for (const priority of priorities) {
    const oldA = oldByPriority.get(priority);
    const newA = newByPriority.get(priority);

    if (!oldA && newA) {
      changes.push({
        type: "추가",
        priority,
        text: `${newA.university} · ${newA.department} · ${newA.admissionName}`
      });
      continue;
    }
    if (oldA && !newA) {
      changes.push({
        type: "삭제",
        priority,
        text: `${oldA.university} · ${oldA.department} · ${oldA.admissionName}`
      });
      continue;
    }

    const fields = [
      ["대학", "university"],
      ["학과", "department"],
      ["전형유형", "admissionType"],
      ["전형명", "admissionName"],
      ["상태", "status"],
      ["메모", "memo"]
    ];

    const details = [];
    for (const [label, key] of fields) {
      if (oldA[key] !== newA[key]) {
        details.push(`${label}: ${oldA[key] || "없음"} → ${newA[key] || "없음"}`);
      }
    }

    if (details.length) {
      changes.push({
        type: "수정",
        priority,
        text: details.join(" / ")
      });
    }
  }
  return changes;
}

$("#submitBtn").addEventListener("click", async () => {
  try {
    const id = getIdentity();
    if (verifiedStudentKey !== id.studentKey) await verifyPin(id);
    const apps = collectApplications();
    validateApplications(apps);
    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "저장 중...";

    const oldQ = query(collection(db, "applications"), where("studentKey", "==", id.studentKey));
    const oldSnap = await getDocs(oldQ);
    const oldApps = oldSnap.docs
      .map(d => ({id:d.id, ...d.data()}))
      .sort((a,b)=>(a.priority||99)-(b.priority||99));

    const batch = writeBatch(db);
    oldSnap.forEach(d => batch.delete(d.ref));

    // 기존 내용과 실제로 달라진 경우에만 수정 이력 저장
    if (oldApps.length && !appsAreSame(oldApps, apps)) {
      const historyRef = doc(collection(db, "applicationHistory"));
      batch.set(historyRef, {
        studentKey: id.studentKey,
        classNo: id.classNo,
        studentNo: id.studentNo,
        studentName: id.studentName,
        changes: makeChangeSummary(oldApps, apps),
        before: oldApps.map(comparableApp),
        after: apps.map(comparableApp),
        changedAt: serverTimestamp(),
        changedByUid: currentUser.uid
      });
    }

    apps.forEach((a, i) => {
      const ref = doc(collection(db, "applications"));
      batch.set(ref, {
        ...id, ...a,
        ownerUid: currentUser.uid,
        accessId: verifiedAccessId,
        normalizedUniversity: normalizeUniversity(a.university),
        normalizedDepartment: normalizeDepartment(a.department),
        normalizedAdmissionName: normalizeAdmission(a.admissionName),
        exactKey: [normalizeUniversity(a.university), normalizeDepartment(a.department), normalizeAdmission(a.admissionName)].join("|"),
        departmentKey: [normalizeUniversity(a.university), normalizeDepartment(a.department)].join("|"),
        universityKey: normalizeUniversity(a.university),
        updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
    loadedStudentKey = id.studentKey;
    toast("지원정보가 저장되었습니다.");
  } catch (e) {
    console.error(e);
    toast(e.message || "저장 중 오류가 발생했습니다.");
  } finally {
    const btn = $("#submitBtn");
    btn.disabled = false; btn.textContent = "지원정보 저장";
  }
});

applicationTemplate();

["#classNo","#studentNo","#studentName","#studentPin"].forEach(sel=>{const el=document.querySelector(sel);["input","change"].forEach(evt=>el?.addEventListener(evt,()=>{verifiedStudentKey=null;verifiedAccessId=null;$("#loadStatus").textContent="";}));});
