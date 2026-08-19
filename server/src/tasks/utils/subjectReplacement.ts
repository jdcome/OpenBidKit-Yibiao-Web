// 代称替换层：确定性文本替换（落库前对正文 content 应用）。
// 设计见 docs/superpowers/specs/2026-08-10-bid-subject-replacement-design.md §6.3。

export interface SubjectReplacement {
  fullname: string;
  synonyms: string[];
}

// 前后缀黑名单：防止把「非/未/不/无 + synonym」或「synonym + 员/类/们/份/者」这类
// 构成不同词的复合形式误替换。不用全 CJK 边界（会误伤「的+中标人」「和+采购人」）。
const REPLACEMENT_PREFIX_BLOCK = '[非未不无]';
const REPLACEMENT_SUFFIX_BLOCK = '[员类们份者]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRanges(content: string, needle: string): Array<[number, number]> {
  if (!needle) return [];
  const ranges: Array<[number, number]> = [];
  const escaped = escapeRegExp(needle);
  const re = new RegExp(escaped, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    ranges.push([m.index, m.index + needle.length]);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 防止零长度死循环
  }
  return ranges;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * 把代称替换表应用到正文。确定性、幂等：
 * - 入参为空 / content 为空 → 原样返回。
 * - synonym 按长度降序匹配，长同义词优先（避免短者拆解长者）。
 * - 文本中已存在的 fullname 区间受保护，不会被其中的 synonym 二次替换（幂等）。
 * - 前后缀黑名单边界，跳过「非中标人」「中标人员」等复合词。
 */
export function applySubjectReplacement(
  content: string,
  replacements: SubjectReplacement[] | null | undefined,
): string {
  const text = String(content || '');
  if (!text || !replacements || !replacements.length) return text;

  // 收集 (synonym → fullname) 对，剔除空值与自指。
  const pairs: Array<{ synonym: string; fullname: string }> = [];
  for (const r of replacements) {
    const fullname = String(r?.fullname || '').trim();
    if (!fullname) continue;
    const seen = new Set<string>();
    for (const rawSyn of r.synonyms || []) {
      const syn = String(rawSyn || '').trim();
      if (!syn || syn === fullname || seen.has(syn)) continue;
      seen.add(syn);
      pairs.push({ synonym: syn, fullname });
    }
  }
  if (!pairs.length) return text;

  // 按 synonym 长度降序（稳定），长同义词先匹配。
  pairs.sort((a, b) => b.synonym.length - a.synonym.length);

  // Pass 1：保护已存在的 fullname 区间（幂等：不二次替换已替换/已存在的全称）。
  const protectedRanges: Array<[number, number]> = [];
  const fullnames = [...new Set(pairs.map((p) => p.fullname))];
  for (const fn of fullnames) {
    protectedRanges.push(...findRanges(text, fn));
  }

  // Pass 2：收集有效 synonym 匹配（边界 OK、不重叠保护区间、不重叠已记录匹配）。
  const recorded: Array<{ start: number; end: number; replacement: string }> = [];
  for (const { synonym, fullname } of pairs) {
    const re = new RegExp(
      `(?<!${REPLACEMENT_PREFIX_BLOCK})${escapeRegExp(synonym)}(?!${REPLACEMENT_SUFFIX_BLOCK})`,
      'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const range: [number, number] = [m.index, m.index + synonym.length];
      const conflict = protectedRanges.some((p) => rangesOverlap(range, p))
        || recorded.some((r) => rangesOverlap(range, [r.start, r.end]));
      if (!conflict) {
        recorded.push({ start: range[0], end: range[1], replacement: fullname });
      }
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  if (!recorded.length) return text;

  // 按位置排序后拼装输出。
  recorded.sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const r of recorded) {
    if (r.start < cursor) continue; // 防御：跳过交叠残留
    result += text.slice(cursor, r.start) + r.replacement;
    cursor = r.end;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * 归一化替换表（容忍 DB JSON 字符串 / 数组 / 非法输入）。
 * - 非法/空 → []。
 * - 剔除 fullname 空、synonyms 空、synonym 等于 fullname。
 * - synonyms 内去重。
 */
export function normalizeSubjectReplacements(raw: unknown): SubjectReplacement[] {
  let list: unknown;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      list = JSON.parse(trimmed);
    } catch {
      return [];
    }
  } else {
    list = raw;
  }
  if (!Array.isArray(list)) return [];
  const result: SubjectReplacement[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as { fullname?: unknown; synonyms?: unknown };
    const fullname = String(obj.fullname || '').trim();
    if (!fullname) continue;
    const rawSyn = Array.isArray(obj.synonyms) ? obj.synonyms : [];
    const seen = new Set<string>();
    const synonyms: string[] = [];
    for (const s of rawSyn) {
      const syn = String(s ?? '').trim();
      if (!syn || syn === fullname || seen.has(syn)) continue;
      seen.add(syn);
      synonyms.push(syn);
    }
    if (!synonyms.length) continue;
    result.push({ fullname, synonyms });
  }
  return result;
}

/**
 * 序列化替换表为 DB 字符串。空 → null（避免存 '[]' 噪音）。
 */
export function serializeSubjectReplacements(
  list: SubjectReplacement[] | null | undefined,
): string | null {
  if (!Array.isArray(list) || !list.length) return null;
  return JSON.stringify(list);
}
