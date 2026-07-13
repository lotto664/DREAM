// PDF에서 페이지별 텍스트 줄을 추출한다 (pdf.js 사용, 완전 로컬 동작).
// 스캔 이미지 PDF는 글자가 없어서 추출이 안 된다 — 그 경우 안내 메시지를 띄운다.

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}

async function parsePdfDocument(buffer) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 라이브러리를 불러오지 못했어요.');
  }

  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();

    // 같은 세로 위치(y)의 조각들을 한 줄로 묶는다
    const rows = [];
    tc.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 3);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    });

    const lines = rows
      .sort((a, b) => b.y - a.y)
      .map((r) =>
        r.items
          .sort((a, b) => a.transform[4] - b.transform[4])
          .map((i) => i.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter((l) => l.length > 1);

    if (lines.length) pages.push({ page: p, lines });
  }

  return pages;
}
