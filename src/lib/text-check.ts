/**
 * 标点规范检查（纯前端，仅检查译文 text，不查日文原文）。
 * 不阻塞导出/翻译，仅提示；fixable 的规则可一键自动修复。
 * fixable 规则：省略号 / 多余空行 / 首尾空白 / 半角标点全角化。
 */

export type TextIssue = {
  /** 规则短名 */
  rule: string;
  /** 提示内容 */
  message: string;
  /** 是否可自动修复（仅省略号/多余空行/首尾空白三类） */
  fixable: boolean;
  /** 命中片段预览 */
  snippet: string;
  /** 自动修复函数（fixable 时提供） */
  apply?: (text: string) => string;
};

/** 取命中位置附近的片段预览 */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + length + 8);
  const body = text.slice(start, end).replace(/\n/g, '⏎');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** 规则 1：省略号不规范（。。。 / ... / 。… 等任意 ≥3 连续句点类）→ 应为「……」 */
function checkEllipsis(text: string, issues: TextIssue[]): void {
  const re = /[。.…]{3,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    issues.push({
      rule: '省略号',
      message: `「${match[0]}」不规范，应为「……」`,
      fixable: true,
      snippet: snippetAround(text, match.index, match[0].length),
      apply: (t) => t.replace(/[。.…]{3,}/g, '……'),
    });
  }
}

/** 规则 2：多余空行（连续 ≥2 个空行 → 压成 1 个） */
function checkBlankLines(text: string, issues: TextIssue[]): void {
  // 三个及以上连续换行 = 至少两个空行
  if (/(?:\n[ \t\u3000]*){2,}\n/.test(text)) {
    issues.push({
      rule: '多余空行',
      message: '存在连续空行，建议压缩为一个空行',
      fixable: true,
      snippet: snippetAround(text, text.search(/(?:\n[ \t\u3000]*){2,}\n/), 6),
      apply: (t) => {
        // 逐行扫描：连续空行只保留一个
        const lines = t.split('\n');
        const out: string[] = [];
        let blankRun = 0;
        for (const line of lines) {
          if (line.trim() === '') {
            blankRun += 1;
            if (blankRun <= 1) out.push(line);
          } else {
            blankRun = 0;
            out.push(line);
          }
        }
        return out.join('\n');
      },
    });
  }
}

/** 规则 3：行首/行尾空白、行首全角空格 */
function checkEdgeSpaces(text: string, issues: TextIssue[]): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[ \t\u3000]/.test(line) || /[ \t]$/.test(line)) {
      issues.push({
        rule: '首尾空白',
        message: `第 ${i + 1} 行行首/行尾有多余空白${/^\u3000/.test(line) ? '（含全角空格）' : ''}`,
        fixable: true,
        snippet: line.trim() ? snippetAround(line, 0, Math.min(line.length, 12)) : `第 ${i + 1} 行（空白行）`,
        apply: (t) =>
          t
            .split('\n')
            .map((row) => row.replace(/^[ \t\u3000]+/, '').replace(/[ \t]+$/, ''))
            .join('\n'),
      });
      break; // 同类问题一条就够，修复时统一处理
    }
  }
}

/** 规则 4：中英标点混用（同时出现全角+半角逗号/句号），仅提示 */
/**
 * 找第一个「真混用」的半角句号位置（非省略号且非小数点）：
 * 前后均为数字视为小数点（3.14 / U.S. 语境两侧非数字但属英文缩写，由 CJK 判定兜底不了，
 * 这里仅排除小数点），「你好。3.14 结束」不算混用。返回 -1 表示没有。
 */
function findMixedPeriodIndex(text: string): number {
  let from = 0;
  for (;;) {
    const index = text.slice(from).search(/(?<!\.)\.(?!\.)/);
    if (index < 0) return -1;
    const abs = from + index;
    const prev = text[abs - 1];
    const next = text[abs + 1];
    if (!/\d/.test(prev ?? '') || !/\d/.test(next ?? '')) return abs;
    from = abs + 1;
  }
}

function checkMixedPunctuation(text: string, issues: TextIssue[]): void {
  if (text.includes('，') && text.includes(',')) {
    issues.push({
      rule: '标点混用',
      message: '同时使用了全角逗号「，」与半角逗号「,」',
      fixable: false,
      snippet: snippetAround(text, text.indexOf(','), 1),
    });
  }
  if (text.includes('。')) {
    const periodIndex = findMixedPeriodIndex(text);
    if (periodIndex >= 0) {
      issues.push({
        rule: '标点混用',
        message: '同时使用了全角句号「。」与半角句号「.」（小数点除外）',
        fixable: false,
        snippet: snippetAround(text, periodIndex, 1),
      });
    }
  }
}

