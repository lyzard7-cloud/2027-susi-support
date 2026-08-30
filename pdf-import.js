import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";

import {
  getFirestore, collection, getDocs, query, where,
  writeBatch, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

import { firebaseConfig } from "./firebase-config.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = s => document.querySelector(s);

let roster = [];
let masterUniversities = [];
let parsedApplications = [];
let detectedIdentity = { schoolNo:"", studentName:"" };
let currentUser = null;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
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

function makeStudentKey(classNo, studentNo, studentName) {
  const c = String(classNo ?? "").trim();
  const n = String(studentNo ?? "").trim().padStart(2, "0");
  const name = String(studentName ?? "").trim();
  return `${c}-${n}-${normalize(name)}`;
}

function canonicalUniversity(raw = "") {
  const key = normalizeUniversity(raw);
  if (!key) return raw;

  const found = masterUniversities.find(u => {
    if ((u.universityKey || normalizeUniversity(u.university)) === key) return true;
    return (u.aliases || []).some(a => normalizeUniversity(a) === key);
  });
  return found?.university || raw;
}

function admissionTypeFromText(text = "") {
  const n = normalize(text);
  if (n.includes("학생부교과")) return "학생부교과";
  if (n.includes("학생부종합")) return "학생부종합";
  if (n.includes("논술")) return "논술";
  if (n.includes("실기") || n.includes("특기")) return "실기/실적";
  if (n.includes("적성")) return "적성";
  return text.trim();
}

function splitSchoolNumber(schoolNo = "") {
  const digits = String(schoolNo).replace(/\D/g, "");
  if (digits.length >= 5) {
    return {
      classNo:String(Number(digits.slice(1,3))),
      studentNo:String(Number(digits.slice(3,5)))
    };
  }
  return {classNo:"", studentNo:""};
}

function textItem(item) {
  return {
    text:String(item.str || "").trim(),
    x:Number(item.transform?.[4] || 0),
    y:Number(item.transform?.[5] || 0)
  };
}

function joinCell(items, xMin, xMax, rowY, tolerance = 10) {
  const selected = items
    .filter(i => i.text && i.x >= xMin && i.x < xMax && Math.abs(i.y - rowY) <= tolerance)
    .sort((a,b) => {
      if (Math.abs(a.y - b.y) > 2) return b.y - a.y;
      return a.x - b.x;
    });

  if (!selected.length) return "";

  const lines = [];
  selected.forEach(item => {
    let line = lines.find(l => Math.abs(l.y - item.y) <= 2);
    if (!line) {
      line = {y:item.y, parts:[]};
      lines.push(line);
    }
    line.parts.push(item);
  });

  lines.sort((a,b) => b.y - a.y);
  return lines.map(line =>
    line.parts.sort((a,b) => a.x - b.x).map(p => p.text).join("")
  ).join(" ").trim();
}

function parseKnownCounselingCard(pageItems, fullText) {
  const schoolNo =
    fullText.match(/학번\s*\(?\s*(\d{4,6})/)?.[1] ||
    fullText.match(/\b(3\d{4})\b/)?.[1] || "";

  const studentName =
    fullText.match(/이름\s*\(?\s*([가-힣]{2,5})/)?.[1] || "";

  const apps = [];
  const rowMarkers = pageItems
    .filter(i => /^(?:[1-9]|1[0-2])$/.test(i.text) && i.x < 50)
    .sort((a,b) => b.y - a.y);

  const seenRows = new Set();

  for (const marker of rowMarkers) {
    const priority = Number(marker.text);
    if (seenRows.has(priority)) continue;
    seenRows.add(priority);

    const universityRaw = joinCell(pageItems, 48, 120, marker.y, 10);
    const department = joinCell(pageItems, 120, 195, marker.y, 10);
    const admissionCell = joinCell(pageItems, 195, 262, marker.y, 11);

    if (!universityRaw || !department) continue;

    const admParts = admissionCell.split(/\s+/).filter(Boolean);
    let admissionType = "";
    let admissionName = "";

    const typeIndex = admParts.findIndex(x =>
      ["학생부교과","학생부종합","논술","실기","실기/실적","적성"].some(t => normalize(x).includes(normalize(t)))
    );

    if (typeIndex >= 0) {
      admissionType = admissionTypeFromText(admParts[typeIndex]);
      admissionName = admParts.filter((_,idx) => idx !== typeIndex).join(" ").trim();
    } else {
      const knownType = admissionCell.match(/학생부교과|학생부종합|논술|실기\/실적|실기|적성/)?.[0] || "";
      admissionType = admissionTypeFromText(knownType);
      admissionName = admissionCell.replace(knownType, "").trim();
    }

    apps.push({
      priority,
      university:canonicalUniversity(universityRaw),
      originalUniversity:universityRaw,
      department:department.trim(),
      admissionType:admissionType || "기타",
      admissionName:admissionName.trim()
    });
  }

  return {
    identity:{schoolNo, studentName},
    applications:apps.sort((a,b) => a.priority - b.priority)
  };
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({data}).promise;

  let fullText = "";
  let allItems = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.map(textItem).filter(i => i.text);
    fullText += " " + items.map(i => i.text).join(" ");
    if (p === 1) allItems = items;
  }

  const result = parseKnownCounselingCard(allItems, fullText);

  if (!result.identity.studentName && !result.identity.schoolNo) {
    throw new Error("학번과 이름을 찾지 못했습니다. 이 상담카드 양식인지 확인해 주세요.");
  }
  if (!result.applications.length) {
    throw new Error("지원 대학 표를 읽지 못했습니다. PDF가 스캔 이미지인지 확인해 주세요.");
  }
  return result;
}

function populateStudentSelect(identity) {
  const select = $("#matchedStudentSelect");
  const {classNo, studentNo} = splitSchoolNumber(identity.schoolNo);

  let matched = roster.find(st =>
    String(st.classNo) === classNo &&
    String(Number(st.studentNo)) === String(Number(studentNo)) &&
    normalize(st.studentName) === normalize(identity.studentName)
  );

  if (!matched && identity.studentName) {
    const sameName = roster.filter(st => normalize(st.studentName) === normalize(identity.studentName));
    if (sameName.length === 1) matched = sameName[0];
  }

  const sorted = [...roster].sort((a,b) =>
    Number(a.classNo)-Number(b.classNo) ||
    Number(a.studentNo)-Number(b.studentNo)
  );

  select.innerHTML =
    `<option value="">학생을 선택하세요</option>` +
    sorted.map(st => `
      <option value="${escapeHtml(st.studentKey)}" ${matched?.studentKey === st.studentKey ? "selected" : ""}>
        ${escapeHtml(st.classNo)}반 ${escapeHtml(st.studentNo)}번 ${escapeHtml(st.studentName)}
      </option>
    `).join("");

  const badge = $("#studentMatchBadge");
  if (matched) {
    badge.textContent = "학생 확인 완료";
    badge.className = "match-badge matched";
    $("#studentMatchMessage").textContent =
      `${matched.classNo}반 ${matched.studentNo}번 ${matched.studentName} 학생과 자동으로 일치했습니다.`;
  } else {
    badge.textContent = "교사 확인 필요";
    badge.className = "match-badge warning";
    $("#studentMatchMessage").textContent =
      "학생명단에서 정확히 일치하는 학생을 찾지 못했습니다. 아래 목록에서 직접 선택해 주세요.";
  }
}

async function existingAppsForStudent(studentKey) {
  if (!studentKey) return [];
  const snap = await getDocs(query(collection(db, "applications"), where("studentKey", "==", studentKey)));
  return snap.docs.map(d => ({id:d.id, ...d.data()}));
}

function exactKeyOf(app) {
  return [
    normalizeUniversity(app.university),
    normalizeDepartment(app.department),
    normalizeAdmission(app.admissionName)
  ].join("|");
}

async function renderPreview() {
  const studentKey = $("#matchedStudentSelect").value;
  const existing = await existingAppsForStudent(studentKey);
  const existingKeys = new Set(existing.map(exactKeyOf));

  const body = $("#pdfPreviewBody");
  body.innerHTML = parsedApplications.map((a, idx) => {
    const duplicate = existingKeys.has(exactKeyOf(a));
    return `
      <tr data-row-index="${idx}" class="${duplicate ? "existing-row" : ""}">
        <td>
          <input class="import-check" type="checkbox" ${duplicate ? "disabled" : "checked"} />
        </td>
        <td>${escapeHtml(a.priority)}</td>
        <td><input class="pdf-university" value="${escapeHtml(a.university)}" /></td>
        <td><input class="pdf-department" value="${escapeHtml(a.department)}" /></td>
        <td>
          <select class="pdf-admission-type">
            ${["학생부교과","학생부종합","논술","실기/실적","적성","기타"].map(t =>
              `<option value="${t}" ${a.admissionType === t ? "selected" : ""}>${t}</option>`
            ).join("")}
          </select>
        </td>
        <td><input class="pdf-admission-name" value="${escapeHtml(a.admissionName)}" /></td>
        <td>
          <span class="import-status ${duplicate ? "duplicate" : "new"}">
            ${duplicate ? "기존 등록됨" : "신규"}
          </span>
        </td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("input,select").forEach(el => {
    el.addEventListener("change", updateImportSummary);
    el.addEventListener("input", updateImportSummary);
  });

  updateImportSummary();
}

function collectPreviewRows() {
  return [...$("#pdfPreviewBody").querySelectorAll("tr")].map(tr => ({
    selected:tr.querySelector(".import-check")?.checked || false,
    university:tr.querySelector(".pdf-university")?.value.trim() || "",
    department:tr.querySelector(".pdf-department")?.value.trim() || "",
    admissionType:tr.querySelector(".pdf-admission-type")?.value || "",
    admissionName:tr.querySelector(".pdf-admission-name")?.value.trim() || "",
    disabled:tr.querySelector(".import-check")?.disabled || false
  }));
}

function updateImportSummary() {
  const rows = collectPreviewRows();
  const selected = rows.filter(r => r.selected && !r.disabled).length;
  const duplicates = rows.filter(r => r.disabled).length;
  $("#importSummary").textContent =
    `신규 등록 선택 ${selected}건 · 기존 중복 ${duplicates}건 자동 제외`;
  $("#importApplicationsBtn").disabled = !$("#matchedStudentSelect").value || selected === 0;
}

async function importApplications() {
  const studentKey = $("#matchedStudentSelect").value;
  const student = roster.find(st => st.studentKey === studentKey);
  if (!student) return toast("등록할 학생을 선택해 주세요.");

  const preview = collectPreviewRows().filter(r => r.selected && !r.disabled);
  if (!preview.length) return toast("등록할 신규 지원이 없습니다.");

  for (const row of preview) {
    if (!row.university || !row.department || !row.admissionType || !row.admissionName) {
      return toast("선택한 행의 대학·학과·전형유형·전형명을 모두 확인해 주세요.");
    }
  }

  if (!confirm(`${student.classNo}반 ${student.studentNo}번 ${student.studentName} 학생에게 ${preview.length}건을 등록하시겠습니까?`)) {
    return;
  }

  const button = $("#importApplicationsBtn");
  button.disabled = true;
  button.textContent = "등록 중...";

  try {
    // 저장 직전에 다시 조회하여 동시 작업에 의한 중복도 방지
    const existing = await existingAppsForStudent(student.studentKey);
    const existingKeys = new Set(existing.map(exactKeyOf));
    let nextPriority = Math.max(0, ...existing.map(a => Number(a.priority || 0)));
    const trulyNew = preview.filter(a => !existingKeys.has(exactKeyOf(a)));

    if (!trulyNew.length) {
      toast("모든 지원이 이미 등록되어 있습니다.");
      await renderPreview();
      return;
    }

    const batch = writeBatch(db);

    trulyNew.forEach(a => {
      nextPriority += 1;
      const ref = doc(collection(db, "applications"));
      batch.set(ref, {
        studentKey:student.studentKey,
        classNo:String(student.classNo),
        studentNo:String(student.studentNo),
        studentName:String(student.studentName),
        priority:nextPriority,
        university:a.university,
        department:a.department,
        admissionType:a.admissionType,
        admissionName:a.admissionName,
        status:"검토중",
        resultStatus:"미입력",
        waitlistNo:"",
        memo:"수시지원상담카드 PDF에서 교사가 가져옴",
        ownerUid:currentUser.uid,
        accessId:student.accessId || "",
        normalizedUniversity:normalizeUniversity(a.university),
        normalizedDepartment:normalizeDepartment(a.department),
        normalizedAdmissionName:normalizeAdmission(a.admissionName),
        exactKey:exactKeyOf(a),
        departmentKey:[
          normalizeUniversity(a.university),
          normalizeDepartment(a.department)
        ].join("|"),
        universityKey:normalizeUniversity(a.university),
        importedFrom:"counseling-card-pdf",
        importedAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });
    });

    await batch.commit();

    $("#previewCard").classList.add("hidden");
    $("#resultCard").classList.remove("hidden");
    $("#importResultText").textContent =
      `${student.classNo}반 ${student.studentNo}번 ${student.studentName} 학생에게 신규 지원 ${trulyNew.length}건을 등록했습니다.`;
    toast("PDF 지원정보 등록이 완료되었습니다.");
  } catch (e) {
    console.error(e);
    toast(e.message || "지원정보 등록에 실패했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = "선택한 지원 일괄 등록";
  }
}

function resetImport() {
  $("#pdfFile").value = "";
  $("#analyzeStatus").textContent = "";
  $("#studentMatchCard").classList.add("hidden");
  $("#previewCard").classList.add("hidden");
  $("#resultCard").classList.add("hidden");
  parsedApplications = [];
  detectedIdentity = {schoolNo:"", studentName:""};
  window.scrollTo({top:0, behavior:"smooth"});
}

$("#analyzePdfBtn").addEventListener("click", async () => {
  const file = $("#pdfFile").files?.[0];
  if (!file) return toast("상담카드 PDF 파일을 선택해 주세요.");

  const button = $("#analyzePdfBtn");
  button.disabled = true;
  button.textContent = "분석 중...";
  $("#analyzeStatus").textContent = "PDF에서 학번·이름과 지원 표를 읽고 있습니다.";

  try {
    const result = await extractPdf(file);
    detectedIdentity = result.identity;
    parsedApplications = result.applications;

    $("#detectedStudentNo").textContent = detectedIdentity.schoolNo || "인식 안 됨";
    $("#detectedStudentName").textContent = detectedIdentity.studentName || "인식 안 됨";
    $("#detectedApplicationCount").textContent = `${parsedApplications.length}건`;

    populateStudentSelect(detectedIdentity);
    $("#studentMatchCard").classList.remove("hidden");
    $("#previewCard").classList.remove("hidden");
    $("#resultCard").classList.add("hidden");

    await renderPreview();

    $("#analyzeStatus").textContent =
      `${parsedApplications.length}건의 지원정보를 읽었습니다. 아래 내용을 확인해 주세요.`;
    $("#studentMatchCard").scrollIntoView({behavior:"smooth", block:"start"});
  } catch (e) {
    console.error(e);
    $("#analyzeStatus").textContent = e.message || "PDF 분석에 실패했습니다.";
    toast("PDF 분석에 실패했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = "PDF 분석";
  }
});

$("#matchedStudentSelect").addEventListener("change", async () => {
  const student = roster.find(st => st.studentKey === $("#matchedStudentSelect").value);
  const badge = $("#studentMatchBadge");
  if (student) {
    badge.textContent = "학생 선택 완료";
    badge.className = "match-badge matched";
  } else {
    badge.textContent = "확인 필요";
    badge.className = "match-badge warning";
  }
  await renderPreview();
});

$("#selectNewOnlyBtn").addEventListener("click", () => {
  $("#pdfPreviewBody").querySelectorAll(".import-check:not(:disabled)").forEach(cb => cb.checked = true);
  updateImportSummary();
});

$("#importApplicationsBtn").addEventListener("click", importApplications);
$("#importAnotherBtn").addEventListener("click", resetImport);

onAuthStateChanged(auth, async user => {
  if (!user || !user.providerData?.some(p => p.providerId === "password")) {
    $("#authWait").innerHTML = `
      <h2>교사 로그인이 필요합니다.</h2>
      <p class="helper">먼저 관리자 대시보드에서 교사 계정으로 로그인해 주세요.</p>
      <a class="link-button" href="./admin.html">관리자 로그인으로 이동</a>
    `;
    return;
  }

  currentUser = user;

  try {
    const [rosterSnap, masterSnap] = await Promise.all([
      getDocs(collection(db, "students")),
      getDocs(collection(db, "admissionUniversities"))
    ]);

    roster = rosterSnap.docs.map(d => ({id:d.id, ...d.data()}));
    masterUniversities = masterSnap.docs.map(d => ({id:d.id, ...d.data()}));

    $("#authWait").classList.add("hidden");
    $("#importApp").classList.remove("hidden");
  } catch (e) {
    console.error(e);
    $("#authWait").innerHTML = `
      <h2>데이터를 불러오지 못했습니다.</h2>
      <p class="helper">${escapeHtml(e.message || "잠시 후 다시 시도해 주세요.")}</p>
      <a class="link-button" href="./admin.html">관리자 대시보드로 돌아가기</a>
    `;
  }
});
