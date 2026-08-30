#!/usr/bin/env node
/** Refuse Metro-hostile package-barrel imports in an Expo source tree. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(process.argv[2] ?? new URL('../packages/frontend', import.meta.url).pathname);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['.expo', 'dist', 'node_modules']);
const ROOT_VECTOR_ICON_PACKAGE = '@expo/vector-icons';
const extension = (path) => path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extension(path))) files.push(path);
  }
  return files;
}

function scriptKind(path) {
  switch (extension(path)) {
    case '.jsx': return ts.ScriptKind.JSX;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.js': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function moduleSpecifier(node) {
  return node !== undefined && ts.isStringLiteral(node) && node.text === ROOT_VECTOR_ICON_PACKAGE;
}

function rootBarrelImports(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind(path));
  const violations = [];
  const report = (node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, text: source.split('\n')[line].trim() });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && moduleSpecifier(node.moduleSpecifier)
      || ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && moduleSpecifier(node.moduleReference.expression)
      || ts.isCallExpression(node) && node.arguments.length === 1 && moduleSpecifier(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
    ) report(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const violations = [];
for (const file of sourceFiles(ROOT)) {
  const source = readFileSync(file, 'utf8');
  for (const violation of rootBarrelImports(source, file)) {
    violations.push(`${relative(ROOT, file)}:${violation.line}: ${violation.text}`);
  }
}
if (violations.length > 0) {
  console.error('Import icon families through @expo/vector-icons/<Family>; the root barrel bundles every font.\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`Bundle imports: ${relative(process.cwd(), ROOT)} has no vector-icon barrel imports.`);
