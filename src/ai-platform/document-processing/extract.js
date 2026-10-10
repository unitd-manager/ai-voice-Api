import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { AppError } from '../../core/errors/app-error.js';

export const ALLOWED_MIME = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt' };
// Verify actual content (magic bytes), not just the client-supplied Content-Type.
export function sniffType(buf) {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'docx'; // zip container; mammoth rejects non-docx
  if (!buf.subarray(0, 4096).includes(0)) return 'txt'; // no NUL bytes ⇒ plausible text
  return null;
}
export function validateUpload(buf, mime) {
  const expected = ALLOWED_MIME[mime];
  if (!expected || sniffType(buf) !== expected) throw AppError.badRequest('Unsupported or mismatched file type');
  return expected;
}
export async function extractText(buf, kind) {
  if (kind === 'txt') return buf.toString('utf8');
  if (kind === 'docx') return (await mammoth.extractRawText({ buffer: buf })).value;
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await parser.getText()).text; } finally { await parser.destroy().catch(() => {}); }
}
