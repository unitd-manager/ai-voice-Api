const luhn = (s) => { let sum = 0, alt = false; for (let i = s.length - 1; i >= 0; i--) { let n = +s[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };

// Redacts emails, card numbers (Luhn-validated) and phone-like numbers before text goes to an LLM or a log.
export function redactPII(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[CARD]' : m))
    .replace(/(?<!\w)\+?\d[\d\s().-]{8,}\d/g, '[PHONE]');
}
const INJECTION = [/ignore (all |any )?(previous|prior|above) (instructions|prompts)/i, /reveal (your )?(system )?prompt/i, /you are now (dan|developer mode)/i, /disregard (the )?(rules|instructions)/i];
export const looksLikePromptInjection = (t) => INJECTION.some((r) => r.test(t));
// Wraps untrusted text so the model treats it as data, not instructions.
export const wrapUntrusted = (label, t) => `<${label}>\n${String(t).replace(/<\/?\w+>/g, '')}\n</${label}>`;
