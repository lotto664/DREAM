// 브라우저에서 서버 없이 xlsx(zip+xml)를 직접 읽어 위험성평가 항목을 추출한다.
// 압축 해제는 브라우저 내장 DecompressionStream 사용 (Chrome 103+, 최신 모바일 브라우저 지원).

async function inflateRawBytes(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function openZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let eocd = -1;
  const scanEnd = Math.max(0, buffer.byteLength - 22 - 65535);
  for (let i = buffer.byteLength - 22; i >= scanEnd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('엑셀(zip) 형식이 아니에요');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = {};
  const nameDecoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = nameDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries[name] = { method, compSize, localOffset };
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, bytes, view };
}

async function readZipEntryText(zip, name) {
  const e = zip.entries[name];
  if (!e) return null;
  const lo = e.localOffset;
  const nameLen = zip.view.getUint16(lo + 26, true);
  const extraLen = zip.view.getUint16(lo + 28, true);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = zip.bytes.subarray(dataStart, dataStart + e.compSize);

  let out;
  if (e.method === 0) out = data;
  else if (e.method === 8) out = await inflateRawBytes(data);
  else throw new Error('지원하지 않는 압축 방식이에요');

  return new TextDecoder().decode(out);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStringsXml(xml) {
  const strings = [];
  if (!xml) return strings;
  const siRegex = /<si>([\s\S]*?)<\/si>/g;
  const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = siRegex.exec(xml)) !== null) {
    let text = '';
    let t;
    tRegex.lastIndex = 0;
    while ((t = tRegex.exec(m[1])) !== null) text += t[1];
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx;
}

function parseSheetRowsXml(xml, sharedStrings) {
  const rows = new Map();
  const rowRegex = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const refRegex = /r="([A-Za-z]+)\d+"/;
  const typeRegex = /t="(\w+)"/;
  const vRegex = /<v>([\s\S]*?)<\/v>/;
  const isRegex = /<is>([\s\S]*?)<\/is>/;
  const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowNum = parseInt(rowMatch[1], 10);
    const cells = new Map();
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[2])) !== null) {
      const attrs = cellMatch[1];
      const refM = refRegex.exec(attrs);
      if (!refM) continue;
      const content = cellMatch[2];
      if (!content) continue;

      const typeM = typeRegex.exec(attrs);
      let val = null;
      if (typeM && typeM[1] === 's') {
        const vm = vRegex.exec(content);
        if (vm) val = sharedStrings[parseInt(vm[1], 10)];
      } else if (typeM && typeM[1] === 'inlineStr') {
        const im = isRegex.exec(content);
        if (im) {
          let text = '';
          let t;
          tRegex.lastIndex = 0;
          while ((t = tRegex.exec(im[1])) !== null) text += t[1];
          val = text;
        }
      } else {
        const vm = vRegex.exec(content);
        if (vm) val = vm[1];
      }

      if (val) {
        cells.set(colLettersToIndex(refM[1]), decodeXmlEntities(val).trim());
      }
    }
    if (cells.size > 0) rows.set(rowNum, cells);
  }
  return rows;
}

function findHeaderInfoJs(rows) {
  const sorted = [...rows.keys()].sort((a, b) => a - b);
  const limit = Math.min(80, sorted.length);
  for (let i = 0; i < limit; i++) {
    const cells = rows.get(sorted[i]);
    let noCol = null;
    let taskCol = null;
    let hazardCol = null;
    let measureCol = null;
    for (const [col, v] of cells) {
      if (!noCol && /^\s*(순서|번호|no)\s*$/i.test(v)) noCol = col;
      if (!taskCol && /작업\s*(단계|명|내용)|공정/.test(v)) taskCol = col;
      if (!hazardCol && /유해위험요인|위험\s*요[인소]/.test(v)) hazardCol = col;
      if (!measureCol && /위험성\s*감소대책|안전\s*대책|저감대책|개선대책/.test(v)) measureCol = col;
    }
    if (measureCol && (taskCol || hazardCol)) {
      return { headerRow: sorted[i], noCol, taskCol, hazardCol, measureCol, headerCols: [...cells.keys()].sort((a, b) => a - b) };
    }
  }
  return null;
}

