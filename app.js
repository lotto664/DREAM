const STORAGE_KEY = 'dream_alarms_v1';

function loadAlarms() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveAlarms(alarms) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
}

let alarms = loadAlarms();

// ---------- 탭 전환 ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'calendar') renderCalendar();
  });
});

// ---------- 음성 인식 (알람용 / 검색용 공용) ----------
const SILENCE_TIMEOUT_MS = 3000;
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

function createMicController(btn, statusEl, targetEl, defaultStatusText, options = {}) {
  const { append = false } = options;
  const controller = { recognition: null, listening: false };
  if (!SpeechRecognitionCtor) {
    statusEl.textContent = '이 브라우저는 음성인식을 지원하지 않아요. 텍스트로 직접 입력해주세요.';
    btn.disabled = true;
    return controller;
  }

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;
  recognition.continuous = true;
  let silenceTimer = null;
  let baseText = '';

  const resetSilenceTimer = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (controller.listening) recognition.stop();
    }, SILENCE_TIMEOUT_MS);
  };

  recognition.onstart = () => {
    controller.listening = true;
    btn.classList.add('listening');
    statusEl.textContent = '듣고 있어요... (말이 없으면 3초 후 종료)';
    resetSilenceTimer();
  };

  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
    }
    const corrected = applyCustomWordCorrection(text, loadCustomWords());
    let next = append && baseText ? `${baseText} ${corrected}` : corrected;
    const maxLen = targetEl.maxLength > 0 ? targetEl.maxLength : Infinity;
    if (next.length > maxLen) next = next.slice(0, maxLen);
    targetEl.value = next;
    // 검색창처럼 입력에 반응하는 화면(글자수 표시 등)이 바로 갱신되도록 input 이벤트를 쏴준다
    targetEl.dispatchEvent(new Event('input'));
    resetSilenceTimer();
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech') return;
    statusEl.textContent = `오류: ${event.error} (텍스트로 직접 입력해도 됩니다)`;
  };

  recognition.onend = () => {
    controller.listening = false;
    clearTimeout(silenceTimer);
    btn.classList.remove('listening');
    statusEl.textContent = defaultStatusText;
  };

  btn.addEventListener('click', () => {
    if (controller.listening) {
      recognition.stop();
    } else {
      baseText = append ? targetEl.value.trim() : '';
      if (!append) targetEl.value = '';
      recognition.start();
    }
  });

  controller.recognition = recognition;
  return controller;
}

const micBtn = document.getElementById('micBtn');
const micStatus = document.getElementById('micStatus');
const transcriptEl = document.getElementById('transcript');
createMicController(micBtn, micStatus, transcriptEl, '버튼을 눌러 말해보세요');

// ---------- 입력 (일정 등록 / 위험성평가 검색 자동 판별) ----------
const analyzeBtn = document.getElementById('analyzeBtn');
const previewCard = document.getElementById('previewCard');
const pDate = document.getElementById('pDate');
const pTime = document.getElementById('pTime');
const pTitle = document.getElementById('pTitle');
const pDetail = document.getElementById('pDetail');
const pDetailCount = document.getElementById('pDetailCount');

function bindDetailCounter(textarea, counterEl) {
  textarea.addEventListener('input', () => {
    counterEl.textContent = `${textarea.value.length}/1000`;
  });
}
bindDetailCounter(pDetail, pDetailCount);

// 상세 메모 음성입력 (기존 내용 뒤에 이어붙임)
createMicController(
  document.getElementById('pDetailMicBtn'),
  document.getElementById('pDetailMicStatus'),
  pDetail,
  '누르고 말하면 메모에 추가돼요',
  { append: true }
);

analyzeBtn.addEventListener('click', () => {
  const text = transcriptEl.value.trim();
  if (!text) {
    alert('먼저 음성이나 텍스트로 내용을 입력해주세요.');
    return;
  }

  const parsed = parseKoreanDateTime(text);

  if (parsed.hasDateTimeCue) {
    pDate.value = parsed.dateISO;
    pTime.value = parsed.time;
    pTitle.value = parsed.title;
    pDetail.value = '';
    pDetailCount.textContent = '0/1000';
    previewCard.classList.remove('hidden');
  } else {
    // 날짜/시간이 없으면 자료검색으로 자동 전환해서 검색 실행
    previewCard.classList.add('hidden');
    docSearchInput.value = text;
    document.querySelector('.tab-btn[data-tab="docs"]').click();
    renderDocList();
  }
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  previewCard.classList.add('hidden');
});

