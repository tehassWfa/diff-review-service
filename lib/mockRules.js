'use strict';

// Deterministic MOCK-* rule table, applied to added (+) lines only.
// MOCK-004 (empty catch block) is special-cased because it can span lines.

const LINE_RULES = [
  {
    id: 'MOCK-001',
    severity: 'critical',
    category: 'security',
    title: 'eval usage',
    test: (c) => c.includes('eval('),
  },
  {
    id: 'MOCK-002',
    severity: 'critical',
    category: 'security',
    title: 'hardcoded credential',
    test: (c) =>
      /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i.test(c),
  },
  {
    id: 'MOCK-003',
    severity: 'high',
    category: 'security',
    title: 'SQL string concatenation',
    // A SQL keyword inside a quoted string that is concatenated with '+'
    // either before or after the string literal.
    test: (c) =>
      /['"`][^'"`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*['"`]\s*\+/i.test(c) ||
      /\+\s*['"`][^'"`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*['"`]/i.test(c),
  },
  {
    id: 'MOCK-005',
    severity: 'medium',
    category: 'correctness',
    title: 'loose null comparison',
    test: (c) => /[!=]=\s*null/.test(c),
  },
  {
    id: 'MOCK-006',
    severity: 'medium',
    category: 'performance',
    title: 'deep-clone via JSON',
    test: (c) => c.includes('JSON.parse(JSON.stringify('),
  },
  {
    id: 'MOCK-007',
    severity: 'low',
    category: 'style',
    title: 'console.log left in',
    test: (c) => c.includes('console.log('),
  },
  {
    id: 'MOCK-008',
    severity: 'low',
    category: 'style',
    title: 'unresolved marker',
    test: (c) => /TODO|FIXME/.test(c),
  },
  {
    id: 'MOCK-INJ',
    severity: 'critical',
    category: 'security',
    title: 'prompt-injection content',
    test: (c) =>
      /ignore previous instructions|disregard all prior|you are now/i.test(c),
  },
];

function findEmptyCatchBlocks(file) {
  const results = [];
  const rl = file.rawLines;

  for (let i = 0; i < rl.length; i++) {
    const entry = rl[i];
    if (!entry.added || !/\bcatch\s*\(/.test(entry.text.slice(1))) continue;

    const catchLineNum = entry.newLine;
    const catchContent = entry.text.slice(1);

    // Find the opening brace, possibly on a later added line.
    let openIdx = -1;
    let braceFoundAt = null;
    if (catchContent.includes('{')) {
      braceFoundAt = i;
      openIdx = catchContent.indexOf('{');
    } else {
      let j = i + 1;
      while (j < rl.length && rl[j].added && rl[j].text.slice(1).trim() === '') j++;
      if (j < rl.length && rl[j].added && rl[j].text.slice(1).includes('{')) {
        braceFoundAt = j;
        openIdx = rl[j].text.slice(1).indexOf('{');
      }
    }
    if (braceFoundAt === null) continue; // can't resolve — skip, don't guess

    // Walk forward tracking brace depth using only added lines; if we hit a
    // non-added line before depth returns to 0, we can't safely verify
    // emptiness, so we skip (avoids false positives).
    let depth = 0;
    let started = false;
    let bodyChars = [];
    let resolved = false;

    for (let k = braceFoundAt; k < rl.length; k++) {
      if (!rl[k].added) { resolved = false; break; }
      const text = rl[k].text.slice(1);
      const scanStart = k === braceFoundAt ? openIdx : 0;
      for (let ci = scanStart; ci < text.length; ci++) {
        const ch = text[ci];
        if (ch === '{') { depth++; started = true; continue; }
        if (ch === '}') {
          depth--;
          if (started && depth === 0) { resolved = true; break; }
          continue;
        }
        bodyChars.push(ch);
      }
      if (resolved) break;
    }

    if (resolved) {
      const isEmpty = bodyChars.join('').trim() === '';
      if (isEmpty) {
        results.push({
          id: `MOCK-004:${file.path}:${catchLineNum}`,
          ruleId: 'MOCK-004',
          path: file.path,
          line: catchLineNum,
          severity: 'high',
          category: 'correctness',
          title: 'swallowed exception',
          evidence: catchContent,
        });
      }
    }
  }
  return results;
}

function dedupeAndSort(findings) {
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      deduped.push(f);
    }
  }

  deduped.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });

  return deduped;
}

function findMockFindings(files) {
  const findings = [];

  for (const file of files) {
    for (const f of findEmptyCatchBlocks(file)) findings.push(f);

    for (const added of file.addedLines) {
      for (const rule of LINE_RULES) {
        if (rule.test(added.content)) {
          findings.push({
            id: `${rule.id}:${file.path}:${added.line}`,
            ruleId: rule.id,
            path: file.path,
            line: added.line,
            severity: rule.severity,
            category: rule.category,
            title: rule.title,
            evidence: added.content,
          });
        }
      }
    }
  }

  return dedupeAndSort(findings);
}

module.exports = { findMockFindings, dedupeAndSort };
