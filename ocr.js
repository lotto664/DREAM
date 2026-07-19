// 사진/스캔 PDF의 글자를 읽어내는 OCR 모듈 (Tesseract.js 사용, 완전 로컬 동작).
// 한국어+영어를 함께 인식한다. 처음 실행할 때는 인식 데이터 준비에 몇 초 걸린다.

const OCR_BASE = new URL('lib/tesseract', location.href).href;

let ocrWorkerPromise = null;
let ocrProgressCb = null;

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    if (typeof Tesseract === 'undefined') {
      return Promise.reject(new Error('OCR 라이브러리를 불러오지 못했어요.'));
    }
    ocrWorkerPromise = Tesseract.createWorker('kor+eng', 1, {
      workerPath: `${OCR_BASE}/worker.min.js`,
      corePath: OCR_BASE,
      langPath: OCR_BASE,
      logger: (m) => {
        if (ocrProgressCb && m.status === 'recognizing text') {
          ocrProgressCb(Math.round((m.progress || 0) * 100));
        }
      },
    }).catch((e) => {
      ocrWorkerPromise = null;
      throw e;
    });
  }
  return ocrWorkerPromise;
}

// OCR이 끝나면 호출해서 메모리를 돌려준다 (휴대폰에서 오래 잡고 있으면 무거움)
function ocrShutdown() {
  if (!ocrWorkerPromise) return;
  const p = ocrWorkerPromise;
  ocrWorkerPromise = null;
  ocrProgressCb = null;
  p.then((w) => w.terminate()).catch(() => {});
}

// 인식 결과 텍스트를 검색 가능한 줄 목록으로 정리한다
function ocrTextToLines(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1 && /[가-힣A-Za-z0-9]/.test(l));
}

// 사진 파일에서 글자 줄을 뽑는다
async function ocrImageToLines(file, onProgress) {
  const worker = await getOcrWorker();
  ocrProgressCb = onProgress || null;
  try {
    const { data } = await worker.recognize(file);
    return ocrTextToLines(data.text);
  } finally {
    ocrProgressCb = null;
  }
}

// 스캔 PDF를 페이지별 그림으로 그린 뒤 각 페이지에서 글자 줄을 뽑는다
async function ocrPdfToPages(file, onStatus) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 라이브러리를 불러오지 못했어요.');
  }
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const worker = await getOcrWorker();
  const pages = [];

  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      if (onStatus) onStatus(`${p}/${pdf.numPages} 페이지 글자 인식 중... (페이지당 수 초)`);
      const page = await pdf.getPage(p);

      // 글자가 잘 보이도록 폭 1600px 정도로 크게 그려서 인식한다
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1.5, 1600 / base.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // intent:'print' — 화면이 가려져 있어도(다른 앱 전환 등) 렌더링이 멈추지 않게 한다
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;

      const { data } = await worker.recognize(canvas);
      const lines = ocrTextToLines(data.text);
      if (lines.length) pages.push({ page: p, lines });

      canvas.width = canvas.height = 0;
    }
  } finally {
    pdf.destroy();
  }

  return pages;
}
