// Obelisk clients render kind 9 content as CommonMark without soft-break
// handling, so a single "\n" collapses into a space. hardBreaks() turns each
// single newline into a hard break ("  \n" — invisible in plain-text
// clients), leaving blank lines and ``` fenced blocks untouched.
export function hardBreaks(text) {
  const lines = String(text).split('\n');
  let fenced = false;
  return lines.map((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return line;
    }
    const next = lines[i + 1];
    if (fenced || next === undefined || !line.trim() || !next.trim() || / {2}$/.test(line)) return line;
    return `${line}  `;
  }).join('\n');
}
