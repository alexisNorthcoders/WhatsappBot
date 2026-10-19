// Type-checks the remaining JS with tsconfig.checkjs.json. The .ts files it imports are
// checked by the strict pass (tsconfig.json), so their diagnostics are dropped here: under
// these loose settings they report errors that strict mode does not.

import ts from 'typescript';

const configPath = 'tsconfig.checkjs.json';
const { options, fileNames } = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  process.cwd(),
);
const program = ts.createProgram(fileNames, options);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => !d.file || !/\.ts$/.test(d.file.fileName));

if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  );
  process.exit(1);
}
