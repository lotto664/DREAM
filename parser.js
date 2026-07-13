// 한국어 구어체 문장에서 날짜/시간/제목을 뽑아내는 파서
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractDate(text, now) {
  let base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (/모레/.test(text)) {
    base.setDate(base.getDate() + 2);
    return { dateISO: toISODate(base), matched: '모레' };
  }
  if (/(내일|명일)/.test(text)) {
    base.setDate(base.getDate() + 1);
    return { dateISO: toISODate(base), matched: RegExp.$1 };
  }
  if (/오늘|금일/.test(text)) {
    return { dateISO: toISODate(base), matched: text.match(/오늘|금일/)[0] };
  }

  const weekdayMatch = text.match(/(이번\s*주|다음\s*주)?\s*(일|월|화|수|목|금|토)요일/);
  if (weekdayMatch) {
    const targetIdx = WEEKDAYS.indexOf(weekdayMatch[2]);
    const curIdx = base.getDay();
    let diff = (targetIdx - curIdx + 7) % 7;
    if (weekdayMatch[1] && weekdayMatch[1].includes('다음')) {
      diff += 7;
    } else if (diff === 0 && !weekdayMatch[1]) {
      // 요일만 말하고 오늘이 그 요일이면 오늘로 처리
    }
    base.setDate(base.getDate() + diff);
    return { dateISO: toISODate(base), matched: weekdayMatch[0] };
  }

  const mdMatch = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10) - 1;
    const day = parseInt(mdMatch[2], 10);
    let target = new Date(base.getFullYear(), month, day);
    if (target < base) target.setFullYear(target.getFullYear() + 1);
    return { dateISO: toISODate(target), matched: mdMatch[0] };
  }

  // 날짜 표현이 없으면 오늘로 기본 처리
  return { dateISO: toISODate(base), matched: null };
}

function extractTime(text) {
  const timeMatch = text.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?/);
  if (!timeMatch) return { time: null, matched: null };

  let hour = parseInt(timeMatch[2], 10);
  const minute = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
  const ampm = timeMatch[1];

  if (ampm === '오후' && hour < 12) hour += 12;
  if (ampm === '오전' && hour === 12) hour = 0;

  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return { time: `${hh}:${mm}`, matched: timeMatch[0] };
}

function extractTitle(text, removals) {
  let title = text;
  removals.filter(Boolean).forEach((r) => {
    title = title.replace(r, '');
  });

  // 명령어성 트리거 단어 제거 (뒤쪽에 붙는 경우가 많음)
  title = title.replace(/(알람|알림|등록해줘|등록해\s*줘|등록|저장해줘|저장|알려줘|잡아줘|맞춰줘|해줘)+\s*$/g, '');
  // 조사/접속어 정리
  title = title.replace(/^(에|에는|,|\s)+/, '');
  title = title.replace(/(에|에는)\s*$/, '');
  title = title.replace(/\s{2,}/g, ' ').trim();
  title = title.replace(/^,|,$/g, '').trim();

  return title || '(제목 없음)';
}

function parseKoreanDateTime(rawText, now = new Date()) {
  const text = rawText.trim();
  const dateResult = extractDate(text, now);
  const timeResult = extractTime(text);
  const title = extractTitle(text, [dateResult.matched, timeResult.matched]);

  return {
    dateISO: dateResult.dateISO,
    time: timeResult.time || '09:00',
    title,
    hasDateTimeCue: Boolean(dateResult.matched || timeResult.matched),
  };
}

// ---------- 자료(위험성평가 등) 문서 파싱: txt/csv ----------
function splitListField(raw) {
  return raw
    .split(/\n|;/)
    .map((s) => s.replace(/^[-*\s]+/, '').trim())
    .filter(Boolean);
}

function parseBlockRiskDocument(text) {
  const chunks = text
    .split(/(?=작업명\s*:)/)
    .map((c) => c.trim())
    .filter(Boolean);

  const items = [];
  chunks.forEach((chunk) => {
    const taskMatch = chunk.match(/작업명\s*:\s*(.*)/);
    if (!taskMatch) return;
    const task = taskMatch[1].trim();

    const hazardsMatch = chunk.match(/위험요소\s*:\s*([\s\S]*?)(?=안전대책\s*:|$)/);
    const measuresMatch = chunk.match(/안전대책\s*:\s*([\s\S]*)/);

    const hazards = hazardsMatch ? splitListField(hazardsMatch[1]) : [];
    const measures = measuresMatch ? splitListField(measuresMatch[1]) : [];

    if (task && (hazards.length || measures.length)) {
      items.push({ task, hazards, measures });
    }
  });
  return items;
}

function parseCsvRiskDocument(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const task = cols[0].trim();
    const hazards = cols[1].split(';').map((s) => s.trim()).filter(Boolean);
    const measures = cols[2].split(';').map((s) => s.trim()).filter(Boolean);
    if (task) items.push({ task, hazards, measures });
  }
  return items;
}

function parseRiskDocument(rawText) {
  const text = rawText.trim();
  if (/^작업명\s*,\s*위험요소\s*,\s*안전대책/.test(text)) {
    return parseCsvRiskDocument(text);
  }
  return parseBlockRiskDocument(text);
}

