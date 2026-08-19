import { createHash } from 'node:crypto';
import type { TenderBlock, TenderBlockType } from './types';

const CLAUSE_PREFIX_RE = /^(（\d+）|\(\d+\)|（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\)|\d+(?:\.\d+)+(?:[.、)])?|\d{1,3}[.、)]|\d{1,3}(?=\s)|[一二三四五六七八九十]+、)\s*/;

function textOfHtml(raw: string): string {
  return raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function stableBlockId(type: TenderBlockType, start: number, raw: string): string {
  const hash = createHash('sha1').update(`${type}\n${start}\n${raw}`).digest('hex').slice(0, 12);
  return `tb-${hash}`;
}

function clauseNoOf(text: string): string {
  return CLAUSE_PREFIX_RE.exec(text.trim())?.[1] || '';
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const re = /.*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    if (!match[0] && re.lastIndex >= markdown.length) break;
    const raw = match[0].endsWith('\n') ? match[0].slice(0, -1) : match[0];
    lines.push({ text: raw.replace(/\r$/, ''), start: match.index, end: match.index + match[0].length });
    if (re.lastIndex >= markdown.length) break;
  }
  return lines;
}

export function parseTenderBlocks(markdown: string): TenderBlock[] {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = sourceLines(source);
  const blocks: TenderBlock[] = [];
  const headingStack: string[] = [];

  const push = (type: TenderBlockType, raw: string, text: string, start: number, end: number, level = 0) => {
    blocks.push({
      id: stableBlockId(type, start, raw),
      type,
      raw,
      text: text.trim(),
      headingPath: [...headingStack],
      clauseNo: clauseNoOf(text),
      level,
      start,
      end,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.text.trim();
    if (!trimmed) continue;

    if (/<table\b/i.test(trimmed)) {
      const collected = [line.text];
      const start = line.start;
      let end = line.end;
      while (!/<\/table>/i.test(collected[collected.length - 1]) && index + 1 < lines.length) {
        index += 1;
        collected.push(lines[index].text);
        end = lines[index].end;
      }
      const raw = collected.join('\n');
      push('html-table', raw, textOfHtml(raw), start, end);
      continue;
    }

    if (/^\|.*\|\s*$/.test(trimmed)) {
      const collected = [line.text];
      const start = line.start;
      let end = line.end;
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = lines[cursor].text.trim();
        if (!next) {
          cursor += 1;
          continue;
        }
        if (!/^\|.*\|\s*$/.test(next)) break;
        collected.push(lines[cursor].text);
        end = lines[cursor].end;
        index = cursor;
        cursor += 1;
      }
      const raw = collected.join('\n');
      push('markdown-table', raw, raw, start, end);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      headingStack.length = level - 1;
      headingStack[level - 1] = title;
      push('heading', line.text, title, line.start, line.end, level);
      blocks[blocks.length - 1].headingPath = [...headingStack];
      continue;
    }

    const listItem = /^\s*[-*+]\s+(.+)$/.exec(line.text);
    push(listItem ? 'list-item' : 'paragraph', line.text, listItem?.[1] || line.text, line.start, line.end);
  }

  return blocks;
}
