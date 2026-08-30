import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, getDocs, onSnapshot, writeBatch,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { PIN_ADMIN_EMAIL } from "./admin-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = s => document.querySelector(s);

let masterRows = [];

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}
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
function stableHash(text = "") {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function isPinAdmin(user = auth.currentUser) {
  return !!user &&
    String(user.email || "").toLowerCase() ===
    String(PIN_ADMIN_EMAIL || "").toLowerCase();
}
function findHeaderKey(obj, candidates) {
  const keys = Object.keys(obj || {});
  return keys.find(k => candidates.includes(normalize(k))) || null;
}
function unique(values) {
  return [...new Set(values.map(v => String(v || "").trim()).filter(Boolean))]
    .sort((a,b) => a.localeCompare(b, "ko"));
}
function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

function parseMasterSheet(rawRows) {
  const grouped = new Map();

  for (const row of rawRows) {
    const universityKeyName = findHeaderKey(row, ["대학명","대학교","대학","학교명","university"]);
    if (!universityKeyName) continue;

    const yearKey = findHeaderKey(row, ["학년도","년도","연도","year"]);
    const aliasKey = findHeaderKey(row, ["대학별칭","별칭","약칭","aliases","alias"]);
    const departmentKey = findHeaderKey(row, ["모집단위학과","모집단위","학과","학부","department"]);
    const typeKey = findHeaderKey(row, ["전형유형","전형구분","유형","admissiontype"]);
    const admissionKey = findHeaderKey(row, ["전형명","세부전형명","전형","admissionname"]);

    const university = String(row[universityKeyName] ?? "").trim();
    if (!university) continue;

    const key = normalizeUniversity(university);
    if (!key) continue;

    if (!grouped.has(key)) {
      grouped.set(key, {
        schoolYears: new Set(),
        university,
        universityKey:key,
        aliases:new Set(),
        departments:new Set(),
        admissions:new Map()
      });
    }

    const g = grouped.get(key);
    const year = yearKey ? String(row[yearKey] ?? "").trim() : "";
    if (year) g.schoolYears.add(year);

    if (aliasKey) {
      String(row[aliasKey] ?? "")
        .split(/[,;/|]/)
        .map(x => x.trim())
        .filter(Boolean)
        .forEach(x => g.aliases.add(x));
    }

    const department = departmentKey ? String(row[departmentKey] ?? "").trim() : "";
    if (department) g.departments.add(department);

    const admissionName = admissionKey ? String(row[admissionKey] ?? "").trim() : "";
    const admissionType = typeKey ? String(row[typeKey] ?? "").trim() : "";
    if (admissionName) {
      const admKey = normalize(admissionName);
      const old = g.admissions.get(admKey);
      g.admissions.set(admKey, {
        name:admissionName,
        type:admissionType || old?.type || ""
      });
    }
  }

  return [...grouped.values()].map(g => ({
    schoolYear: unique([...g.schoolYears]).join(", ") || "2027",
    university:g.university,
    universityKey:g.universityKey,
    aliases:unique([...g.aliases]),
    departments:unique([...g.departments]),
    admissions:[...g.admissions.values()].sort((a,b) =>
      a.name.localeCompare(b.name, "ko")
    )
  })).sort((a,b) => a.university.localeCompare(b.university, "ko"));
}

async function replaceMasterData(data) {
  const existing = await getDocs(collection(db, "admissionUniversities"));

  const deleteRefs = existing.docs.map(d => d.ref);
  for (const refs of chunk(deleteRefs, 400)) {
    const batch = writeBatch(db);
    refs.forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  for (const group of chunk(data, 350)) {
    const batch = writeBatch(db);
    group.forEach(item => {
      const ref = doc(db, "admissionUniversities", `u_${stableHash(item.universityKey)}`);
      batch.set(ref, {
        ...item,
        updatedAt:serverTimestamp(),
        updatedByUid:auth.currentUser?.uid || "",
        updatedByEmail:auth.currentUser?.email || ""
      });
    });
    await batch.commit();
  }
}

function renderMaster() {
  const q = $("#masterSearch").value.trim().toLowerCase();
  const data = masterRows.filter(r =>
    !q || [r.university, ...(r.aliases || [])].join(" ").toLowerCase().includes(q)
  );

  $("#masterUniversityCount").textContent = masterRows.length;
  $("#masterDepartmentCount").textContent =
    masterRows.reduce((sum, r) => sum + (r.departments || []).length, 0);
  $("#masterAdmissionCount").textContent =
    masterRows.reduce((sum, r) => sum + (r.admissions || []).length, 0);

  const years = unique(masterRows.map(r => r.schoolYear));
  $("#masterYear").textContent = years.length ? years.join(", ") : "-";
  $("#masterListCount").textContent = `${data.length}개 대학`;

  $("#masterList").innerHTML = data.length ? data.map(r => `
    <article class="master-university-card">
      <div class="master-university-head">
        <div>
          <strong>${escapeHtml(r.university)}</strong>
          <span>${escapeHtml(r.schoolYear || "")}</span>
        </div>
        <div class="master-count-chips">
          <span>학과 ${(r.departments || []).length}</span>
          <span>전형 ${(r.admissions || []).length}</span>
        </div>
      </div>
      ${(r.aliases || []).length
        ? `<div class="master-alias">별칭 · ${escapeHtml((r.aliases || []).join(", "))}</div>`
        : ""}
      <details>
        <summary>등록 내용 보기</summary>
        <div class="master-detail-grid">
          <div>
            <b>학과·모집단위</b>
            <p>${escapeHtml((r.departments || []).slice(0,40).join(" · ") || "없음")}</p>
          </div>
          <div>
            <b>전형명</b>
            <p>${(r.admissions || []).slice(0,30).map(a =>
              `${escapeHtml(a.name)}${a.type ? ` <small>(${escapeHtml(a.type)})</small>` : ""}`
            ).join(" · ") || "없음"}</p>
          </div>
        </div>
      </details>
    </article>
  `).join("") : `<div class="empty">등록된 대학이 없습니다.</div>`;
}

$("#masterSearch").addEventListener("input", renderMaster);

$("#masterTemplateBtn").addEventListener("click", () => {
  const csv = "\ufeff" + [
    ["학년도","대학명","대학별칭","모집단위(학과)","전형유형","전형명"],
    ["2027","예시대학교","예시대,예대","간호학과","학생부교과","지역인재전형"],
    ["2027","예시대학교","예시대,예대","경영학과","학생부종합","미래인재전형"]
  ].map(row => row.map(v => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");

  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "대학_학과_전형_자동완성_업로드양식.csv";
  a.click();
  URL.revokeObjectURL(url);
});

$("#masterUploadBtn").addEventListener("click", async () => {
  if (!isPinAdmin()) return toast("최고관리자만 업로드할 수 있습니다.");

  const file = $("#masterFile").files?.[0];
  if (!file) return toast("먼저 엑셀 또는 CSV 파일을 선택해 주세요.");

  if (!confirm("기존 대학·학과·전형 자동완성 데이터를 모두 지우고 새 파일로 교체합니다. 계속하시겠습니까?")) {
    return;
  }

  const btn = $("#masterUploadBtn");
  btn.disabled = true;
  btn.textContent = "업로드 중...";
  $("#masterUploadStatus").textContent = "파일을 읽는 중입니다...";

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:"array"});

    // '업로드용' 시트가 있으면 우선 사용.
    // 없으면 각 시트를 순서대로 확인하여 대학명 열이 있는 시트를 자동 탐색.
    let ws = wb.Sheets["업로드용"] || null;

    if (!ws) {
      for (const sheetName of wb.SheetNames) {
        const candidate = wb.Sheets[sheetName];
        const preview = XLSX.utils.sheet_to_json(candidate, {defval:""});
        const first = preview[0] || {};
        const hasUniversityColumn = Object.keys(first).some(k =>
          ["대학명","대학교","대학","학교명","university"].includes(normalize(k))
        );
        if (hasUniversityColumn) {
          ws = candidate;
          break;
        }
      }
    }

    if (!ws) {
      throw new Error("'업로드용' 시트 또는 '대학명' 열이 있는 시트를 찾지 못했습니다.");
    }

    const raw = XLSX.utils.sheet_to_json(ws, {defval:""});
    const parsed = parseMasterSheet(raw);

    if (!parsed.length) {
      throw new Error("'대학명' 열을 찾지 못했거나 등록 가능한 대학이 없습니다.");
    }

    $("#masterUploadStatus").textContent =
      `${parsed.length}개 대학을 Firebase에 저장하는 중입니다...`;

    await replaceMasterData(parsed);

    $("#masterUploadStatus").textContent =
      `${parsed.length}개 대학의 자동완성 데이터를 저장했습니다.`;
    toast("입시 자동완성 데이터 업로드가 완료되었습니다.");
  } catch (e) {
    console.error(e);
    $("#masterUploadStatus").textContent = e.message || "업로드 중 오류가 발생했습니다.";
    toast("입시데이터 업로드에 실패했습니다.");
  } finally {
    btn.disabled = false;
    btn.textContent = "업로드 및 전체 교체";
  }
});

onAuthStateChanged(auth, user => {
  if (!user) {
    $("#masterWait").innerHTML = `
      <h2>교사 로그인이 필요합니다.</h2>
      <p class="helper">먼저 관리자 페이지에서 최고관리자 계정으로 로그인해 주세요.</p>
      <a class="link-button" href="./admin.html">관리자 로그인으로 이동</a>
    `;
    return;
  }

  if (!isPinAdmin(user)) {
    $("#masterWait").innerHTML = `
      <h2>접근 권한이 없습니다.</h2>
      <p class="helper">대학·학과·전형 마스터 데이터는 최고관리자만 관리할 수 있습니다.</p>
      <a class="link-button" href="./admin.html">관리자 대시보드로 돌아가기</a>
    `;
    return;
  }

  $("#masterWait").classList.add("hidden");
  $("#masterDashboard").classList.remove("hidden");

  onSnapshot(collection(db, "admissionUniversities"), snap => {
    masterRows = snap.docs.map(d => ({id:d.id, ...d.data()}))
      .sort((a,b) => String(a.university || "").localeCompare(String(b.university || ""), "ko"));
    renderMaster();
  }, e => {
    console.error(e);
    toast("입시데이터를 불러오지 못했습니다.");
  });
});
