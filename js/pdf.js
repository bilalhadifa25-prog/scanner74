// Minimal PDF writer: one JPEG per page, no watermark, no external library.

const enc = new TextEncoder();

function utf16Hex(str) {
  let hex = 'FEFF';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };

/**
 * pages: [{ jpeg: Uint8Array, width, height }]
 * opts: { size: 'a4'|'letter'|'legal'|'fit', margin (pt), title }
 */
export function buildPdf(pages, opts = {}) {
  const size = opts.size || 'a4';
  const margin = size === 'fit' ? 0 : opts.margin ?? 0;
  const chunks = []; let offset = 0; const offsets = [];
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); offset += b.length; };
  const obj = (n, body) => { offsets[n] = offset; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  const N = pages.length;
  // object numbers: 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const pageNum = (i) => 4 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${N} /Kids [${pages.map((_, i) => `${pageNum(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title ${utf16Hex(opts.title || 'Scan')} /Producer (Scanner 74) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`));

  pages.forEach((p, i) => {
    let pw, ph;
    if (size === 'fit') {
      // 150 dpi equivalent keeps the page a sensible physical size
      pw = (p.width * 72) / 150; ph = (p.height * 72) / 150;
    } else {
      [pw, ph] = SIZES[size];
      if (p.width > p.height) [pw, ph] = [ph, pw]; // landscape pages stay landscape
    }
    const aw = pw - margin * 2, ah = ph - margin * 2;
    const s = Math.min(aw / p.width, ah / p.height);
    const dw = p.width * s, dh = p.height * s;
    const dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    const n = pageNum(i);
    const content = `q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    obj(n, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
    obj(n + 1, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('endstream'); });
    obj(n + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg); push('\nendstream');
    });
  });

  const total = 4 + N * 3;
  const xref = offset;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