function nextHeaderCol(headerCols, col) {
  for (const hc of headerCols) if (hc > col) return hc;
  return col + 10;
}

function findBestDataColumnJs(rows, headerRow, approxCol, upperBound, maxRow) {
  let best = approxCol;
  let bestCount = -1;
  const sampleEnd = Math.min(maxRow, headerRow + 500);
  for (let col = approxCol; col <= upperBound; col++) {
    let count = 0;
    for (let r = headerRow + 1; r <= sampleEnd; r++) {
      const cells = rows.get(r);
      if (cells && cells.has(col)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = col;
    }
  }
  return best;
}

function extractRiskItemsFromRows(rows) {
  if (rows.size === 0) return [];
  const maxRow = Math.max(...rows.keys());

  const header = findHeaderInfoJs(rows);
  if (!header) return [];

  let noCol = null;
  let taskCol = null;
  let hazardCol = null;
  if (header.noCol) {
    noCol = findBestDataColumnJs(rows, header.headerRow, header.noCol, nextHeaderCol(header.headerCols, header.noCol) - 1, maxRow);
  }
  if (header.taskCol) {
    taskCol = findBestDataColumnJs(rows, header.headerRow, header.taskCol, nextHeaderCol(header.headerCols, header.taskCol) - 1, maxRow);
  }
  if (header.hazardCol) {
    hazardCol = findBestDataColumnJs(rows, header.headerRow, header.hazardCol, nextHeaderCol(header.headerCols, header.hazardCol) - 1, maxRow);
  }
  const measureCol = findBestDataColumnJs(rows, header.headerRow, header.measureCol, nextHeaderCol(header.headerCols, header.measureCol) - 1, maxRow);

  const groups = new Map();
  let lastTask = null;
  let lastHazard = null;

  for (let r = header.headerRow + 1; r <= maxRow; r++) {
    const cells = rows.get(r);
    if (!cells) continue;

    // 페이지마다 반복되는 표 머리글 행은 건너뛴다
    const taskVal = taskCol ? cells.get(taskCol) : null;
    if (taskVal && /^\s*작업\s*(단계|명|내용)/.test(taskVal)) continue;
    const measureValRaw = cells.get(measureCol);
    if (measureValRaw && /^\s*위험성\s*감소대책/.test(measureValRaw)) continue;

    if (taskVal) lastTask = taskVal;
    if (hazardCol && cells.has(hazardCol)) lastHazard = cells.get(hazardCol);

    if (!lastTask) continue;

    if (!groups.has(lastTask)) {
      groups.set(lastTask, { hazards: [], measures: [] });
    }
    const g = groups.get(lastTask);
    if (lastHazard && !g.hazards.includes(lastHazard)) g.hazards.push(lastHazard);
    if (measureValRaw) {
      // 엑셀 첫 열의 순서 번호를 앞에 붙여, 원본 표에서 바로 찾을 수 있게 한다
      const no = noCol ? cells.get(noCol) : null;
      g.measures.push(no && /^\d+$/.test(no) ? `${no}. ${measureValRaw}` : measureValRaw);
    }
  }

  const items = [];
  for (const [task, g] of groups) {
    if (g.hazards.length === 0 && g.measures.length === 0) continue;
    items.push({ task, hazards: g.hazards, measures: g.measures });
  }
  return items;
}

// 엑셀 파일(ArrayBuffer) → 항목 배열. 여러 시트 중 가장 항목이 많은 시트를 채택한다.
async function parseXlsxRiskDocument(buffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('이 브라우저는 엑셀 분석을 지원하지 않아요. 크롬 최신 버전을 사용해주세요.');
  }
  const zip = openZip(buffer);
  const sharedStrings = parseSharedStringsXml(await readZipEntryText(zip, 'xl/sharedStrings.xml'));

  let bestItems = [];
  for (const name of Object.keys(zip.entries)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await readZipEntryText(zip, name);
    if (!xml) continue;
    const rows = parseSheetRowsXml(xml, sharedStrings);
    const items = extractRiskItemsFromRows(rows);
    if (items.length > bestItems.length) bestItems = items;
  }
  return bestItems;
}