// 구글 캘린더 "일정 만들기" 화면을 제목/시간/메모가 채워진 상태로 여는 주소
function googleCalendarUrl(alarm) {
  const start = `${alarm.dateISO.replace(/-/g, '')}T${alarm.time.replace(':', '')}00`;
  const endDate = new Date(`${alarm.dateISO}T${alarm.time}:00`);
  endDate.setHours(endDate.getHours() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(endDate.getMinutes())}00`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: alarm.title,
    dates: `${start}/${end}`,
    details: alarm.detail || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function saveAlarmFromPreview() {
  if (!pDate.value || !pTime.value) {
    alert('날짜와 시간을 확인해주세요.');
    return null;
  }
  const newAlarm = {
    id: `${Date.now()}`,
    dateISO: pDate.value,
    time: pTime.value,
    title: pTitle.value.trim() || '(제목 없음)',
    detail: pDetail.value.trim(),
    createdAt: new Date().toISOString(),
    notified: false,
  };
  alarms.push(newAlarm);
  alarms.sort((a, b) => `${a.dateISO}${a.time}`.localeCompare(`${b.dateISO}${b.time}`));
  saveAlarms(alarms);

  previewCard.classList.add('hidden');
  transcriptEl.value = '';

  document.querySelector('.tab-btn[data-tab="calendar"]').click();
  return newAlarm;
}

document.getElementById('saveBtn').addEventListener('click', () => {
  saveAlarmFromPreview();
});

document.getElementById('saveGcalBtn').addEventListener('click', () => {
  const alarm = saveAlarmFromPreview();
  if (alarm) window.open(googleCalendarUrl(alarm), '_blank');
});

// ---------- 캘린더 렌더링 ----------
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatDateHeader(dateISO) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateISO);
  const diffDays = Math.round((target - today) / 86400000);

  const weekday = ['일', '월', '화', '수', '목', '금', '토'][target.getDay()];
  const mmdd = `${target.getMonth() + 1}/${target.getDate()}`;

  let label = `${mmdd} (${weekday})`;
  if (diffDays === 0) label = `오늘 · ${label}`;
  else if (diffDays === 1) label = `내일 · ${label}`;
  else if (diffDays === -1) label = `어제 · ${label}`;

  return { label, isPast: diffDays < 0 };
}

function renderCalendar() {
  const listEl = document.getElementById('calendarList');
  alarms = loadAlarms();

  if (alarms.length === 0) {
    listEl.innerHTML = '<p class="empty-state">등록된 일정이 없어요. 음성입력 탭에서 추가해보세요.</p>';
    return;
  }

  const groups = {};
  alarms.forEach((a) => {
    if (!groups[a.dateISO]) groups[a.dateISO] = [];
    groups[a.dateISO].push(a);
  });

  const sortedDates = Object.keys(groups).sort();

  listEl.innerHTML = sortedDates
    .map((dateISO) => {
      const { label, isPast } = formatDateHeader(dateISO);
      const items = groups[dateISO]
        .sort((a, b) => a.time.localeCompare(b.time))
        .map(
          (a) => `
            <div class="event-item ${isPast ? 'past' : ''}" data-id="${a.id}">
              <span class="event-time">${a.time}</span>
              <span class="event-title">${a.title}</span>
              <button class="gcal-item-btn" data-id="${a.id}" title="구글 캘린더에 등록">📅</button>
              <button class="edit-btn" data-id="${a.id}">✏️</button>
              <button class="delete-btn" data-id="${a.id}">✕</button>
            </div>
            ${a.detail ? `<div class="detail-preview">${escapeHtml(a.detail)}</div>` : ''}`
        )
        .join('');
      return `<div class="date-group"><h3 class="date-header ${isPast ? 'past' : ''}">${label}</h3>${items}</div>`;
    })
    .join('');

  listEl.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.dataset.id;
      alarms = alarms.filter((a) => a.id !== id);
      saveAlarms(alarms);
      renderCalendar();
    });
  });

  listEl.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.dataset.id;
      openEditCard(id);
    });
  });

  listEl.querySelectorAll('.gcal-item-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const alarm = alarms.find((a) => a.id === e.target.dataset.id);
      if (alarm) window.open(googleCalendarUrl(alarm), '_blank');
    });
  });
}

// ---------- 일정 수정 ----------
const editCard = document.getElementById('editCard');
const eDate = document.getElementById('eDate');
const eTime = document.getElementById('eTime');
const eTitle = document.getElementById('eTitle');
const eDetail = document.getElementById('eDetail');
const eDetailCount = document.getElementById('eDetailCount');
let editingId = null;
bindDetailCounter(eDetail, eDetailCount);

// 일정 수정 카드의 상세 메모 음성입력
createMicController(
  document.getElementById('eDetailMicBtn'),
  document.getElementById('eDetailMicStatus'),
  eDetail,
  '누르고 말하면 메모에 추가돼요',
  { append: true }
);

function openEditCard(id) {
  const alarm = alarms.find((a) => a.id === id);
  if (!alarm) return;
  editingId = id;
  eDate.value = alarm.dateISO;
  eTime.value = alarm.time;
  eTitle.value = alarm.title;
  eDetail.value = alarm.detail || '';
  eDetailCount.textContent = `${eDetail.value.length}/1000`;
  editCard.classList.remove('hidden');
  editCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('editCancelBtn').addEventListener('click', () => {
  editingId = null;
  editCard.classList.add('hidden');
});

document.getElementById('editSaveBtn').addEventListener('click', () => {
  if (!editingId) return;
  if (!eDate.value || !eTime.value) {
    alert('날짜와 시간을 확인해주세요.');
    return;
  }
  const alarm = alarms.find((a) => a.id === editingId);
  if (!alarm) return;
  alarm.dateISO = eDate.value;
  alarm.time = eTime.value;
  alarm.title = eTitle.value.trim() || '(제목 없음)';
  alarm.detail = eDetail.value.trim();
  alarm.notified = false;
  alarms.sort((a, b) => `${a.dateISO}${a.time}`.localeCompare(`${b.dateISO}${b.time}`));
  saveAlarms(alarms);

  editingId = null;
  editCard.classList.add('hidden');
  renderCalendar();
});

renderCalendar();

// ---------- 알람 발생 체크 (페이지가 열려 있는 동안만 동작) ----------
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

const alarmBanner = document.getElementById('alarmBanner');
const alarmBannerTitle = document.getElementById('alarmBannerTitle');
document.getElementById('alarmBannerClose').addEventListener('click', () => {
  alarmBanner.classList.add('hidden');
});

function checkAlarms() {
  const now = new Date();
  const nowISO = toISODateLocal(now);
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let changed = false;
  alarms.forEach((a) => {
    if (!a.notified && a.dateISO === nowISO && a.time === nowHHMM) {
      a.notified = true;
      changed = true;
      triggerAlarm(a);
    }
  });
  if (changed) saveAlarms(alarms);
}

function toISODateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function triggerAlarm(alarm) {
  alarmBannerTitle.textContent = `⏰ ${alarm.time} ${alarm.title}`;
  alarmBanner.classList.remove('hidden');

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('현장 메모 알람', { body: alarm.title });
  }

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => osc.stop(), 400);
  } catch (e) {
    /* 오디오 재생 불가 환경은 무시 */
  }
}

setInterval(checkAlarms, 15000);

// ---------- 인식 보정 커스텀 단어 ----------
const CUSTOM_WORDS_KEY = 'dream_custom_words_v1';

function loadCustomWords() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_WORDS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveCustomWords(words) {
  localStorage.setItem(CUSTOM_WORDS_KEY, JSON.stringify(words));
}

function renderCustomWordList() {
  const listEl = document.getElementById('customWordList');
  const words = loadCustomWords();
  listEl.innerHTML = words
    .map(
      (w) => `
        <span class="word-chip">${escapeHtml(w)}<button data-word="${escapeHtml(w)}">✕</button></span>`
    )
    .join('');

  listEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const remaining = loadCustomWords().filter((w) => w !== btn.dataset.word);
      saveCustomWords(remaining);
      renderCustomWordList();
    });
  });
}

document.getElementById('customWordAddBtn').addEventListener('click', () => {
  const input = document.getElementById('customWordInput');
  const word = input.value.trim();
  if (!word) return;
  const words = loadCustomWords();
  if (!words.includes(word)) {
    words.push(word);
    saveCustomWords(words);
    renderCustomWordList();
  }
  input.value = '';
});

renderCustomWordList();

// ---------- 자료검색: 업로드 ----------
const DOC_ITEMS_KEY = 'dream_doc_items_v1';

function loadDocItems() {
  try {
    return JSON.parse(localStorage.getItem(DOC_ITEMS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveDocItems(items) {
  localStorage.setItem(DOC_ITEMS_KEY, JSON.stringify(items));
}

let docItems = loadDocItems();

// 스캔 PDF/사진 원본 파일 보관용 (localStorage는 용량이 작아 IndexedDB 사용)
function openFileDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dream_files_v1', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFileBlob(id, file) {
  const db = await openFileDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(file, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getFileBlob(id) {
  const db = await openFileDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const rq = tx.objectStore('files').get(id);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

// 업로드한 문서 내용에서 영문 전문용어를 뽑아 인식 보정 단어로 자동 등록한다.
// (음성인식이 가장 자주 틀리는 게 영문 용어라서 영문/기호 조합만 추출, 자주 나온 순 최대 30개)
const TERM_STOPWORDS = ['THE', 'AND', 'FOR', 'NOT', 'TON', 'OPEN', 'HIGH', 'LOW', 'RISK', 'PROCESS', 'POINT', 'CHECK'];

function extractTechTerms(texts) {
  const freq = new Map();
  const termRegex = /[A-Za-z][A-Za-z0-9]*(?:[\-/.][A-Za-z0-9]+)*/g;
  texts.forEach((t) => {
    (t.match(termRegex) || []).forEach((w) => {
      if (w.length < 3) return;
      if (/^no\.?\d*$/i.test(w)) return;
      if (TERM_STOPWORDS.includes(w.toUpperCase())) return;
      const key = w.toUpperCase();
      const entry = freq.get(key) || { count: 0, form: w };
      entry.count++;
      if (w === w.toUpperCase()) entry.form = w;
      freq.set(key, entry);
    });
  });
  return [...freq.values()].sort((a, b) => b.count - a.count).map((e) => e.form);
}

function autoRegisterWordsFromItems(newItems) {
  const texts = [];
  newItems.forEach((it) => {
    texts.push(it.task || '');
    (it.hazards || []).forEach((h) => texts.push(h));
    (it.measures || []).forEach((m) => texts.push(m));
    (it.lines || []).forEach((l) => texts.push(l));
  });

  const terms = extractTechTerms(texts);
  const words = loadCustomWords();
  let added = 0;
  for (const term of terms) {
    if (added >= 30) break;
    if (!words.some((w) => w.toUpperCase() === term.toUpperCase())) {
      words.push(term);
      added++;
    }
  }
  if (added > 0) {
    saveCustomWords(words);
    renderCustomWordList();
  }
  return added;
}

const TITLE_ONLY_SOURCE = '스캔/사진 파일 (제목으로 검색)';

async function registerTitleOnlyFile(file, uploadStatus, note) {
  const id = `file_${Date.now()}`;
  await saveFileBlob(id, file);
  const title = file.name.replace(/\.[^.]+$/, '');

  docItems = docItems
    .filter((d) => !(d.titleOnly && d.task === title))
    .concat([{ id, source: TITLE_ONLY_SOURCE, task: title, titleOnly: true }]);
  autoRegisterWordsFromItems([{ task: title }]);
  saveDocItems(docItems);
  renderDocList();
  uploadStatus.textContent = note;
}

// 사진 파일: 글자를 인식(OCR)해서 내용으로 검색되게 등록한다.
// 글자를 하나도 못 읽으면 예전처럼 제목으로만 검색되게 등록한다.
async function registerImageWithOcr(file, uploadStatus) {
  const title = file.name.replace(/\.[^.]+$/, '');
  let lines = [];

  try {
    uploadStatus.textContent = '사진에서 글자를 인식하고 있어요... (처음엔 준비에 몇 초 걸려요)';
    lines = await ocrImageToLines(file, (pct) => {
      uploadStatus.textContent = `사진에서 글자를 인식하고 있어요... ${pct}%`;
    });
  } catch (err) {
    lines = [];
  } finally {
    ocrShutdown();
  }

  if (lines.length === 0) {
    await registerTitleOnlyFile(file, uploadStatus, `사진에서 글자를 찾지 못했어요. "${file.name}" 제목으로 검색되게 등록했어요.`);
    return;
  }

  const id = `file_${Date.now()}`;
  await saveFileBlob(id, file);
  const newItem = { id, source: file.name, task: title, lines, fileId: id };

  // 같은 파일을 다시 올리면 이전 등록(제목만 등록 포함)을 교체한다
  docItems = docItems
    .filter((d) => d.source !== file.name && !(d.titleOnly && d.task === title))
    .concat([newItem]);
  saveDocItems(docItems);
  renderDocList();

  const addedWords = autoRegisterWordsFromItems([newItem]);
  uploadStatus.textContent =
    `사진 "${file.name}"에서 ${lines.length}줄을 인식해 검색되게 등록했어요.` +
    (addedWords > 0 ? ` (인식 보정 단어 ${addedWords}개 자동 추가)` : '');
}

document.getElementById('docFileUploadBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('docFileInput');
  const uploadStatus = document.getElementById('docUploadStatus');
  const file = fileInput.files[0];

  if (!file) {
    alert('파일을 선택해주세요.');
    return;
  }

  try {
    let extracted = [];
    let isPdf = false;

    if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name)) {
      // 사진/그림 파일: 글자를 인식(OCR)해서 내용으로도 검색되게 등록
      await registerImageWithOcr(file, uploadStatus);
      fileInput.value = '';
      return;
    }

    if (/\.xlsx?$/i.test(file.name)) {
      uploadStatus.textContent = '엑셀 파일을 분석하고 있어요... (수 초 걸릴 수 있어요)';
      const buffer = await file.arrayBuffer();
      extracted = await parseXlsxRiskDocument(buffer);
    } else if (/\.pdf$/i.test(file.name)) {
      isPdf = true;
      uploadStatus.textContent = 'PDF를 분석하고 있어요... (수 초 걸릴 수 있어요)';
      const buffer = await file.arrayBuffer();
      const pages = await parsePdfDocument(buffer);
      extracted = pages.map((pg) => ({ task: `${pg.page}페이지`, lines: pg.lines }));
    } else {
      extracted = parseRiskDocument(await file.text());
    }

    if (extracted.length === 0) {
      if (isPdf) {
        // 스캔형 PDF: 페이지를 그림으로 그려서 글자를 인식(OCR)한다
        uploadStatus.textContent = '스캔 PDF네요. 사진에서 글자를 인식해볼게요... (처음엔 준비에 몇 초 걸려요)';
        let ocrPages = [];
        try {
          ocrPages = await ocrPdfToPages(file, (msg) => {
            uploadStatus.textContent = msg;
          });
        } catch (err) {
          ocrPages = [];
        } finally {
          ocrShutdown();
        }

        if (ocrPages.length === 0) {
          await registerTitleOnlyFile(file, uploadStatus, `스캔 PDF에서 글자를 읽지 못했어요. "${file.name}" 제목으로 검색되게 등록했어요.`);
          fileInput.value = '';
          return;
        }

        // 원본 PDF도 보관해서 "원본 열기"로 볼 수 있게 한다
        const fid = `file_${Date.now()}`;
        await saveFileBlob(fid, file);
        extracted = ocrPages.map((pg) => ({ task: `${pg.page}페이지 (사진에서 인식)`, lines: pg.lines, fileId: fid }));
      } else {
        uploadStatus.textContent = '문서에서 항목을 찾지 못했어요. 형식을 확인해주세요.';
        return;
      }
    }

    const sourceName = file.name;
    const newItems = extracted.map((it, idx) => ({
      id: `${Date.now()}_${idx}`,
      source: sourceName,
      task: it.task,
      ...(it.lines ? { lines: it.lines } : { hazards: it.hazards || [], measures: it.measures || [] }),
      ...(it.fileId ? { fileId: it.fileId } : {}),
    }));

    // 같은 파일을 다시 올리면 이전 내용을 교체한다
    docItems = docItems.filter((d) => d.source !== sourceName).concat(newItems);
    saveDocItems(docItems);
    renderDocList();

    const addedWords = autoRegisterWordsFromItems(newItems);
    uploadStatus.textContent =
      `"${sourceName}"에서 ${newItems.length}개 목차를 등록했어요.` +
      (addedWords > 0 ? ` (인식 보정 단어 ${addedWords}개 자동 추가)` : '');
    fileInput.value = '';
  } catch (e) {
    uploadStatus.textContent = `파일 처리 중 오류: ${e.message}`;
  }
});

// ---------- 자료검색: 목차 + 검색 ----------
const docSearchInput = document.getElementById('docSearchInput');
const docSearchStatus = document.getElementById('docSearchStatus');

// 자료검색 탭 전용 마이크 (말하면 바로 검색됨)
createMicController(
  document.getElementById('docMicBtn'),
  document.getElementById('docMicStatus'),
  docSearchInput,
  ''
);

function docItemHtml(item, options = {}) {
  const { open = false, partial = false, hitHazards = [], hitMeasures = [], hitLines = [] } = options;

  // 제목만 등록된 파일(스캔 PDF/사진): 제목 + 열기 버튼
  if (item.titleOnly) {
    return `
      <div class="doc-item file-item">
        <span class="event-title">📎 ${escapeHtml(item.task)}</span>
        <button class="open-file-btn ghost-btn" data-fileid="${item.id}">열기</button>
      </div>`;
  }

  // PDF 페이지 항목: 줄 목록만 표시
  if (item.lines) {
    const lines = partial ? hitLines : item.lines;
    const linesHtml = lines
      .map((l) => `<li class="${partial ? 'hit-line' : ''}">${escapeHtml(l)}</li>`)
      .join('');
    const countLabel = partial ? `일치 ${lines.length}건` : `내용 ${item.lines.length}줄`;
    return `
      <details class="doc-item" ${open ? 'open' : ''}>
        <summary>${escapeHtml(item.task)}<span class="doc-counts">${countLabel}</span></summary>
        <div class="doc-body">
          <ul class="result-list">${linesHtml}</ul>
          ${partial ? '<p class="doc-note">검색어와 일치한 줄만 표시했어요.</p>' : ''}
          ${item.fileId ? `<button class="open-file-btn ghost-btn" data-fileid="${item.fileId}">원본 열기</button>` : ''}
        </div>
      </details>`;
  }

  // partial: 검색어와 일치한 줄만 보여준다 / 아니면 전체 표시
  const hazards = partial ? hitHazards : item.hazards;
  const measures = partial ? hitMeasures : item.measures;

  const hazardsHtml = hazards
    .map((h) => `<li class="${partial ? 'hit-line' : ''}">${escapeHtml(h)}</li>`)
    .join('');
  const measuresHtml = measures
    .map((m) => `<li class="${partial ? 'hit-line' : ''}">${escapeHtml(m)}</li>`)
    .join('');

  const countLabel = partial
    ? `일치 ${hazards.length + measures.length}건`
    : `위험 ${item.hazards.length} · 대책 ${item.measures.length}`;

  return `
    <details class="doc-item" ${open ? 'open' : ''}>
      <summary>${escapeHtml(item.task)}<span class="doc-counts">${countLabel}</span></summary>
      <div class="doc-body">
        ${hazards.length ? `<h4>위험요소</h4><ul class="result-list">${hazardsHtml}</ul>` : ''}
        ${measures.length ? `<h4>안전대책</h4><ul class="result-list">${measuresHtml}</ul>` : ''}
        ${partial ? '<p class="doc-note">검색어와 일치한 줄만 표시했어요.</p>' : ''}
      </div>
    </details>`;
}

// 결과 내 검색: 검색 결과에 나온 파일들로 범위를 좁혀서 다시 검색할 수 있다
let docSearchScope = null;

function updateScopeBar(resultSources) {
  const bar = document.getElementById('docScopeBar');

  if (docSearchScope) {
    const names = docSearchScope.join(', ');
    bar.innerHTML = `
      <span class="scope-chip">
        <span class="scope-chip-text">📌 결과 내 검색 중 (${escapeHtml(names)})</span>
        <button id="scopeClearBtn" type="button">✕ 해제</button>
      </span>`;
    bar.querySelector('#scopeClearBtn').addEventListener('click', () => {
      docSearchScope = null;
      renderDocList();
    });
    return;
  }

  if (resultSources && resultSources.length > 0) {
    bar.innerHTML = `<button id="scopeSetBtn" type="button" class="ghost-btn scope-btn">📌 이 결과 내에서 다시 검색</button>`;
    bar.querySelector('#scopeSetBtn').addEventListener('click', () => {
      docSearchScope = resultSources;
      docSearchInput.value = '';
      renderDocList();
      docSearchInput.focus();
    });
    return;
  }

  bar.innerHTML = '';
}

function renderDocList() {
  const listEl = document.getElementById('docList');
  docItems = loadDocItems();

  const query = docSearchInput.value.trim();

  if (docItems.length === 0) {
    docSearchStatus.textContent = '';
    updateScopeBar(null);
    listEl.innerHTML = '<p class="empty-state">업로드된 자료가 없어요. 위에서 파일을 올려보세요.</p>';
    return;
  }

  // 결과 내 검색이 켜져 있으면 해당 파일들만 대상으로 한다
  const baseItems = docSearchScope
    ? docItems.filter((d) => docSearchScope.includes(d.source))
    : docItems;

  if (!query) {
    docSearchStatus.textContent = docSearchScope
      ? `결과 내 검색: ${baseItems.length}개 목차에서 검색어를 입력하세요`
      : `전체 ${docItems.length}개 목차 (누르면 펼쳐집니다)`;
    updateScopeBar(null);
    const bySource = {};
    baseItems.forEach((d) => {
      if (!bySource[d.source]) bySource[d.source] = [];
      bySource[d.source].push(d);
    });
    listEl.innerHTML = Object.keys(bySource)
      .map((source) => {
        const items = bySource[source].map((it) => docItemHtml(it)).join('');
        return `<div class="date-group"><h3 class="date-header">${escapeHtml(source)}</h3>${items}</div>`;
      })
      .join('');
    return;
  }

  const results = searchDocItems(query, baseItems);
  if (results.length === 0) {
    docSearchStatus.textContent = docSearchScope
      ? `결과 내에서 "${query}" 검색 결과가 없어요.`
      : `"${query}" 검색 결과가 없어요.`;
    updateScopeBar(null);
    listEl.innerHTML = '';
    return;
  }

  // 파일별로 묶어서 요약(접힌 상태)으로 보여주고, 누르면 펼쳐진다
  const bySource = {};
  results.forEach((r) => {
    if (!bySource[r.item.source]) bySource[r.item.source] = [];
    bySource[r.item.source].push(r);
  });

  const scopeLabel = docSearchScope ? '결과 내 ' : '';
  docSearchStatus.textContent = `${scopeLabel}"${query}" 검색 결과 ${results.length}건 · 파일 ${Object.keys(bySource).length}개 (눌러서 펼쳐보세요)`;
  updateScopeBar(Object.keys(bySource));
  listEl.innerHTML = Object.keys(bySource)
    .map((source) => {
      const inner = bySource[source]
        .map((r) => docItemHtml(r.item, { open: false, partial: r.partial, hitHazards: r.hitHazards, hitMeasures: r.hitMeasures, hitLines: r.hitLines || [] }))
        .join('');
      return `<div class="date-group"><h3 class="date-header">${escapeHtml(source)} <span class="doc-counts">${bySource[source].length}건</span></h3>${inner}</div>`;
    })
    .join('');
}

// 제목만 등록된 파일 "열기" 버튼 (목록이 다시 그려져도 동작하도록 위임 방식)
document.getElementById('docList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.open-file-btn');
  if (!btn) return;
  try {
    const file = await getFileBlob(btn.dataset.fileid);
    if (!file) {
      alert('저장된 파일을 찾지 못했어요. 다시 업로드해주세요.');
      return;
    }
    window.open(URL.createObjectURL(file), '_blank');
  } catch (err) {
    alert(`파일을 여는 중 오류: ${err.message}`);
  }
});

docSearchInput.addEventListener('input', renderDocList);

document.getElementById('docSearchClearBtn').addEventListener('click', () => {
  docSearchInput.value = '';
  renderDocList();
});

renderDocList();
