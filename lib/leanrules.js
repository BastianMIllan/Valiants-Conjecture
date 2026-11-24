// A fast check of a Lean file against the official format rules, run before
// our account opens a pull request. It is stricter than the official reader on
// purpose: a refused pull request costs our account's standing, a fixed file
// costs the agent one more try. The official Lean checker remains the judge.
const OPTIONS = new Set(['maxRecDepth', 'maxHeartbeats', 'synthInstance.maxSize', 'synthInstance.maxHeartbeats']);
const FORBIDDEN = ['sorry', 'admit', 'axiom', 'native_decide', 'initialize', 'macro', 'macro_rules', 'syntax', 'notation', 'elab', 'elab_rules', 'attribute', 'unsafe', 'implemented_by', 'extern'];
const stripComments = (s) => s.replace(/\/-[\s\S]*?-\//g, ' ').replace(/--[^\n]*/g, '');
const SLOW = ['structure', 'inductive', 'class', 'instance', 'deriving'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s) => s.replace(/\s+/g, ' ').replace(/\s*([()[\]{},:])\s*/g, '$1').trim();

export function checkLean(text, gap) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['the file is empty'], warnings };
  if (text.length > 150_000) errors.push('the file is over 150 KB');
  if (text.includes('"')) errors.push('rule c: no double quotes anywhere (no string literals)');
  if (/\r/.test(text)) warnings.push('the file has Windows line endings; they are converted to \\n');

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const imports = [];
  let pastImports = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('--')) return;
    if (/^import\s/.test(line) && !pastImports) imports.push(line.replace(/^import\s+/, '').trim());
    else {
      pastImports = true;
      if (/\bimport\b/.test(line)) errors.push(`line ${i + 1}: the word import may appear only in the import lines at the top`);
    }
    if (/^#/.test(line)) errors.push(`line ${i + 1}: rule a: no # commands (#eval, #check, …)`);
    if (line.startsWith('/-') || line.includes('/-')) warnings.push(`line ${i + 1}: rule b: block comments go to a person to read; use -- comments`);
    const so = line.match(/^set_option\s+(\S+)\s+(\S+)(\s+in)?\s*$/);
    if (/^set_option\b/.test(line)) {
      if (!so || !OPTIONS.has(so[1]) || !/^\d+$/.test(so[2]) || !so[3]) {
        errors.push(`line ${i + 1}: rule d: only "set_option <maxRecDepth|maxHeartbeats|synthInstance.maxSize|synthInstance.maxHeartbeats> <number> in" on its own line`);
      }
    }
    for (const m of line.matchAll(/@\[([^\]]*)\]/g)) {
      if (!/^\s*(local\s+)?simp\s*$/.test(m[1])) errors.push(`line ${i + 1}: rule d: the only attributes are @[simp] and @[local simp]`);
    }
  });

  if (!imports.includes('Mathlib')) errors.push('the file must start with: import Mathlib');
  const allowed = new Set(['Mathlib', ...((gap && gap.imports) || [])]);
  for (const im of imports) if (!allowed.has(im)) errors.push(`import ${im} is not allowed for this step (allowed: ${[...allowed].join(', ')})`);

  const code = stripComments(text);
  for (const w of FORBIDDEN) {
    const re = new RegExp(`(^|[^\\w.'])${esc(w)}(?![\\w'])`, 'm');
    if (re.test(code)) errors.push(`forbidden: ${w}`);
    else if (re.test(text)) warnings.push(`rule b: the word "${w}" in a comment sends the pull request to a person: reword the comment`);
  }
  if (/(^|\n)\s*(infix|infixl|infixr|prefix|postfix)\b/.test(code)) errors.push('rule a: no notation commands (infix, prefix, postfix)');
  for (const w of SLOW) {
    if (new RegExp(`(^|\\n)\\s*(@\\[[^\\]]*\\]\\s*)?(private\\s+|protected\\s+|noncomputable\\s+)*${w}\\b`).test(text)) {
      warnings.push(`rule e: "${w}" declares its own data type or instance: the pull request waits for a person to read it`);
    }
  }

  if (gap?.module) {
    if (!new RegExp(`(^|\\n)\\s*theorem\\s+${esc(gap.module)}(?![\\w.'])`).test(text)) {
      errors.push(`the file must prove: theorem ${gap.module} : <the posted statement>`);
    } else if (gap.statement && !squash(text).includes(squash(gap.statement))) {
      warnings.push('the statement in the file does not match the posted one character for character (spacing aside): the checker refuses any other statement');
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
