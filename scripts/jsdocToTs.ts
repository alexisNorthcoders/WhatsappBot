import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const FIX_IDS = ['convertTypedefToType', 'annotateWithTypeFromJSDoc'];

const files = process.argv.slice(2).map((f) => path.resolve(f));
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const versions = new Map(files.map((f) => [f, 0]));

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists)!;
const { options } = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  path.dirname(configPath),
);

const service = ts.createLanguageService({
  getScriptFileNames: () => files,
  getScriptVersion: (f) => String(versions.get(f) ?? 0),
  getScriptSnapshot: (f) => {
    const text = texts.get(f) ?? ts.sys.readFile(f);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => options,
  getDefaultLibFileName: ts.getDefaultLibFilePath,
  fileExists: (f) => texts.has(f) || ts.sys.fileExists(f),
  readFile: (f) => texts.get(f) ?? ts.sys.readFile(f),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});

function applyEdits(text: string, edits: readonly ts.TextChange[]): string {
  for (const { span, newText } of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, span.start) + newText + text.slice(span.start + span.length);
  }
  return text;
}

function closing(text: string, open: number): number {
  const [o, c] = text[open] === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  return -1;
}

function convertCasts(text: string): string {
  const cast = /\/\*\*\s*@type\s*(?=\{)/g;
  let out = '';
  let from = 0;
  for (let m = cast.exec(text); m; m = cast.exec(text)) {
    const typeOpen = m.index + m[0].length;
    const typeClose = closing(text, typeOpen);
    const rest = /^\s*\*\/\s*(?=\()/.exec(text.slice(typeClose + 1));
    if (typeClose < 0 || !rest) continue;
    const exprOpen = typeClose + 1 + rest[0].length;
    const exprClose = closing(text, exprOpen);
    if (exprClose < 0) continue;
    const type = text.slice(typeOpen + 1, typeClose).trim();
    const expr = text.slice(exprOpen + 1, exprClose).trim();
    out += `${text.slice(from, m.index)}(${expr} as ${type})`;
    from = exprClose + 1;
    cast.lastIndex = from;
  }
  return out + text.slice(from);
}

function stripTypeBraces(text: string): string {
  const tag = /@(?:param|returns?|type)\s*(?=\{)/g;
  let out = '';
  let from = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const open = m.index + m[0].length;
    const close = closing(text, open);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + 1;
    while (text[from] === ' ') from++;
    tag.lastIndex = from;
  }
  return out + text.slice(from);
}

function hoistTypeImports(text: string): string {
  const byModule = new Map<string, Set<string>>();
  const use = (mod: string, name: string) => byModule.set(mod, (byModule.get(mod) ?? new Set()).add(name));
  text = text
    .replace(/^type (\w+) = import\('([^']+)'\)\.\1;\n/gm, (_, name: string, mod: string) => {
      use(mod, name);
      return '';
    })
    .replace(/(?<!await )import\('([^']+)'\)\.(\w+)/g, (_, mod: string, name: string) => {
      use(mod, name);
      return name;
    });
  if (byModule.size === 0) return text;
  const lines = [...byModule].map(([mod, names]) => `import type { ${[...names].join(', ')} } from '${mod}';\n`);
  const imports = [...text.matchAll(/^import [^;]*;\n/gm)];
  const header = /^\/\*\*[\s\S]*?\*\/\n\n?/.exec(text);
  const at = imports.length > 0 ? imports.at(-1)!.index! + imports.at(-1)![0].length : header ? header[0].length : 0;
  const block = lines.join('') + (imports.length > 0 ? '' : '\n');
  return text.slice(0, at) + block + text.slice(at);
}

function stripJsDocTypes(text: string): string {
  return hoistTypeImports(stripTypeBraces(text))
    .replace(/^[ \t]*\*[ \t]*@(?:param|returns?)[ \t]*(?:\[[\w.$]+(?:=[^\]]*)?\]|[\w.$]+)?[ \t]*\n(?![ \t]*\*[ \t]{2,}[^\s@*/])/gm, '')
    .replace(/[ \t]*\/\*\*[ \t]*@(?:param|returns?|type)[ \t]*(?:[\w.$]+)?[ \t]*\*\/[ \t]*\n?/g, '')
    .replace(/^[ \t]*\/\*\*(?:[ \t]*\n[ \t]*\*)*[ \t]*\/\n/gm, '')
    .replace(/^export \{\};\n/m, '')
    .replace(/^type (?=\w+ =)/gm, 'export type ')
    .replace(/;\s*\}/g, (m) => (m.includes('\n') ? m : ' }'));
}

for (const file of files) texts.set(file, convertCasts(texts.get(file)!));

for (const fixId of FIX_IDS) {
  for (const file of files) {
    const { changes } = service.getCombinedCodeFix(
      { type: 'file', fileName: file },
      fixId,
      { ...ts.getDefaultFormatCodeSettings('\n'), indentSize: 2, tabSize: 2 },
      { quotePreference: 'single' },
    );
    const edits = changes.filter((c) => c.fileName === file).flatMap((c) => c.textChanges);
    if (edits.length === 0) continue;
    texts.set(file, applyEdits(texts.get(file)!, edits));
    versions.set(file, versions.get(file)! + 1);
  }
}

for (const file of files) {
  const text = stripJsDocTypes(texts.get(file)!);
  if (text !== readFileSync(file, 'utf8')) {
    writeFileSync(file, text);
    console.log(`converted ${path.relative(process.cwd(), file)}`);
  }
}
