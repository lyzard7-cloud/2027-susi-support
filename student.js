import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, query, where, getDocs, writeBatch, doc,
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

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function normalize(v = "") {
  return v.toLowerCase().replace(/\s+/g, "").replace(/[()·ㆍ\-_.]/g, "");
}

function studentKey() {
  const c = $("#classNo").value.trim();
  const n = $("#studentNo").value.trim().padStart(2, "0");
  const name = $("#studentName").value.trim();
  return `${c}-${n}-${normalize(name)}`;
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
    $("#loadStatus").textContent = "조회 중...";
    const q = query(
      collection(db, "applications"),
      where("studentKey", "==", id.studentKey),
      where("ownerUid", "==", currentUser.uid)
    );
    const snap = await getDocs(q);
    applicationsEl.innerHTML = "";
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>(a.priority||99)-(b.priority||99));
    if (!rows.length) {
      applicationTemplate();
      $("#loadStatus").textContent = "기존 정보가 없습니다. 새로 입력하세요.";
      loadedStudentKey = id.studentKey;
      return;
    }
    rows.forEach(applicationTemplate);
    loadedStudentKey = id.studentKey;
    $("#loadStatus").textContent = `${rows.length}건의 기존 지원정보를 불러왔습니다.`;
    toast("기존 지원정보를 불러왔습니다.");
  } catch (e) {
    $("#loadStatus").textContent = "";
    toast(e.message || "조회 중 오류가 발생했습니다.");
  }
});

$("#submitBtn").addEventListener("click", async () => {
  try {
    const id = getIdentity();
    const apps = collectApplications();
    validateApplications(apps);
    const btn = $("#submitBtn");
    btn.disabled = true; btn.textContent = "저장 중...";

    const oldQ = query(
      collection(db, "applications"),
      where("studentKey", "==", id.studentKey),
      where("ownerUid", "==", currentUser.uid)
    );
    const oldSnap = await getDocs(oldQ);
    const batch = writeBatch(db);
    oldSnap.forEach(d => batch.delete(d.ref));

    apps.forEach((a, i) => {
      const ref = doc(collection(db, "applications"));
      batch.set(ref, {
        ...id, ...a,
        ownerUid: currentUser.uid,
        normalizedUniversity: normalize(a.university),
        normalizedDepartment: normalize(a.department),
        normalizedAdmissionName: normalize(a.admissionName),
        exactKey: [normalize(a.university), normalize(a.department), normalize(a.admissionName)].join("|"),
        departmentKey: [normalize(a.university), normalize(a.department)].join("|"),
        universityKey: normalize(a.university),
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