/** 规则 5：引号不配对（“”、『』、《》数量不等），仅提示 */
function checkQuotes(text: string, issues: TextIssue[]): void {
  const pairs: Array<[string, string, string]> = [
    ['“', '”', '引号'],
    ['『', '』', '直角引号'],
    ['《', '》', '书名号'],
  ];
  for (const [open, close, name] of pairs) {
    const openCount = text.split(open).length - 1;
    const closeCount = text.split(close).length - 1;
    if (openCount !== closeCount) {
      issues.push({
        rule: '引号不配对',
        message: `${name}「${open}」×${openCount} 与「${close}」×${closeCount} 数量不等`,
        fixable: false,
        snippet: snippetAround(text, Math.max(text.indexOf(open), text.indexOf(close), 0), 1),
      });
    }
  }
}

/** 规则 6：同一标点连续重复 ≥2（！！/？？ 等），仅提示 */
function checkRepeatedPunctuation(text: string, issues: TextIssue[]): void {
  const match = text.match(/[！？!?]{2,}/);
  if (match) {
    issues.push({
      rule: '重复标点',
      message: `「${match[0]}」同一标点连续重复`,
      fixable: false,
      snippet: snippetAround(text, text.indexOf(match[0]), match[0].length),
    });
  }
}

/** 半角 → 全角直转表：无论上下文直接转（，！？；：） */
const HALF_TO_FULL: Record<string, string> = {
  ',': '，',
  '!': '！',
  '?': '？',
  ';': '；',
  ':': '：',
};

/** CJK 判定：汉字 / 假名 / CJK 标点 / 全角字符，用于半角句号的邻接判断 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff01-\uff65]/;

/**
 * 找到第一个可转换的半角句号位置（前后至少一侧是 CJK 字符），没有返回 -1。
 * 连续句点（省略号 ... / ..）跳过，交给省略号规则处理；
 * 英文上下文（3.14、U.S. 等）两侧都不是 CJK，天然不动。
 */
function findConvertiblePeriod(text: string): number {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== '.') continue;
    if (chars[i - 1] === '.' || chars[i + 1] === '.') continue;
    if (CJK_CHAR.test(chars[i - 1] ?? '') || CJK_CHAR.test(chars[i + 1] ?? '')) return i;
  }
  return -1;
}

/** 半角标点全角化：,!?;: 直接转；. 仅在 CJK 邻接时转，英文语境保留 */
function toFullWidthPunctuation(text: string): string {
  const chars = [...text];
  return chars
    .map((ch, i) => {
      const full = HALF_TO_FULL[ch];
      if (full) return full;
      if (ch !== '.') return ch;
      if (chars[i - 1] === '.' || chars[i + 1] === '.') return ch;
      if (CJK_CHAR.test(chars[i - 1] ?? '') || CJK_CHAR.test(chars[i + 1] ?? '')) return '。';
      return ch;
    })
    .join('');
}

/** 规则 7：半角标点全角化（fixable）。修复后半角消失，原有的「标点混用」提示自然消除 */
function checkHalfWidthPunctuation(text: string, issues: TextIssue[]): void {
  const direct = /[,:;!?]/.exec(text);
  const periodIndex = findConvertiblePeriod(text);
  if (!direct && periodIndex < 0) return;
  issues.push({
    rule: '半角标点',
    message: '存在半角标点，建议全角化（,!?;: 直接转；英文语境的 . 自动保留）',
    fixable: true,
    snippet: snippetAround(text, direct ? direct.index : periodIndex, 1),
    apply: toFullWidthPunctuation,
  });
}

/** 检查一段译文，按规则顺序返回全部问题 */
export function checkText(text: string): TextIssue[] {
  const issues: TextIssue[] = [];
  if (!text) return issues;
  checkEllipsis(text, issues);
  checkBlankLines(text, issues);
  checkEdgeSpaces(text, issues);
  checkMixedPunctuation(text, issues);
  checkQuotes(text, issues);
  checkRepeatedPunctuation(text, issues);
  checkHalfWidthPunctuation(text, issues);
  return issues;
}

/** 一键修复：依次套用全部 fixable 规则（自动修可叠加） */
export function fixText(text: string): string {
  let result = text;
  for (const issue of checkText(text)) {
    if (issue.fixable && issue.apply) {
      // 每条规则的 apply 都针对原始全文，按顺序套用
      result = issue.apply(result);
    }
  }
  return result;
}
