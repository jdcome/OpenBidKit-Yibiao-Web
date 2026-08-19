import type { AiResponseShapeSummary } from './types';

export const MAX_DIAGNOSTIC_RESPONSE_BYTES = 60 * 1024;

export function truncateUtf8(value: unknown, maxBytes = MAX_DIAGNOSTIC_RESPONSE_BYTES): string {
  const source = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const buffer = Buffer.from(source, 'utf8');
  if (buffer.length <= limit) return source;
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function sanitizeDiagnosticText(value: unknown): string {
  let text = String(value ?? '');
  text = text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|authorization|cookie|access[_-]?token|secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/postgres(?:ql)?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, 'postgresql://[REDACTED]@');
  return truncateUtf8(text);
}

function shapeType(value: unknown): AiResponseShapeSummary['type'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (['object', 'string', 'number', 'boolean', 'undefined'].includes(type)) return type as AiResponseShapeSummary['type'];
  return 'other';
}

export function summarizeResponseShape(value: unknown): AiResponseShapeSummary {
  const type = shapeType(value);
  if (type === 'array') return { type, length: (value as unknown[]).length };
  if (type !== 'object') return typeof value === 'string' ? { type, length: value.length } : { type };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const fields = Object.fromEntries(keys.map((key) => {
    const item = record[key];
    const itemType = shapeType(item);
    const length = Array.isArray(item) || typeof item === 'string' ? item.length : undefined;
    return [key, length === undefined ? { type: itemType } : { type: itemType, length }];
  }));
  return { type, keys, fields };
}
