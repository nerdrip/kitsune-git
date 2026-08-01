function parseRange(value) {
  const [startText, countText] = value.split(',');
  return { start: Number(startText), count: countText === undefined ? 1 : Number(countText) };
}

function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.length > 16 * 1024 * 1024) throw new Error('Diff is invalid or too large');
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const firstHunk = lines.findIndex(line => line.startsWith('@@ '));
  if (firstHunk < 0) return { header: lines, hunks: [], binary: /^(?:Binary files|GIT binary patch)/m.test(diffText) };
  const header = lines.slice(0, firstHunk);
  const hunks = [];
  let current = null;
  for (const line of lines.slice(firstHunk)) {
    const match = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
    if (match) {
      current = {
        oldRange: parseRange(match[1]),
        newRange: parseRange(match[2]),
        suffix: match[3] || '',
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) throw new Error('Malformed unified diff');
    if (line && ![' ', '+', '-', '\\'].includes(line[0])) throw new Error('Malformed hunk line');
    current.lines.push(line);
  }
  return { header, hunks, binary: false };
}

function rangeText(start, count) {
  return `${start},${count}`;
}

function normalizeSelection(selection, hunkCount) {
  if (!Array.isArray(selection) || selection.length === 0 || selection.length > 10_000) {
    throw new Error('At least one diff change must be selected');
  }
  const normalized = new Map();
  for (const item of selection) {
    if (!item || !Number.isSafeInteger(item.hunk) || item.hunk < 0 || item.hunk >= hunkCount) {
      throw new Error('Selected hunk index is invalid');
    }
    if (item.lines === undefined || item.lines === null) {
      normalized.set(item.hunk, null);
      continue;
    }
    if (!Array.isArray(item.lines) || item.lines.some(line => !Number.isSafeInteger(line) || line < 0)) {
      throw new Error('Selected diff line indexes are invalid');
    }
    if (!normalized.has(item.hunk) || normalized.get(item.hunk) !== null) {
      normalized.set(item.hunk, new Set([...(normalized.get(item.hunk) || []), ...item.lines]));
    }
  }
  return normalized;
}

function buildSelectedPatch(diffText, selection) {
  const parsed = parseUnifiedDiff(diffText);
  if (parsed.binary || parsed.hunks.length === 0) throw new Error('This diff does not contain selectable text hunks');
  const selected = normalizeSelection(selection, parsed.hunks.length);
  const output = [...parsed.header];
  let included = 0;

  parsed.hunks.forEach((hunk, hunkIndex) => {
    if (!selected.has(hunkIndex)) return;
    const selectedLines = selected.get(hunkIndex);
    if (selectedLines === null) {
      output.push(`@@ -${rangeText(hunk.oldRange.start, hunk.oldRange.count)} +${rangeText(hunk.newRange.start, hunk.newRange.count)} @@${hunk.suffix}`);
      output.push(...hunk.lines);
      included += 1;
      return;
    }

    const body = [];
    let oldCount = 0;
    let newCount = 0;
    let selectedChanges = 0;
    let previousIncluded = false;
    hunk.lines.forEach((line, lineIndex) => {
      const prefix = line[0] || ' ';
      if (prefix === ' ') {
        body.push(line);
        oldCount += 1;
        newCount += 1;
        previousIncluded = true;
      } else if (prefix === '+') {
        if (selectedLines.has(lineIndex)) {
          body.push(line);
          newCount += 1;
          selectedChanges += 1;
          previousIncluded = true;
        } else {
          previousIncluded = false;
        }
      } else if (prefix === '-') {
        if (selectedLines.has(lineIndex)) {
          body.push(line);
          oldCount += 1;
          selectedChanges += 1;
        } else {
          body.push(` ${line.slice(1)}`);
          oldCount += 1;
          newCount += 1;
        }
        previousIncluded = true;
      } else if (prefix === '\\' && previousIncluded) {
        body.push(line);
      }
    });
    if (!selectedChanges) return;
    output.push(`@@ -${rangeText(hunk.oldRange.start, oldCount)} +${rangeText(hunk.newRange.start, newCount)} @@${hunk.suffix}`);
    output.push(...body);
    included += 1;
  });

  if (!included) throw new Error('The selection does not contain any changed lines');
  return `${output.join('\n').replace(/\n+$/, '')}\n`;
}

module.exports = { buildSelectedPatch, parseUnifiedDiff };
