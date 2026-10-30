/**
 * The citations in an answer (M37, in the harness since M45.8): which tool outputs and findings it
 * cites, and which it cites that it was never given - a model that says it changed something cites
 * the output of a change that never ran.
 */

// [T1], and the lists small models write anyway: [T1, T2]; [F1] for another agent's finding (M44).
const citation = /\[([TF]\d{1,3}(?:\s*[,;]\s*[TF]\d{1,3})*)\]/g;

/** The tool outputs and findings an answer cites, and those it cites that it was never given. */
export function checkCitations(answer, given, { findings = 0 } = {}) {
  const known = new Set([...Array.from({ length: given }, (_value, index) => `T${index + 1}`), ...Array.from({ length: findings }, (_value, index) => `F${index + 1}`)]);
  const cited = [...new Set([...String(answer ?? "").matchAll(citation)].flatMap((match) => match[1].split(/\s*[,;]\s*/)))];
  return { cited: cited.filter((id) => known.has(id)), unknown: cited.filter((id) => !known.has(id)) };
}
