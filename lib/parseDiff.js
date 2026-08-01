'use strict';

// Parses a unified diff (with or without `diff --git` headers) into a list of
// per-file blocks. Each block carries:
//   - path: the new-file path (from the `+++ b/<path>` line)
//   - rawText: the raw diff text for that file (used for chunking-by-file)
//   - addedLines: [{ line, content }] — content is the line WITHOUT the leading '+'
//   - rawLines: [{ text, added, newLine }] — every raw line in the file block,
//     tagged with whether it's an added line and, if so, its new-file line
//     number. This lets rules that need multi-line context (like the empty
//     catch-block rule) find exact line numbers without ambiguity.
//
// A diff is considered valid iff it contains at least one hunk header
// (`@@ -a,b +c,d @@`) associated with at least one file that has a resolvable
// path.

const GIT_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_FILE_RE = /^--- (?:a\/)?(.+)$/;
const NEW_FILE_RE = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return { valid: false, files: [] };
  }

  const lines = diffText.split('\n');
  const files = [];
  let current = null;
  let hunkNewLine = null;
  let sawHunk = false;
  let pendingOldPath = null;

  function newBlock() {
    return { path: null, raw: [], rawLines: [], addedLines: [] };
  }

  function finalize() {
    if (current && current.path) {
      current.rawText = current.raw.join('\n');
      current.rawLength = Buffer.byteLength(current.rawText, 'utf8');
      files.push(current);
    }
  }

  for (const line of lines) {
    if (GIT_HEADER_RE.test(line)) {
      finalize();
      current = newBlock();
      current.raw.push(line);
      hunkNewLine = null;
      pendingOldPath = null;
      continue;
    }

    if (line.startsWith('--- ') && OLD_FILE_RE.test(line)) {
      // A '---' line that follows an already-active hunk means a new file
      // section has begun (common in diffs with no `diff --git` headers).
      if (current && (current.addedLines.length > 0 || hunkNewLine !== null)) {
        finalize();
        current = newBlock();
      }
      if (!current) current = newBlock();
      current.raw.push(line);
      pendingOldPath = OLD_FILE_RE.exec(line)[1];
      hunkNewLine = null;
      continue;
    }

    if (line.startsWith('+++ ') && NEW_FILE_RE.test(line)) {
      if (!current) current = newBlock();
      const p = NEW_FILE_RE.exec(line)[1];
      current.path = p === '/dev/null' ? pendingOldPath : p;
      current.raw.push(line);
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      sawHunk = true;
      if (!current) current = newBlock();
      current.raw.push(line);
      current.rawLines.push({ text: line, added: false, newLine: null });
      hunkNewLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (current) current.raw.push(line);

    if (hunkNewLine !== null && current) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const content = line.slice(1);
        current.addedLines.push({ line: hunkNewLine, content });
        current.rawLines.push({ text: line, added: true, newLine: hunkNewLine });
        hunkNewLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.rawLines.push({ text: line, added: false, newLine: null });
        // removed lines don't advance the new-file counter
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" marker — ignore, no counter change
        current.rawLines.push({ text: line, added: false, newLine: null });
      } else {
        // context line (leading space) or blank line inside a hunk
        current.rawLines.push({ text: line, added: false, newLine: null });
        hunkNewLine++;
      }
    } else if (current) {
      current.rawLines.push({ text: line, added: false, newLine: null });
    }
  }
  finalize();

  const valid = sawHunk && files.some((f) => f.path);
  return { valid, files: files.filter((f) => f.path) };
}

module.exports = { parseDiff };
