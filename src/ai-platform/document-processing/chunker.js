// Paragraph-aware chunker with character budget and overlap. Pure function.
export function chunkText(text, { size = 1000, overlap = 150 } = {}) {
  if (overlap >= size) throw new Error('overlap must be smaller than size');
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n/).flatMap((p) => { // hard-split oversized paragraphs
    if (p.length <= size) return [p];
    const parts = []; for (let i = 0; i < p.length; i += size - overlap) parts.push(p.slice(i, i + size)); return parts;
  });
  const chunks = []; let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { chunks.push(cur); cur = cur.slice(-overlap) + '\n\n' + p; if (cur.length > size) cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
