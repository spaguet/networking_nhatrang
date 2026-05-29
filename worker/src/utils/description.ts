/** Trim + normalize line endings before encode (matches Code.gs normalizeDescriptionInput). */
export function normalizeDescriptionInput(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** Store newlines as literal `\n` two-char sequence in D1 (matches GAS / Sheets). */
export function encodeDescriptionNewlines(text: unknown): string {
  return normalizeDescriptionInput(text).replace(/\n/g, '\\n');
}

export function decodeDescriptionNewlines(text: unknown): string {
  return String(text ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}
