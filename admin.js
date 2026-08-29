import {
  initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js"; import {   getFirestore, collection, onSnapshot, writeBatch, doc, getDocs, serverTimestamp, query, where, updateDoc, addDoc, setDoc, getDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { PIN_ADMIN_EMAIL } from "./admin-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

function isPinAdmin(user = auth.currentUser) {
  return !!user && String(user.email || "").toLowerCase() === String(PIN_ADMIN_EMAIL || "").toLowerCase();
}

function updatePinAdminUI(user = auth.currentUser) {
  const allowed = isPinAdmin(user);
  const genBtn = document.querySelector("#generatePinsBtn");
  const exportBtn = document.querySelector("#exportPinsBtn");
  const note = document.querySelector("#pinAdminOnlyNote");

  if (genBtn) genBtn.classList.toggle("hidden", !allowed);
  if (exportBtn) exportBtn.classList.toggle("hidden", !allowed);
  if (note) {
    note.classList.toggle("hidden", allowed);
    if (!allowed) note.textContent = "PIN 생성·재발급 및 PIN 목록 다운로드는 최고관리자만 사용할 수 있습니다.";
  }
}
const $ = (s) => document.querySelector(s);
const toastEl = $("#toast");
let rows = [];
let roster = [];
let unsubscribe = null;
let unsubscribeRoster = null;
let unsubscribeLocks = null;
let currentStudentModalKey = null;
let lockMap = new Map();
let duplicateReviewMap = new Map();
let unsubscribeDuplicateReviews = null;
let teacherClassMap = new Map();
let unsubscribeTeacherClasses = null;
let myAssignedClass = "";
let showingMyClassOnly = false;
let deleteTargetStudent = null;

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
function stableHash(text = "") {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function duplicateReviewId(type, key) {
  return `${type}_${stableHash(key)}`;
}
function getDuplicateReview(type, key) {
  return duplicateReviewMap.get(duplicateReviewId(type, key)) || {
    status: "미검토",
    memo: ""
  };
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
function makeStudentKey(classNo, studentNo, studentName) {
  const c = String(classNo ?? "").trim();
  const n = String(studentNo ?? "").trim().padStart(2, "0");
  const name = String(studentName ?? "").trim();
  return `${c}-${n}-${normalize(name)}`;
}
async function sha256(text){const bytes=new TextEncoder().encode(text);const digest=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");}
function generatePin(){const arr=new Uint32Array(1);crypto.getRandomValues(arr);return String(10000000+(arr[0]%90000000));}
async function accessIdFor(studentKeyValue,pin){return sha256(`2027-susi-support|${studentKeyValue}|${pin}`);}
function findHeaderKey(obj, candidates) {
  const keys = Object.keys(obj || {});
  return keys.find(k => candidates.includes(normalize(k))) || null;
}
function parseRosterRows(rawRows) {
  const cleaned = [];
  for (const row of rawRows) {
    const classKey = findHeaderKey(row, ["반","학급","class","classno"]);
    const noKey = findHeaderKey(row, ["번호","번","학번","number","studentno"]);
    const nameKey = findHeaderKey(row, ["이름","성명","학생명","name","studentname"]);
    if (!classKey || !noKey || !nameKey) continue;

    const classNoRaw = String(row[classKey] ?? "").trim();
    const studentNoRaw = String(row[noKey] ?? "").trim();
    const studentName = String(row[nameKey] ?? "").trim();

    const classMatch = classNoRaw.match(/[1-9]/);
    const noMatch = studentNoRaw.match(/\d+/);
    if (!classMatch || !noMatch || !studentName) continue;

    const classNo = classMatch[0];
    const studentNo = String(Number(noMatch[0]));
    if (!["1","2","3","4","5","6","7","8","9"].includes(classNo)) continue;

    cleaned.push({
      classNo,
      studentNo,
      studentName,
      studentKey: makeStudentKey(classNo, studentNo, studentName)
    });
  }

  const unique = new Map();
  cleaned.forEach(r => unique.set(r.studentKey, r));
  return [...unique.values()].sort((a,b) =>
    Number(a.classNo)-Number(b.classNo) ||
    Number(a.studentNo)-Number(b.studentNo) ||
    a.studentName.localeCompare(b.studentName, "ko")
  );
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
function normalizeEmail(v = "") {
  return String(v || "").trim().toLowerCase();
}

function getAssignedClassForEmail(email = "") {
  const key = normalizeEmail(email);
  return teacherClassMap.get(key)?.classNo || "";
}

function updateMyClassUI() {
  const user = auth.currentUser;
  const email = normalizeEmail(user?.email || "");
  myAssignedClass = getAssignedClassForEmail(email);

  $("#myClassAccount").textContent = email || "";
  $("#myClassLabel").textContent = myAssignedClass
    ? `${myAssignedClass}반 담임`
    : "담당반 미지정";

  $("#showMyClassBtn").disabled = !myAssignedClass;
  $("#teacherClassManageBtn").classList.toggle("hidden", !isPinAdmin(user));

  if (showingMyClassOnly && myAssignedClass) {
    $("#filterClass").value = myAssignedClass;
  }
}

function applyMyClassView() {
  if (!myAssignedClass) {
    toast("현재 계정의 담당반이 지정되어 있지 않습니다.");
    return;
  }
  showingMyClassOnly = true;
  $("#filterClass").value = myAssignedClass;
  renderTable();
  renderClassStatus();
  renderAnalytics();
  toast(`${myAssignedClass}반 중심 화면으로 전환했습니다.`);
}

function applyAllClassView() {
  showingMyClassOnly = false;
  $("#filterClass").value = "";
  renderTable();
  renderClassStatus();
  renderAnalytics();
  toast("전체 학년 화면으로 전환했습니다.");
}

function buildTeacherClassList() {
  const host = $("#teacherClassList");
  const standardEmails = Array.from({length:9}, (_,i) => `teacher${i+1}@gangil.kr`);

  host.innerHTML = standardEmails.map(email => {
    const assigned = getAssignedClassForEmail(email);
    return `
      <div class="teacher-class-row">
        <div>
          <strong>${escapeHtml(email)}</strong>
          ${normalizeEmail(PIN_ADMIN_EMAIL) === normalizeEmail(email) ? `<span class="admin-chip">최고관리자</span>` : ""}
        </div>
        <select class="teacher-class-select" data-email="${escapeHtml(email)}">
          <option value="">미지정</option>
          ${Array.from({length:9},(_,i)=>String(i+1)).map(c =>
            `<option value="${c}" ${assigned === c ? "selected" : ""}>${c}반</option>`
          ).join("")}
        </select>
      </div>
    `;
  }).join("");
}

function openTeacherClassModal() {
  if (!isPinAdmin()) return toast("최고관리자만 담당반을 설정할 수 있습니다.");
  buildTeacherClassList();
  $("#teacherClassModal").classList.remove("hidden");
  $("#teacherClassModal").setAttribute("aria-hidden", "false");
}

function closeTeacherClassModal() {
  $("#teacherClassModal").classList.add("hidden");
  $("#teacherClassModal").setAttribute("aria-hidden", "true");
}

function filteredRows() {
  const c = $("#filterClass").value;
  const type = $("#filterType").value;
  const status = $("#filterStatus").value;
  const result = $("#filterResult").value;
  const q = $("#searchInput").value.trim().toLowerCase();
  const mode = $("#viewMode").value;
  const exact = duplicatesSet("exactKey");
  const dept = duplicatesSet("departmentKey");
  const uni = duplicatesSet("universityKey");

  return rows.filter(r => {
    if (c && r.classNo !== c) return false;
    if (type && r.admissionType !== type) return false;
    if (status && (r.status || "검토중") !== status) return false;
    const resultValue = r.resultStatus || "미입력";
    if (result && resultValue !== result) return false;
    if (q && ![r.studentName,r.university,r.department,r.admissionType,r.admissionName,r.status,r.resultStatus,r.waitlistNo].join(" ").toLowerCase().includes(q)) return false;
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

  const exactGroups = groupBy("exactKey").map(([key]) => ["exact", key]);
  const deptGroups = groupBy("departmentKey").map(([key]) => ["department", key]);
  const unresolved = [...exactGroups, ...deptGroups].filter(([type, key]) => {
    const status = getDuplicateReview(type, key).status || "미검토";
    return status === "미검토" || status === "협의중";
  }).length;
  $("#unresolvedDupCount").textContent = unresolved;
}
function renderResultSummary() {
  const count = (result) => rows.filter(r => (r.resultStatus || "미입력") === result).length;
  $("#resultAllCount").textContent = rows.length;
  $("#resultFirstCount").textContent = count("최초합격");
  $("#resultWaitCount").textContent = count("예비");
  $("#resultExtraCount").textContent = count("추가합격");
  $("#resultFailCount").textContent = count("불합격");
  $("#resultRegisteredCount").textContent = count("최종등록");

  document.querySelectorAll(".result-summary-card").forEach(btn => {
    btn.classList.toggle("active", $("#filterResult").value === btn.dataset.result);
  });
}

function renderStatusSummary() {
  const count = (status) => rows.filter(r => (r.status || "검토중") === status).length;
  $("#statusAllCount").textContent = rows.length;
  $("#statusReviewCount").textContent = count("검토중");
  $("#statusTeacherCount").textContent = count("담임확인");
  $("#statusFinalCount").textContent = count("최종결정");
  $("#statusSubmittedCount").textContent = count("원서접수완료");

  document.querySelectorAll(".status-summary-card").forEach(btn => {
    btn.classList.toggle("active", $("#filterStatus").value === btn.dataset.status);
  });
}
function getEnteredStudentKeys() {
  return new Set(rows.map(r => r.studentKey));
}
function getMissingForClass(classNo = "") {
  const entered = getEnteredStudentKeys();
  return roster.filter(r => (!classNo || r.classNo === classNo) && !entered.has(r.studentKey));
}
function showMissing(classNo = "") {
  const list = getMissingForClass(classNo);
  $("#missingTitle").textContent = classNo ? `${classNo}반 미입력 학생` : "전체 미입력 학생";
  $("#missingSection").classList.remove("hidden");
  $("#missingList").innerHTML = list.length
    ? list.map(r => `<span class="missing-chip">${escapeHtml(r.classNo)}반 ${escapeHtml(r.studentNo)}번 ${escapeHtml(r.studentName)}</span>`).join("")
    : `<div class="empty">미입력 학생이 없습니다.</div>`;
  $("#missingSection").scrollIntoView({behavior:"smooth", block:"center"});
}
function renderClassStatus() {
  const host = $("#classStatusGrid");
  const entered = getEnteredStudentKeys();

  host.innerHTML = Array.from({length:9}, (_,i)=>String(i+1)).map(classNo => {
    const all = roster.filter(r => r.classNo === classNo);
    const enteredCount = all.filter(r => entered.has(r.studentKey)).length;
    const missingCount = Math.max(0, all.length - enteredCount);

    if (!all.length) {
      const fallbackEntered = new Set(rows.filter(r=>r.classNo===classNo).map(r=>r.studentKey)).size;
      return `<button type="button" class="class-status-item" data-class="${classNo}">
        <span class="class-label">${classNo}반</span>
        <strong>${fallbackEntered}</strong>
        <small>명 입력 · 명단 미등록</small>
      </button>`;
    }

    return `<button type="button" class="class-status-item ${missingCount ? "has-missing" : "complete"}" data-class="${classNo}">
      <span class="class-label">${classNo}반</span>
      <strong>${enteredCount}/${all.length}</strong>
      <small>${missingCount ? `미입력 ${missingCount}명` : "입력 완료"}</small>
    </button>`;
  }).join("");

  host.querySelectorAll(".class-status-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const classNo = btn.dataset.class;
      if (roster.some(r=>r.classNo===classNo)) {
        showMissing(classNo);
      } else {
        $("#filterClass").value = classNo;
        renderTable();
        document.querySelector(".filters").scrollIntoView({behavior:"smooth", block:"center"});
      }
    });
  });
}

function duplicateReviewControls(type, key) {
  const review = getDuplicateReview(type, key);
  const id = duplicateReviewId(type, key);
  return `
    <div class="dup-review">
      <div class="dup-review-row">
        <label>협의상태
          <select class="dup-review-status" data-review-id="${id}" data-type="${type}" data-key="${escapeHtml(key)}">
            ${["미검토","협의중","조정완료","중복허용"].map(s =>
              `<option value="${s}" ${review.status === s ? "selected" : ""}>${s}</option>`
            ).join("")}
          </select>
        </label>
        <label class="dup-review-memo-label">교사 메모
          <input class="dup-review-memo" data-review-id="${id}" value="${escapeHtml(review.memo || "")}" placeholder="예: 3반·5반 담임 협의 예정" />
        </label>
        <button type="button" class="secondary dup-review-save"
          data-review-id="${id}" data-type="${type}" data-key="${escapeHtml(key)}">저장</button>
      </div>
      ${review.updatedByEmail ? `<div class="dup-review-updated">최근 저장: ${escapeHtml(review.updatedByEmail)}</div>` : ""}
    </div>
  `;
}

async function saveDuplicateReview(button) {
  const id = button.dataset.reviewId;
  const type = button.dataset.type;
  const key = button.dataset.key;
  const card = button.closest(".dup-card");
  const status = card.querySelector(".dup-review-status").value;
  const memo = card.querySelector(".dup-review-memo").value.trim();

  button.disabled = true;
  button.textContent = "저장 중...";

  try {
    await setDoc(doc(db, "duplicateReviews", id), {
      groupType: type,
      groupKey: key,
      status,
      memo,
      updatedAt: serverTimestamp(),
      updatedByUid: auth.currentUser?.uid || "",
      updatedByEmail: auth.currentUser?.email || ""
    }, {merge:true});
    toast("중복지원 협의상태를 저장했습니다.");
  } catch (e) {
    console.error(e);
    toast("협의상태 저장에 실패했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = "저장";
  }
}

function renderDuplicates() {
  const host = $("#duplicateGroups");
  const reviewFilter = $("#filterDuplicateReview")?.value || "";

  const exactGroups = groupBy("exactKey")
    .sort((a,b)=>b[1].length-a[1].length);

  const deptGroups = groupBy("departmentKey")
    .filter(([k]) => {
      const related = rows.filter(r=>r.departmentKey===k);
      return new Set(related.map(r=>r.exactKey)).size > 1;
    })
    .sort((a,b)=>b[1].length-a[1].length);

  const cards = [];

  exactGroups.forEach(([key,g]) => {
    const review = getDuplicateReview("exact", key);
    if (reviewFilter && review.status !== reviewFilter) return;

    const first = g[0];
    const people = [...new Map(g.map(x=>[x.studentKey,x])).values()];
    cards.push(`
      <div class="dup-card exact ${review.status === "조정완료" || review.status === "중복허용" ? "resolved" : ""}">
        <div class="dup-card-top">
          <div>
            <div class="dup-tag">🔴 완전 중복 · ${people.length}명</div>
            <div class="dup-title">${escapeHtml(first.university)} · ${escapeHtml(first.department)}</div>
            <div class="dup-sub">${escapeHtml(first.admissionName)} / ${escapeHtml(first.admissionType)}</div>
          </div>
          <span class="dup-review-badge status-${review.status}">${escapeHtml(review.status)}</span>
        </div>
        <div class="dup-people">${people.map(x=>`<span class="person-chip">${escapeHtml(x.classNo)}반 ${escapeHtml(x.studentName)}</span>`).join("")}</div>
        ${duplicateReviewControls("exact", key)}
      </div>`);
  });

  deptGroups.forEach(([key,g]) => {
    const review = getDuplicateReview("department", key);
    if (reviewFilter && review.status !== reviewFilter) return;

    const first = g[0];
    const people = [...new Map(g.map(x=>[x.studentKey,x])).values()];
    cards.push(`
      <div class="dup-card department ${review.status === "조정완료" || review.status === "중복허용" ? "resolved" : ""}">
        <div class="dup-card-top">
          <div>
            <div class="dup-tag">🟠 동일 대학·학과 · ${people.length}명</div>
            <div class="dup-title">${escapeHtml(first.university)} · ${escapeHtml(first.department)}</div>
            <div class="dup-sub">전형이 서로 다르므로 확인이 필요합니다.</div>
          </div>
          <span class="dup-review-badge status-${review.status}">${escapeHtml(review.status)}</span>
        </div>
        <div class="dup-people">${people.map(x=>`<span class="person-chip">${escapeHtml(x.classNo)}반 ${escapeHtml(x.studentName)} · ${escapeHtml(x.admissionName)}</span>`).join("")}</div>
        ${duplicateReviewControls("department", key)}
      </div>`);
  });

  host.innerHTML = cards.length
    ? cards.join("")
    : `<div class="empty">${reviewFilter ? `'${escapeHtml(reviewFilter)}' 상태의 중복지원 그룹이 없습니다.` : "현재 탐지된 중복지원 그룹이 없습니다."}</div>`;

  host.querySelectorAll(".dup-review-save").forEach(btn => {
    btn.addEventListener("click", () => saveDuplicateReview(btn));
  });
}


function getStudentApplications(studentKey) {
  return rows
    .filter(r => r.studentKey === studentKey)
    .sort((a,b)=>(a.priority||99)-(b.priority||99));
}

function isStudentLocked(studentKey) {
  return lockMap.get(studentKey)?.locked === true;
}

async function toggleStudentLock(studentKey) {
  if (!studentKey) return;
  const currentlyLocked = isStudentLocked(studentKey);

  try {
    await setDoc(doc(db, "studentLocks", studentKey), {
      locked: !currentlyLocked,
      updatedAt: serverTimestamp(),
      updatedByUid: auth.currentUser?.uid || ""
    }, {merge:true});

    toast(currentlyLocked
      ? "학생 지원안 잠금을 해제했습니다."
      : "학생 지원안을 잠갔습니다.");
  } catch (e) {
    console.error(e);
    toast("잠금 상태 변경에 실패했습니다.");
  }
}

function findRosterStudent(studentKey) {
  return roster.find(r => r.studentKey === studentKey) || null;
}

function openDeleteStudentModal(studentKey) {
  if (!isPinAdmin()) return toast("최고관리자만 학생 데이터를 삭제할 수 있습니다.");

  const apps = getStudentApplications(studentKey);
  const rosterStudent = findRosterStudent(studentKey);
  const first = apps[0] || rosterStudent;
  if (!first) return toast("학생 정보를 찾을 수 없습니다.");

  deleteTargetStudent = {
    studentKey,
    classNo: first.classNo || "",
    studentNo: first.studentNo || "",
    studentName: first.studentName || "",
    rosterId: rosterStudent?.id || null,
    accessId: rosterStudent?.accessId || null
  };

  $("#deleteStudentNameLabel").textContent =
    `${deleteTargetStudent.classNo}반 ${deleteTargetStudent.studentNo}번 ${deleteTargetStudent.studentName}`;
  $("#deleteStudentConfirmName").value = "";
  $("#deleteStudentError").textContent = "";
  $("#deleteStudentModal").classList.remove("hidden");
  $("#deleteStudentModal").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#deleteStudentConfirmName").focus(), 50);
}

function closeDeleteStudentModal() {
  deleteTargetStudent = null;
  $("#deleteStudentModal").classList.add("hidden");
  $("#deleteStudentModal").setAttribute("aria-hidden", "true");
  $("#deleteStudentConfirmName").value = "";
  $("#deleteStudentError").textContent = "";
}

async function performCompleteStudentDelete() {
  if (!isPinAdmin()) throw new Error("삭제 권한이 없습니다.");
  if (!deleteTargetStudent) throw new Error("삭제할 학생을 찾을 수 없습니다.");

  const target = deleteTargetStudent;
  const typedName = $("#deleteStudentConfirmName").value.trim();
  if (typedName !== target.studentName) {
    throw new Error("학생 이름이 일치하지 않습니다.");
  }

  const [appSnap, histSnap, sessSnap] = await Promise.all([
    getDocs(query(collection(db, "applications"), where("studentKey", "==", target.studentKey))),
    getDocs(query(collection(db, "applicationHistory"), where("studentKey", "==", target.studentKey))),
    getDocs(query(collection(db, "studentSessions"), where("studentKey", "==", target.studentKey)))
  ]);

  let studentRefs = [];
  if (target.rosterId) {
    studentRefs = [doc(db, "students", target.rosterId)];
  } else {
    const studentSnap = await getDocs(
      query(collection(db, "students"), where("studentKey", "==", target.studentKey))
    );
    studentRefs = studentSnap.docs.map(d => d.ref);
  }

  const refs = [
    ...appSnap.docs.map(d => d.ref),
    ...histSnap.docs.map(d => d.ref),
    ...sessSnap.docs.map(d => d.ref),
    ...studentRefs
  ];

  if (target.accessId) refs.push(doc(db, "studentAccess", target.accessId));
  if (lockMap.has(target.studentKey)) refs.push(doc(db, "studentLocks", target.studentKey));

  const batch = writeBatch(db);
  refs.forEach(ref => batch.delete(ref));
  await batch.commit();
}

function openStudentModal(studentKey) {
  currentStudentModalKey = studentKey;

  const deleteBtn = $("#deleteStudentBtn");
  if (deleteBtn) deleteBtn.classList.toggle("hidden", !isPinAdmin());

  $("#historyPanel").classList.add("hidden");
  $("#historyList").innerHTML = "";

  const apps = getStudentApplications(studentKey);
  if (!apps.length) return toast("해당 학생의 지원정보가 없습니다.");

  const first = apps[0];
  $("#studentModalTitle").textContent =
    `${first.classNo}반 ${first.studentNo}번 ${first.studentName}`;
  $("#studentModalSub").textContent = `등록된 지원정보 ${apps.length}건`;

  const locked = isStudentLocked(studentKey);
  $("#lockBtn").textContent = locked ? "잠금 해제" : "지원안 잠금";
  $("#lockBtn").classList.toggle("danger-outline", locked);
  $("#studentLockInfo").innerHTML = locked
    ? `<span class="lock-badge locked">🔒 학생 수정 잠금 상태</span>`
    : `<span class="lock-badge">🔓 학생 수정 가능</span>`;

  const submittedCount =
    apps.filter(a => (a.status || "검토중") === "원서접수완료").length;
  const allSubmitted = submittedCount === apps.length;
  const progressPercent =
    apps.length ? Math.round((submittedCount / apps.length) * 100) : 0;

  $("#studentProgress").innerHTML = `
    <div class="progress-summary ${allSubmitted ? "complete" : ""}">
      <div class="progress-summary-top">
        <span>${allSubmitted ? "✅ 전체 접수 완료" : "원서접수 진행률"}</span>
        <strong>${submittedCount}/${apps.length}</strong>
      </div>
      <div class="progress-track"><span style="width:${progressPercent}%"></span></div>
      <small>${progressPercent}% 완료</small>
    </div>
  `;

  $("#studentApplications").innerHTML = apps.map((a, index) => `
    <article class="student-app-card">
      <div class="student-app-number">${escapeHtml(a.priority || index + 1)}</div>
      <div class="student-app-main">
        <div class="student-app-university">${escapeHtml(a.university)}</div>
        <div class="student-app-department">${escapeHtml(a.department)}</div>

        <div class="student-app-meta">
          <span>${escapeHtml(a.admissionType)}</span>
          <span>${escapeHtml(a.admissionName)}</span>
          <span class="status-pill ${statusClass(a.status)}">${escapeHtml(a.status || "검토중")}</span>
        </div>

        <div class="student-app-actions">
          <label>교사 상태 변경
            <select class="teacher-status-select"
                    data-id="${escapeHtml(a.id)}"
                    data-student-key="${escapeHtml(a.studentKey)}">
              ${["검토중","담임확인","최종결정","원서접수완료"].map(v =>
                `<option value="${v}" ${(a.status || "검토중") === v ? "selected" : ""}>${v}</option>`
              ).join("")}
            </select>
          </label>

          <label>합격결과
            <select class="teacher-result-select"
                    data-id="${escapeHtml(a.id)}"
                    data-student-key="${escapeHtml(a.studentKey)}"
                    data-old-result="${escapeHtml(a.resultStatus || "미입력")}">
              ${["미입력","1단계 합격","면접대상","최초합격","예비","추가합격","불합격","최종등록"].map(v =>
                `<option value="${v}" ${(a.resultStatus || "미입력") === v ? "selected" : ""}>${v}</option>`
              ).join("")}
            </select>
          </label>

          <label>예비번호
            <input class="teacher-waitlist-input"
                   data-id="${escapeHtml(a.id)}"
                   value="${escapeHtml(a.waitlistNo || "")}"
                   placeholder="예: 14"
                   ${a.resultStatus === "예비" ? "" : "disabled"} />
          </label>
        </div>

        ${a.memo ? `<div class="student-app-memo">메모 · ${escapeHtml(a.memo)}</div>` : ""}
      </div>
    </article>
  `).join("");

  $("#studentApplications").querySelectorAll(".teacher-status-select").forEach(select => {
    select.addEventListener("change", async () => {
      const oldStatus =
        getStudentApplications(studentKey)
          .find(x => x.id === select.dataset.id)?.status || "검토중";
      const newStatus = select.value;
      if (oldStatus === newStatus) return;

      const ok = await changeApplicationStatus(
        select.dataset.id,
        select.dataset.studentKey,
        oldStatus,
        newStatus,
        select
      );

      if (ok) {
        setTimeout(() => {
          if (currentStudentModalKey === studentKey) openStudentModal(studentKey);
        }, 150);
      } else {
        select.value = oldStatus;
      }
    });
  });

  $("#studentApplications").querySelectorAll(".teacher-result-select").forEach(select => {
    select.addEventListener("change", async () => {
      const oldResult = select.dataset.oldResult || "미입력";
      const newResult = select.value;
      const card = select.closest(".student-app-card");
      const waitInput = card.querySelector(".teacher-waitlist-input");

      if (newResult === "예비") {
        waitInput.disabled = false;
        waitInput.focus();
      } else {
        waitInput.value = "";
        waitInput.disabled = true;
      }

      const ok = await changeApplicationResult(
        select.dataset.id,
        select.dataset.studentKey,
        oldResult,
        newResult,
        waitInput.value,
        select
      );

      if (ok) {
        select.dataset.oldResult = newResult;
        setTimeout(() => {
          if (currentStudentModalKey === studentKey) openStudentModal(studentKey);
        }, 150);
      } else {
        select.value = oldResult;
      }
    });
  });

  $("#studentApplications").querySelectorAll(".teacher-waitlist-input").forEach(input => {
    input.addEventListener("change", async () => {
      const card = input.closest(".student-app-card");
      const select = card.querySelector(".teacher-result-select");
      if (select.value !== "예비") return;

      await changeApplicationResult(
        input.dataset.id,
        select.dataset.studentKey,
        "예비",
        "예비",
        input.value,
        input
      );
    });
  });

  $("#studentModal").classList.remove("hidden");
  $("#studentModal").setAttribute("aria-hidden", "false");
}

function closeStudentModal() {
  currentStudentModalKey = null;
  $("#historyPanel").classList.add("hidden");
  $("#historyList").innerHTML = "";
  $("#studentModal").classList.add("hidden");
  $("#studentModal").setAttribute("aria-hidden", "true");
  $("#studentApplications").innerHTML = "";
}

async function loadStudentHistory(studentKey) {
  if (!studentKey) return;
  const host = $("#historyList");
  host.innerHTML = `<div class="empty">수정 이력을 불러오는 중입니다.</div>`;

  try {
    const snap = await getDocs(
      query(collection(db, "applicationHistory"), where("studentKey", "==", studentKey))
    );

    const list = snap.docs.map(d => ({id:d.id, ...d.data()}))
      .sort((a,b) => {
        const at = a.changedAt?.toMillis?.() || 0;
        const bt = b.changedAt?.toMillis?.() || 0;
        return bt - at;
      });

    if (!list.length) {
      host.innerHTML = `<div class="empty">아직 기록된 수정 이력이 없습니다.</div>`;
      return;
    }

    host.innerHTML = list.map(item => {
      const date = item.changedAt?.toDate?.();
      const dateText = date
        ? date.toLocaleString("ko-KR", {
            year:"numeric", month:"2-digit", day:"2-digit",
            hour:"2-digit", minute:"2-digit"
          })
        : "시간 정보 없음";

      const changes = Array.isArray(item.changes) ? item.changes : [];

      return `<article class="history-item">
        <div class="history-date">${escapeHtml(dateText)}</div>
        <div class="history-changes">
          ${changes.length ? changes.map(c => `
            <div class="history-change">
              <span class="history-type ${c.type === "삭제" ? "delete" : c.type === "추가" ? "add" : "edit"}">${escapeHtml(c.type)}</span>
              <div>
                <strong>지원 ${escapeHtml(c.priority)}</strong>
                <p>${escapeHtml(c.text)}</p>
              </div>
            </div>
          `).join("") : `<span class="helper">변경 상세정보가 없습니다.</span>`}
        </div>
      </article>`;
    }).join("");
  } catch (e) {
    console.error(e);
    host.innerHTML =
      `<div class="empty">수정 이력을 불러오지 못했습니다. Firestore 규칙을 확인해 주세요.</div>`;
  }
}

async function changeApplicationResult(
  applicationId, studentKey, oldResult, newResult, waitlistNo = "", controlEl = null
) {
  if (!applicationId || !studentKey) return false;
  if (controlEl) controlEl.disabled = true;

  try {
    const application = rows.find(r => r.id === applicationId);
    if (!application) throw new Error("지원정보를 찾을 수 없습니다.");

    const payload = {
      resultStatus: newResult,
      updatedAt: serverTimestamp(),
      waitlistNo: newResult === "예비" ? String(waitlistNo || "").trim() : ""
    };

    await updateDoc(doc(db, "applications", applicationId), payload);

    await addDoc(collection(db, "applicationHistory"), {
      studentKey,
      classNo: application.classNo,
      studentNo: application.studentNo,
      studentName: application.studentName,
      changes: [{
        type: "수정",
        priority: application.priority || 0,
        text: `합격결과: ${oldResult || "미입력"} → ${newResult}${
          newResult === "예비" && payload.waitlistNo
            ? ` / 예비 ${payload.waitlistNo}번`
            : ""
        }`
      }],
      before: [],
      after: [],
      changedAt: serverTimestamp(),
      changedByUid: auth.currentUser?.uid || "",
      changedByTeacher: true
    });

    toast(`합격결과를 '${newResult}'로 변경했습니다.`);
    return true;
  } catch (e) {
    console.error(e);
    toast("합격결과 변경에 실패했습니다.");
    return false;
  } finally {
    if (controlEl) controlEl.disabled = false;
  }
}

async function changeApplicationStatus(
  applicationId, studentKey, oldStatus, newStatus, selectEl = null
) {
  if (!applicationId || !studentKey) return false;
  if (selectEl) selectEl.disabled = true;

  try {
    const application = rows.find(r => r.id === applicationId);
    if (!application) throw new Error("지원정보를 찾을 수 없습니다.");

    await updateDoc(doc(db, "applications", applicationId), {
      status: newStatus,
      updatedAt: serverTimestamp()
    });

    await addDoc(collection(db, "applicationHistory"), {
      studentKey,
      classNo: application.classNo,
      studentNo: application.studentNo,
      studentName: application.studentName,
      changes: [{
        type: "수정",
        priority: application.priority || 0,
        text: `상태: ${oldStatus} → ${newStatus}`
      }],
      before: [],
      after: [],
      changedAt: serverTimestamp(),
      changedByUid: auth.currentUser?.uid || "",
      changedByTeacher: true
    });

    toast(`지원상태를 '${newStatus}'로 변경했습니다.`);
    return true;
  } catch (e) {
    console.error(e);
    toast("지원상태 변경에 실패했습니다.");
    return false;
  } finally {
    if (selectEl) selectEl.disabled = false;
  }
}

function renderTable() {
  const data = filteredRows();
  $("#visibleCount").textContent = `${data.length}건 표시`;
  $("#applicationTable").innerHTML = data.length ? data.map(r => `
    <tr>
      <td class="student-cell">
        <button type="button" class="student-name-button" data-student-key="${escapeHtml(r.studentKey)}">
          <span>${escapeHtml(r.classNo)}반 ${escapeHtml(r.studentNo)}번</span>
          <strong>${escapeHtml(r.studentName)}</strong>
        </button>
      </td>
      <td>${escapeHtml(r.university)}</td>
      <td>${escapeHtml(r.department)}</td>
      <td>${escapeHtml(r.admissionType)}</td>
      <td>${escapeHtml(r.admissionName)}</td>
      <td>
        <select class="table-status-select" data-id="${escapeHtml(r.id)}" data-student-key="${escapeHtml(r.studentKey)}" data-old-status="${escapeHtml(r.status || "검토중")}">
          ${["검토중","담임확인","최종결정","원서접수완료"].map(s =>
            `<option value="${s}" ${(r.status || "검토중") === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td>
        <select class="table-result-select" data-id="${escapeHtml(r.id)}" data-student-key="${escapeHtml(r.studentKey)}" data-old-result="${escapeHtml(r.resultStatus || "미입력")}">
          ${["미입력","1단계 합격","면접대상","최초합격","예비","추가합격","불합격","최종등록"].map(s =>
            `<option value="${s}" ${(r.resultStatus || "미입력") === s ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td>
        <input class="table-waitlist-input" data-id="${escapeHtml(r.id)}" value="${escapeHtml(r.waitlistNo || "")}" placeholder="예: 14" ${r.resultStatus === "예비" ? "" : "disabled"} />
      </td>
    </tr>`).join("") : `<tr><td colspan="8"><div class="empty">조건에 맞는 지원정보가 없습니다.</div></td></tr>`;

  $("#applicationTable").querySelectorAll(".table-status-select").forEach(select => {
    select.addEventListener("change", async () => {
      const oldStatus = select.dataset.oldStatus || "검토중";
      const newStatus = select.value;
      if (oldStatus === newStatus) return;

      const ok = await changeApplicationStatus(
        select.dataset.id,
        select.dataset.studentKey,
        oldStatus,
        newStatus,
        select
      );

      if (ok) select.dataset.oldStatus = newStatus;
      else select.value = oldStatus;
    });
  });

  $("#applicationTable").querySelectorAll(".table-result-select").forEach(select => {
    select.addEventListener("change", async () => {
      const oldResult = select.dataset.oldResult || "미입력";
      const newResult = select.value;
      const row = select.closest("tr");
      const waitInput = row.querySelector(".table-waitlist-input");

      if (newResult === "예비") {
        waitInput.disabled = false;
      } else {
        waitInput.value = "";
        waitInput.disabled = true;
      }

      if (oldResult === newResult) return;

      const ok = await changeApplicationResult(
        select.dataset.id,
        select.dataset.studentKey,
        oldResult,
        newResult,
        waitInput.value,
        select
      );

      if (ok) select.dataset.oldResult = newResult;
      else select.value = oldResult;
    });
  });

  $("#applicationTable").querySelectorAll(".table-waitlist-input").forEach(input => {
    input.addEventListener("change", async () => {
      const row = input.closest("tr");
      const select = row.querySelector(".table-result-select");
      if (select.value !== "예비") return;

      await changeApplicationResult(
        input.dataset.id,
        select.dataset.studentKey,
        "예비",
        "예비",
        input.value,
        input
      );
    });
  });
}

function countBy(data, keyFn) {
  const map = new Map();
  data.forEach(item => {
    const key = String(keyFn(item) || "").trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return [...map.entries()].sort((a,b) =>
    b[1].length - a[1].length ||
    a[0].localeCompare(b[0], "ko")
  );
}

function analyticsSourceRows() {
  const classNo = $("#filterClass").value;
  const type = $("#filterType").value;
  const status = $("#filterStatus").value;
  const result = $("#filterResult").value;
  const q = $("#searchInput").value.trim().toLowerCase();

  return rows.filter(r => {
    if (classNo && r.classNo !== classNo) return false;
    if (type && r.admissionType !== type) return false;
    if (status && (r.status || "검토중") !== status) return false;
    if (result && (r.resultStatus || "미입력") !== result) return false;
    if (q && ![
      r.studentName,r.university,r.department,r.admissionType,
      r.admissionName,r.status,r.resultStatus,r.waitlistNo
    ].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
}

function analyticsBar(label, count, maxCount, type, value) {
  const pct = maxCount ? Math.max(5, Math.round((count / maxCount) * 100)) : 0;
  return `
    <button type="button" class="analytics-row"
      data-analytics-type="${type}"
      data-analytics-value="${escapeHtml(value)}">
      <div class="analytics-row-top">
        <span>${escapeHtml(label)}</span>
        <strong>${count}건</strong>
      </div>
      <div class="analytics-bar-track"><span style="width:${pct}%"></span></div>
    </button>
  `;
}

function renderAnalytics() {
  const data = analyticsSourceRows();

  const universities = countBy(data, r => r.university);
  const departments = countBy(data, r => r.department);
  const admissionTypes = countBy(data, r => r.admissionType);
  const classes = countBy(data, r => r.classNo);

  $("#universityStatCount").textContent = `${universities.length}개 대학`;
  $("#departmentStatCount").textContent = `${departments.length}개 학과`;

  const renderGroup = (selector, groups, type, labelFn, limit = null) => {
    const host = $(selector);
    const selected = limit ? groups.slice(0, limit) : groups;
    const maxCount = selected[0]?.[1]?.length || 0;

    host.innerHTML = selected.length
      ? selected.map(([key, list]) =>
          analyticsBar(labelFn(key), list.length, maxCount, type, key)
        ).join("")
      : `<div class="empty">집계할 지원정보가 없습니다.</div>`;
  };

  renderGroup("#universityStats", universities, "university", x => x, 10);
  renderGroup("#departmentStats", departments, "department", x => x, 10);
  renderGroup("#admissionTypeStats", admissionTypes, "admissionType", x => x);
  renderGroup("#classApplicationStats", classes, "classNo", x => `${x}반`);

  document.querySelectorAll(".analytics-row").forEach(btn => {
    btn.addEventListener("click", () => {
      openAnalyticsDetail(
        btn.dataset.analyticsType,
        btn.dataset.analyticsValue
      );
    });
  });
}

function analyticsDetailRows(type, value) {
  return analyticsSourceRows()
    .filter(r => {
      if (type === "university") return r.university === value;
      if (type === "department") return r.department === value;
      if (type === "admissionType") return r.admissionType === value;
      if (type === "classNo") return r.classNo === value;
      return false;
    })
    .sort((a,b) =>
      Number(a.classNo)-Number(b.classNo) ||
      Number(a.studentNo)-Number(b.studentNo) ||
      (a.priority||99)-(b.priority||99)
    );
}

function analyticsDetailTitle(type, value) {
  if (type === "university") return `${value} 지원 학생`;
  if (type === "department") return `${value} 지원 학생`;
  if (type === "admissionType") return `${value} 지원 학생`;
  if (type === "classNo") return `${value}반 지원 현황`;
  return "지원 학생 목록";
}

function openAnalyticsDetail(type, value) {
  const detailRows = analyticsDetailRows(type, value);

  $("#analyticsDetailTitle").textContent = analyticsDetailTitle(type, value);
  $("#analyticsDetailSub").textContent = `${detailRows.length}건의 지원정보`;

  $("#analyticsDetailTable").innerHTML = detailRows.length
    ? detailRows.map(r => `
      <tr>
        <td>${escapeHtml(r.classNo)}반 ${escapeHtml(r.studentNo)}번 ${escapeHtml(r.studentName)}</td>
        <td>${escapeHtml(r.university)}</td>
        <td>${escapeHtml(r.department)}</td>
        <td>${escapeHtml(r.admissionType)}</td>
        <td>${escapeHtml(r.admissionName)}</td>
        <td>${escapeHtml(r.status || "검토중")}</td>
        <td>${escapeHtml(r.resultStatus || "미입력")}${
          r.resultStatus === "예비" && r.waitlistNo
            ? ` (${escapeHtml(r.waitlistNo)}번)`
            : ""
        }</td>
      </tr>
    `).join("")
    : `<tr><td colspan="7"><div class="empty">해당 조건의 지원정보가 없습니다.</div></td></tr>`;

  $("#analyticsDetail").classList.remove("hidden");
  $("#analyticsDetail").scrollIntoView({behavior:"smooth", block:"start"});
}

function closeAnalyticsDetail() {
  $("#analyticsDetail").classList.add("hidden");
}

function exportAnalyticsCsv() {
  const data = analyticsSourceRows();
  if (!data.length) return toast("통계로 내보낼 지원정보가 없습니다.");

  const universities = countBy(data, r => r.university);
  const departments = countBy(data, r => r.department);
  const admissionTypes = countBy(data, r => r.admissionType);
  const classes = countBy(data, r => r.classNo);

  const tableRows = [
    ["구분","항목","지원건수"],
    ...universities.map(([k,v]) => ["대학", k, v.length]),
    ...departments.map(([k,v]) => ["학과", k, v.length]),
    ...admissionTypes.map(([k,v]) => ["전형유형", k, v.length]),
    ...classes.map(([k,v]) => ["반", `${k}반`, v.length])
  ];

  downloadCsv(
    `수시지원_통계_${new Date().toISOString().slice(0,10)}.csv`,
    tableRows
  );
  toast("수시지원 통계 CSV를 내려받았습니다.");
}

function render() {
  renderStats();
  renderStatusSummary();
  renderResultSummary();
  renderClassStatus();
  renderDuplicates();
  renderTable();
  renderAnalytics();
}
["filterClass","filterType","filterStatus","filterResult","viewMode"].forEach(id => $("#"+id).addEventListener("change", () => {
  if (id === "filterClass") {
    showingMyClassOnly = $("#filterClass").value === myAssignedClass && !!myAssignedClass;
  }
  renderStatusSummary();
  renderResultSummary();
  renderTable();
  renderAnalytics();
}));
$("#searchInput").addEventListener("input", () => {
  renderTable();
  renderAnalytics();
});
$("#showMyClassBtn").addEventListener("click", applyMyClassView);
$("#showAllClassesBtn").addEventListener("click", applyAllClassView);
$("#teacherClassManageBtn").addEventListener("click", openTeacherClassModal);
$("#teacherClassCloseBtn").addEventListener("click", closeTeacherClassModal);

$("#teacherClassModal").addEventListener("click", (e) => {
  if (e.target === $("#teacherClassModal")) closeTeacherClassModal();
});

$("#teacherClassSaveBtn").addEventListener("click", async () => {
  if (!isPinAdmin()) return toast("최고관리자만 저장할 수 있습니다.");

  const btn = $("#teacherClassSaveBtn");
  btn.disabled = true;
  btn.textContent = "저장 중...";

  try {
    const batch = writeBatch(db);
    const selects = [...document.querySelectorAll(".teacher-class-select")];

    for (const select of selects) {
      const email = normalizeEmail(select.dataset.email);
      const classNo = select.value;
      const ref = doc(db, "teacherClasses", email.replaceAll("/", "_"));

      batch.set(ref, {
        email,
        classNo,
        updatedAt: serverTimestamp(),
        updatedByUid: auth.currentUser?.uid || ""
      }, {merge:true});
    }

    await batch.commit();
    toast("교사 담당반 설정을 저장했습니다.");
    closeTeacherClassModal();
  } catch (e) {
    console.error(e);
    toast("담당반 설정 저장에 실패했습니다.");
  } finally {
    btn.disabled = false;
    btn.textContent = "담당반 설정 저장";
  }
});
$("#filterDuplicateReview").addEventListener("change", () => {
  renderDuplicates();
});
$("#analyticsDetailCloseBtn").addEventListener("click", closeAnalyticsDetail);
$("#analyticsCsvBtn").addEventListener("click", exportAnalyticsCsv);
document.querySelectorAll(".status-summary-card").forEach(btn => {
  btn.addEventListener("click", () => {
    $("#filterStatus").value = btn.dataset.status || "";
    renderStatusSummary();
    renderTable();
    document.querySelector(".filters").scrollIntoView({behavior:"smooth", block:"center"});
  });
});
document.querySelectorAll(".result-summary-card").forEach(btn => {
  btn.addEventListener("click", () => {
    $("#filterResult").value = btn.dataset.result || "";
    renderResultSummary();
    renderTable();
    document.querySelector(".filters").scrollIntoView({behavior:"smooth", block:"center"});
  });
});


$("#lockBtn").addEventListener("click", async () => {
  if (!currentStudentModalKey) return;
  await toggleStudentLock(currentStudentModalKey);
});

$("#historyBtn").addEventListener("click", async () => {
  if (!currentStudentModalKey) return;

  const panel = $("#historyPanel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");

  if (opening) {
    await loadStudentHistory(currentStudentModalKey);
    panel.scrollIntoView({behavior:"smooth", block:"nearest"});
  }
});

$("#studentModalCloseBtn").addEventListener("click", closeStudentModal);
$("#studentModal").addEventListener("click", (e) => {
  if (e.target === $("#studentModal")) closeStudentModal();
});

$("#deleteStudentBtn").addEventListener("click", () => {
  if (!currentStudentModalKey) return;
  openDeleteStudentModal(currentStudentModalKey);
});

$("#deleteStudentCloseBtn").addEventListener("click", closeDeleteStudentModal);
$("#deleteStudentCancelBtn").addEventListener("click", closeDeleteStudentModal);

$("#deleteStudentModal").addEventListener("click", (e) => {
  if (e.target === $("#deleteStudentModal")) closeDeleteStudentModal();
});

$("#deleteStudentConfirmBtn").addEventListener("click", async () => {
  const btn = $("#deleteStudentConfirmBtn");
  $("#deleteStudentError").textContent = "";
  btn.disabled = true;
  btn.textContent = "삭제 중...";

  try {
    const name = deleteTargetStudent?.studentName || "";
    await performCompleteStudentDelete();
    closeDeleteStudentModal();
    closeStudentModal();
    toast(`${name} 학생의 관련 데이터를 완전히 삭제했습니다.`);
  } catch (e) {
    console.error(e);
    $("#deleteStudentError").textContent =
      e.message || "삭제 중 오류가 발생했습니다.";
  } finally {
    btn.disabled = false;
    btn.textContent = "완전 삭제";
  }
});

// 학생 이름 클릭은 표가 다시 그려져도 항상 작동하도록 이벤트 위임 방식 사용
$("#applicationTable").addEventListener("click", (event) => {
  const btn = event.target.closest(".student-name-button");
  if (!btn) return;
  const studentKey = btn.dataset.studentKey;
  if (!studentKey) return;
  openStudentModal(studentKey);
});

$("#generatePinsBtn").addEventListener("click", async () => {
  if (!isPinAdmin()) return toast("PIN 생성 권한이 없습니다.");
  if (!roster.length) return toast("먼저 학생 명단을 업로드해 주세요.");
  if (!confirm(`현재 등록된 ${roster.length}명 전체의 PIN을 새로 발급합니다.\n\n기존 PIN은 사용할 수 없게 됩니다. 계속하시겠습니까?`)) return;
  try {
    $("#generatePinsBtn").disabled=true; $("#rosterUploadStatus").textContent="PIN을 생성하는 중입니다...";
    const oldAccess=await getDocs(collection(db,"studentAccess")); const batch=writeBatch(db); oldAccess.forEach(d=>batch.delete(d.ref));
    for (const st of roster){const pin=generatePin();const accessId=await accessIdFor(st.studentKey,pin);batch.update(doc(db,"students",st.id),{pin,accessId});batch.set(doc(db,"studentAccess",accessId),{studentKey:st.studentKey,classNo:st.classNo,studentNo:st.studentNo,createdAt:serverTimestamp()});}
    await batch.commit(); $("#rosterUploadStatus").textContent=`${roster.length}명의 새 PIN을 생성했습니다.`; toast("PIN 재발급이 완료되었습니다.");
  } catch(e){console.error(e);toast(e.message||"PIN 생성 중 오류가 발생했습니다.");} finally{$("#generatePinsBtn").disabled=false;}
});

$("#exportPinsBtn").addEventListener("click",()=>{
  if(!roster.length)return toast("학생 명단이 없습니다.");const missing=roster.filter(r=>!r.pin);if(missing.length)return toast(`PIN이 없는 학생이 ${missing.length}명 있습니다. PIN 일괄 생성을 먼저 실행하세요.`);
  const data=[...roster].sort((a,b)=>Number(a.classNo)-Number(b.classNo)||Number(a.studentNo)-Number(b.studentNo));const rowsCsv=[["반","번호","이름","PIN"],...data.map(r=>[r.classNo,r.studentNo,r.studentName,r.pin])];const csv="\ufeff"+rowsCsv.map(row=>row.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`학생_PIN_목록_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);toast("학생 PIN 목록을 내려받았습니다.");
});

$("#uploadRosterBtn").addEventListener("click", async () => {
  const input = $("#rosterFile");
  const file = input.files?.[0];
  if (!file) return toast("먼저 학생 명단 파일을 선택해 주세요.");

  try {
    $("#uploadRosterBtn").disabled = true;
    $("#rosterUploadStatus").textContent = "파일을 읽는 중입니다...";

    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, {type:"array"});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, {defval:""});
    const parsed = parseRosterRows(raw);

    if (!parsed.length) {
      throw new Error("반·번호·이름 열을 찾지 못했거나 읽을 수 있는 학생이 없습니다.");
    }

    const existing = await getDocs(collection(db, "students"));
    const batch = writeBatch(db);

    // 업로드 파일을 현재 전체 명단으로 간주하여 기존 roster를 교체
    existing.forEach(d => batch.delete(d.ref));
    parsed.forEach(st => {
      const ref = doc(collection(db, "students"));
      batch.set(ref, st);
    });
    await batch.commit();

    $("#rosterUploadStatus").textContent = `${parsed.length}명의 학생 명단을 저장했습니다.`;
    toast(`${parsed.length}명의 학생 명단을 업로드했습니다.`);
  } catch (e) {
    console.error(e);
    $("#rosterUploadStatus").textContent = "";
    toast(e.message || "학생 명단 업로드 중 오류가 발생했습니다.");
  } finally {
    $("#uploadRosterBtn").disabled = false;
  }
});

$("#closeMissingBtn").addEventListener("click", () => {
  $("#missingSection").classList.add("hidden");
});

$("#loginBtn").addEventListener("click", async () => {
  $("#loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value);
  } catch(e) {
    $("#loginError").textContent = "로그인에 실패했습니다. 이메일과 비밀번호를 확인해 주세요.";
  }
});

function openPasswordModal() {
  const user = auth.currentUser;
  if (!user) return toast("먼저 로그인해 주세요.");

  $("#passwordAccountText").textContent = `로그인 계정: ${user.email || ""}`;
  $("#currentPassword").value = "";
  $("#newPassword").value = "";
  $("#confirmPassword").value = "";
  $("#passwordError").textContent = "";
  $("#passwordModal").classList.remove("hidden");
  $("#passwordModal").setAttribute("aria-hidden", "false");
  setTimeout(() => $("#currentPassword").focus(), 50);
}

function closePasswordModal() {
  $("#passwordModal").classList.add("hidden");
  $("#passwordModal").setAttribute("aria-hidden", "true");
  $("#currentPassword").value = "";
  $("#newPassword").value = "";
  $("#confirmPassword").value = "";
  $("#passwordError").textContent = "";
}

$("#passwordBtn").addEventListener("click", openPasswordModal);
$("#passwordCloseBtn").addEventListener("click", closePasswordModal);
$("#passwordCancelBtn").addEventListener("click", closePasswordModal);

$("#passwordModal").addEventListener("click", (e) => {
  if (e.target === $("#passwordModal")) closePasswordModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#passwordModal").classList.contains("hidden")) closePasswordModal();
    if (!$("#studentModal").classList.contains("hidden")) closeStudentModal();
    if (!$("#teacherClassModal").classList.contains("hidden")) closeTeacherClassModal();
    if (!$("#deleteStudentModal").classList.contains("hidden")) closeDeleteStudentModal();
  }
});

$("#passwordSaveBtn").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user || !user.email) return toast("로그인 정보를 확인할 수 없습니다.");

  const currentPassword = $("#currentPassword").value;
  const newPassword = $("#newPassword").value;
  const confirmPassword = $("#confirmPassword").value;
  const errorEl = $("#passwordError");
  errorEl.textContent = "";

  if (!currentPassword) {
    errorEl.textContent = "현재 비밀번호를 입력해 주세요.";
    return;
  }
  if (newPassword.length < 8) {
    errorEl.textContent = "새 비밀번호는 8자 이상으로 설정해 주세요.";
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = "새 비밀번호와 확인 비밀번호가 일치하지 않습니다.";
    return;
  }
  if (currentPassword === newPassword) {
    errorEl.textContent = "현재 비밀번호와 다른 비밀번호를 사용해 주세요.";
    return;
  }

  const btn = $("#passwordSaveBtn");
  btn.disabled = true;
  btn.textContent = "변경 중...";

  try {
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);

    closePasswordModal();
    toast("비밀번호가 변경되었습니다. 다음 로그인부터 새 비밀번호를 사용하세요.");
  } catch (e) {
    console.error(e);
    const code = e?.code || "";
    if (code.includes("invalid-credential") || code.includes("wrong-password")) {
      errorEl.textContent = "현재 비밀번호가 맞지 않습니다.";
    } else if (code.includes("weak-password")) {
      errorEl.textContent = "새 비밀번호가 너무 단순합니다. 더 안전한 비밀번호를 사용해 주세요.";
    } else if (code.includes("too-many-requests")) {
      errorEl.textContent = "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    } else {
      errorEl.textContent = "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "비밀번호 변경";
  }
});

$("#logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  updatePinAdminUI(user);
  if (user) {
    $("#loginPanel").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    updateMyClassUI();
    if (unsubscribe) unsubscribe();
    if (unsubscribeRoster) unsubscribeRoster();
    if (unsubscribeLocks) unsubscribeLocks();
    if (unsubscribeDuplicateReviews) unsubscribeDuplicateReviews();
    if (unsubscribeTeacherClasses) unsubscribeTeacherClasses();

    unsubscribeTeacherClasses = onSnapshot(collection(db, "teacherClasses"), snap => {
      teacherClassMap = new Map(
        snap.docs.map(d => {
          const data = d.data();
          return [normalizeEmail(data.email), {id:d.id, ...data}];
        })
      );

      updateMyClassUI();

      // 로그인 직후에는 담당반이 지정되어 있다면 자동으로 자기 반 중심으로 시작
      if (myAssignedClass && !showingMyClassOnly && !$("#filterClass").value) {
        showingMyClassOnly = true;
        $("#filterClass").value = myAssignedClass;
      }

      renderClassStatus();
      renderTable();
    }, err => {
      console.error(err);
    });

    unsubscribeDuplicateReviews = onSnapshot(collection(db, "duplicateReviews"), snap => {
      duplicateReviewMap = new Map(snap.docs.map(d => [d.id, {id:d.id, ...d.data()}]));
      renderStats();
      renderDuplicates();
    }, err => {
      console.error(err);
    });

    unsubscribeLocks = onSnapshot(collection(db, "studentLocks"), snap => {
      lockMap = new Map(snap.docs.map(d => [d.id, d.data()]));
      if (currentStudentModalKey) {
        const locked = isStudentLocked(currentStudentModalKey);
        $("#lockBtn").textContent = locked ? "잠금 해제" : "지원안 잠금";
        $("#lockBtn").classList.toggle("danger-outline", locked);
        $("#studentLockInfo").innerHTML = locked
          ? `<span class="lock-badge locked">🔒 학생 수정 잠금 상태</span>`
          : `<span class="lock-badge">🔓 학생 수정 가능</span>`;
      }
    });

    unsubscribeRoster = onSnapshot(collection(db, "students"), snap => {
      roster = snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>
        Number(a.classNo)-Number(b.classNo) ||
        Number(a.studentNo)-Number(b.studentNo) ||
        String(a.studentName).localeCompare(String(b.studentName), "ko")
      );
      renderClassStatus();
    }, err => {
      console.error(err);
      $("#rosterUploadStatus").textContent = "학생 명단 조회 권한을 확인해 주세요.";
    });

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
    if (unsubscribeRoster) { unsubscribeRoster(); unsubscribeRoster = null; }
    if (unsubscribeLocks) { unsubscribeLocks(); unsubscribeLocks = null; }
    if (unsubscribeDuplicateReviews) { unsubscribeDuplicateReviews(); unsubscribeDuplicateReviews = null; }
    if (unsubscribeTeacherClasses) { unsubscribeTeacherClasses(); unsubscribeTeacherClasses = null; }
    teacherClassMap = new Map();
    myAssignedClass = "";
    showingMyClassOnly = false;
    lockMap = new Map();
    duplicateReviewMap = new Map();
    rows = [];
    roster = [];
    $("#dashboard").classList.add("hidden");
    $("#loginPanel").classList.remove("hidden");
  }
});

function downloadCsv(filename, tableRows) {
  const csv = "\ufeff" + tableRows.map(row =>
    row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")
  ).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$("#backupBtn").addEventListener("click", () => {
  if (!rows.length && !roster.length) return toast("백업할 데이터가 없습니다.");

  const date = new Date().toISOString().slice(0,10);

  const applicationRows = [
    ["반","번호","이름","지원순위","대학","학과","전형유형","전형명","상태","메모"],
    ...[...rows]
      .sort((a,b)=>Number(a.classNo)-Number(b.classNo) || Number(a.studentNo)-Number(b.studentNo) || (a.priority||99)-(b.priority||99))
      .map(r => [
        r.classNo, r.studentNo, r.studentName, r.priority,
        r.university, r.department, r.admissionType, r.admissionName,
        r.status, r.memo
      ])
  ];

  // 일반 데이터 백업에는 PIN을 포함하지 않습니다.
  const rosterRows = [
    ["반","번호","이름","지원정보입력여부"],
    ...[...roster]
      .sort((a,b)=>Number(a.classNo)-Number(b.classNo) || Number(a.studentNo)-Number(b.studentNo))
      .map(st => [
        st.classNo, st.studentNo, st.studentName,
        rows.some(r => r.studentKey === st.studentKey) ? "입력" : "미입력"
      ])
  ];

  downloadCsv(`백업_지원현황_${date}.csv`, applicationRows);

  // 브라우저가 연속 다운로드를 처리할 수 있도록 약간의 간격을 둡니다.
  setTimeout(() => {
    downloadCsv(`백업_학생명단_${date}.csv`, rosterRows);
  }, 350);

  toast("지원현황과 학생명단 백업을 내려받았습니다.");
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