// ---------- 자료 검색 (단어가 들어간 항목 전부 찾기) ----------
// 영문 표기를 한글 표준 표기로 통일한다. 검색어와 자료 양쪽에 똑같이 적용되므로
// "mould"로 찾든 "몰드"로 찾든 같은 결과가 나온다. (긴 단어를 먼저 치환)
const SEARCH_SYNONYMS = [
  [/leveling|levelling/g, '레벨링'],
  [/level/g, '레벨'],
  [/mould|mold/g, '몰드'],
  [/pipe/g, '파이프'],
  [/square/g, 'sq'],
  [/bolt/g, '볼트'],
  [/drill/g, '드릴'],
  [/filter/g, '필터'],
  [/panel/g, '판넬'],
  [/패널/g, '판넬'],
  [/ceiling/g, '실링'],
  [/system/g, '시스템'],
  [/duct/g, '덕트'],
  [/cable/g, '케이블'],
  [/rope/g, '로프'],
  [/crane/g, '크레인'],
  [/support/g, '서포트'],
  [/frame/g, '프레임'],
  [/anchor/g, '앙카'],
  [/앵커/g, '앙카'],
  [/클린/g, '크린'],
  [/blind/g, '블라인드'],
  [/impact/g, '임팩'],
  [/bar\b/g, '바'],
];

// 영문/한글 혼용 표기(SQ-PIPE ↔ SQ파이프, MOULD ↔ 몰드)와 띄어쓰기/하이픈 차이를 흡수한다
function normalizeForSearch(s) {
  let out = s.toLowerCase();
  SEARCH_SYNONYMS.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  return out.replace(/[\s\-_./()]+/g, '');
}

// AND 검색: 띄어쓰기로 나눈 모든 단어가 포함된 항목/줄만 찾는다.
// 예) "mould 임팩" → 두 단어가 모두 들어간 안전대책 줄을 반환.
// 단어가 작업명과 내용 줄에 나뉘어 있어도(작업명에 mould, 줄에 임팩) 일치로 본다.
function searchDocItems(query, items) {
  const tokens = query.split(/\s+/).map(normalizeForSearch).filter(Boolean);
  if (tokens.length === 0) return [];

  const results = [];
  items.forEach((item) => {
    // 제목만 등록된 파일(스캔 PDF/사진): 파일 제목에 모든 단어가 들어가면 결과에 포함
    if (item.titleOnly) {
      const n = normalizeForSearch(item.task);
      if (tokens.every((t) => n.includes(t))) {
        results.push({ item, hitTask: true, hitHazards: [], hitMeasures: [], partial: false });
      }
      return;
    }

    // PDF 페이지 항목: 줄 단위로만 검색한다
    if (item.lines) {
      const hitLines = item.lines.filter((l) => {
        const n = normalizeForSearch(l);
        return tokens.every((t) => n.includes(t));
      });
      if (hitLines.length) {
        results.push({ item, hitTask: false, hitLines, hitHazards: [], hitMeasures: [], partial: true });
      }
      return;
    }

    const taskNorm = normalizeForSearch(item.task);
    const hitTask = tokens.every((t) => taskNorm.includes(t));

    const lineHits = (line) => {
      const lineNorm = normalizeForSearch(line);
      return tokens.every((t) => lineNorm.includes(t) || taskNorm.includes(t));
    };
    const hitHazards = item.hazards.filter(lineHits);
    const hitMeasures = item.measures.filter(lineHits);

    if (hitTask) {
      // 작업명 자체가 전부 일치 → 항목 전체를 보여준다
      results.push({ item, hitTask: true, hitHazards: item.hazards, hitMeasures: item.measures, partial: false });
    } else if (hitHazards.length || hitMeasures.length) {
      // 내용 줄 단위 일치 → 일치한 줄만 보여준다
      results.push({ item, hitTask: false, hitHazards, hitMeasures, partial: true });
    }
  });
  return results;
}

// ---------- 음성인식 결과 보정 (커스텀 단어) ----------
function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// 등록된 단어와 발음이 비슷한 구간을 찾아 정확한 표기로 치환한다 (사전 등록 단어가 많지 않은 것을 전제로 한 O(n^2) 슬라이딩 매칭).
function applyCustomWordCorrection(text, words) {
  if (!text || !words || words.length === 0) return text;
  let result = text;

  [...words]
    .sort((a, b) => b.length - a.length)
    .forEach((word) => {
      const wlen = word.length;
      let bestStart = -1;
      let bestLen = 0;
      let bestDist = Infinity;

      for (let start = 0; start < result.length; start++) {
        for (let len = Math.max(1, wlen - 2); len <= wlen + 2; len++) {
          if (start + len > result.length) continue;
          const chunk = result.slice(start, start + len);
          if (chunk === word) return;
          const dist = levenshteinDistance(chunk, word);
          if (dist < bestDist) {
            bestDist = dist;
            bestStart = start;
            bestLen = len;
          }
        }
      }

      const threshold = Math.max(1, Math.floor(wlen * 0.4));
      if (bestStart >= 0 && bestDist > 0 && bestDist <= threshold) {
        result = result.slice(0, bestStart) + word + result.slice(bestStart + bestLen);
      }
    });

  return result;
}
