import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { z } from "zod";
import type {
  CodeRef,
  CodeRefDeclaration,
  CodeRefKind,
  CodeRefNamespace,
  CodeRefsIndex,
  NoteFrontmatter,
  ResolvedCodeRef,
} from "./types.js";

export type CodeRefRequest = {
  noteId: string;
  ref: CodeRef;
};

export type CodeRefDiagnostic = {
  noteId: string;
  message: string;
};

export type CodeRefResolution = {
  resolved: ResolvedCodeRef[];
  errors: CodeRefDiagnostic[];
};

type PreparedCodeRef = CodeRefRequest & {
  filePath: string;
};

type ProgramGroup = {
  configFile?: string;
  refs: PreparedCodeRef[];
};

type SymbolCandidate = {
  symbol: ts.Symbol;
  kinds: CodeRefKind[];
  namespaces: CodeRefNamespace[];
  location: CodeRefDeclaration;
  declarations: CodeRefDeclaration[];
};

const CODE_REF_KIND_VALUES = [
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
  "namespace",
  "import",
  "export",
  "method",
  "property",
] as const satisfies readonly CodeRefKind[];

const CODE_REF_NAMESPACE_VALUES = [
  "value",
  "type",
  "namespace",
] as const satisfies readonly CodeRefNamespace[];

export const codeRefKindSchema = z.enum(CODE_REF_KIND_VALUES);
export const codeRefNamespaceSchema = z.enum(CODE_REF_NAMESPACE_VALUES);
export const codeRefSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  kind: codeRefKindSchema.optional(),
  namespace: codeRefNamespaceSchema.optional(),
});
export const codeRefArraySchema = z.array(codeRefSchema);

const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const KIND_ORDER: CodeRefKind[] = [...CODE_REF_KIND_VALUES];

export type CodeRefRequestCollection = {
  requests: CodeRefRequest[];
  errors: CodeRefDiagnostic[];
};

export function collectCodeRefRequestsFromNotes(
  notes: Map<string, { id: string; fm: NoteFrontmatter }>,
  validNotes?: Set<string>,
): CodeRefRequestCollection {
  const requests: CodeRefRequest[] = [];
  const errors: CodeRefDiagnostic[] = [];
  for (const note of notes.values()) {
    if (validNotes && !validNotes.has(note.id)) continue;
    if (note.fm.code_refs === undefined) continue;

    const parsed = codeRefArraySchema.safeParse(note.fm.code_refs);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          noteId: note.id,
          message: `[${note.id}] frontmatter.code_refs.${issue.path.join(".") || "/"} ${issue.message}`,
        });
      }
      continue;
    }

    for (const ref of parsed.data) requests.push({ noteId: note.id, ref });
  }
  return { requests, errors };
}

export function resolveCodeRefs(requests: CodeRefRequest[], repoRoot: string): CodeRefResolution {
  const root = resolve(repoRoot);
  const errors: CodeRefDiagnostic[] = [];
  const prepared: PreparedCodeRef[] = [];

  for (const request of requests) {
    const filePath = resolve(root, request.ref.file);
    if (!isWithinRoot(root, filePath)) {
      errors.push({
        noteId: request.noteId,
        message: `[${request.noteId}] code_ref escapes repo root: ${request.ref.file}`,
      });
      continue;
    }
    if (!existsSync(filePath)) {
      errors.push({
        noteId: request.noteId,
        message: `[${request.noteId}] code_ref file does not exist: ${request.ref.file}`,
      });
      continue;
    }
    if (!SUPPORTED_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      errors.push({
        noteId: request.noteId,
        message: `[${request.noteId}] code_ref unsupported source type: ${request.ref.file}`,
      });
      continue;
    }
    prepared.push({ ...request, filePath });
  }

  const resolved: ResolvedCodeRef[] = [];
  for (const group of groupByTsConfig(prepared, root)) {
    const programResult = createResolverProgram(group, root);
    if (!programResult.ok) {
      for (const ref of group.refs) {
        for (const error of programResult.errors) {
          errors.push({
            noteId: ref.noteId,
            message: `[${ref.noteId}] code_ref ${ref.ref.file}#${ref.ref.symbol} ${error}`,
          });
        }
      }
      continue;
    }

    const { checker, program } = programResult;
    const candidateCache = new Map<string, Map<string, SymbolCandidate[]>>();
    for (const ref of group.refs) {
      const sourceFile = findSourceFile(program, ref.filePath);
      if (!sourceFile) {
        errors.push({
          noteId: ref.noteId,
          message: `[${ref.noteId}] code_ref ${ref.ref.file}#${ref.ref.symbol} not found`,
        });
        continue;
      }

      const candidatesByName =
        candidateCache.get(sourceFile.fileName) ??
        collectSymbolCandidates(sourceFile, checker, root);
      candidateCache.set(sourceFile.fileName, candidatesByName);

      const candidates = candidatesByName.get(ref.ref.symbol) ?? [];
      const narrowed = narrowCandidates(candidates, ref.ref);
      if (candidates.length === 0 || narrowed.length === 0) {
        errors.push({
          noteId: ref.noteId,
          message: `[${ref.noteId}] code_ref ${ref.ref.file}#${ref.ref.symbol} not found`,
        });
        continue;
      }
      if (narrowed.length > 1) {
        errors.push({
          noteId: ref.noteId,
          message: ambiguousMessage(ref, narrowed),
        });
        continue;
      }

      const candidate = narrowed[0];
      if (candidate) resolved.push(toResolvedCodeRef(ref, candidate));
    }
  }

  return { resolved: sortResolvedCodeRefs(resolved), errors };
}

export function buildCodeRefsIndex(resolved: ResolvedCodeRef[]): CodeRefsIndex {
  return {
    schema_version: 1,
    refs: sortResolvedCodeRefs(resolved),
  };
}

function groupByTsConfig(refs: PreparedCodeRef[], repoRoot: string): ProgramGroup[] {
  const groups = new Map<string, ProgramGroup>();
  for (const ref of refs) {
    const configFile = findNearestTsConfig(ref.filePath, repoRoot);
    const key = configFile ?? `fallback:${repoRoot}`;
    const group = groups.get(key) ?? { configFile, refs: [] };
    group.refs.push(ref);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function findNearestTsConfig(filePath: string, repoRoot: string): string | undefined {
  let current = dirname(filePath);
  while (isWithinRoot(repoRoot, current)) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (current === repoRoot) break;
    current = dirname(current);
  }
  return undefined;
}

function createResolverProgram(
  group: ProgramGroup,
  repoRoot: string,
): { ok: true; program: ts.Program; checker: ts.TypeChecker } | { ok: false; errors: string[] } {
  const rootNames = unique(group.refs.map((ref) => ref.filePath));
  let compilerOptions = fallbackCompilerOptions();
  let configRootNames: string[] = [];

  if (group.configFile) {
    const config = ts.readConfigFile(group.configFile, ts.sys.readFile);
    if (config.error)
      return { ok: false, errors: [`tsconfig error: ${formatDiagnostic(config.error)}`] };
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(group.configFile),
      fallbackCompilerOptions(),
      group.configFile,
    );
    if (parsed.errors.length > 0) {
      return {
        ok: false,
        errors: parsed.errors.map((error) => `tsconfig error: ${formatDiagnostic(error)}`),
      };
    }
    compilerOptions = resolverCompilerOptions(parsed.options);
    configRootNames = parsed.fileNames;
  }

  const program = ts.createProgram({
    rootNames: unique([...configRootNames, ...rootNames]),
    options: resolverCompilerOptions(compilerOptions),
  });

  for (const file of rootNames) {
    if (!findSourceFile(program, file)) {
      return {
        ok: false,
        errors: [`could not load source file ${toPortablePath(relative(repoRoot, file))}`],
      };
    }
  }

  return { ok: true, program, checker: program.getTypeChecker() };
}

function fallbackCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
}

function resolverCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return {
    ...options,
    allowJs: true,
    checkJs: options.checkJs ?? false,
    module: options.module ?? ts.ModuleKind.NodeNext,
    moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: options.skipLibCheck ?? true,
    target: options.target ?? ts.ScriptTarget.ES2022,
  };
}

function collectSymbolCandidates(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  repoRoot: string,
): Map<string, SymbolCandidate[]> {
  const candidates = new Map<string, SymbolCandidate[]>();
  const seen = new Map<string, Map<ts.Symbol, SymbolCandidate>>();

  const addSymbol = (name: string, symbol: ts.Symbol | undefined) => {
    if (!symbol) return;
    const localDeclarations = declarationsForSymbol(symbol, repoRoot);
    const resolved = resolveAlias(symbol, checker);
    const resolvedDeclarations = declarationsForSymbol(resolved, repoRoot);
    const declarations = uniqueDeclarations([...localDeclarations, ...resolvedDeclarations]);
    const location =
      localDeclarations.find(
        (declaration) =>
          declaration.file === toPortablePath(relative(repoRoot, sourceFile.fileName)),
      ) ?? declarations[0];
    if (!location || declarations.length === 0) return;
    const candidate: SymbolCandidate = {
      symbol: resolved,
      kinds: uniqueKinds(declarations.map((declaration) => declaration.kind)),
      namespaces: namespacesForSymbol(resolved),
      location,
      declarations,
    };
    const candidatesForName = candidates.get(name) ?? [];
    const seenForName = seen.get(name) ?? new Map<ts.Symbol, SymbolCandidate>();
    if (!seenForName.has(candidate.symbol)) {
      candidatesForName.push(candidate);
      seenForName.set(candidate.symbol, candidate);
      candidates.set(name, candidatesForName);
      seen.set(name, seenForName);
    }
  };

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      addSymbol(exported.name, exported);
    }
  }

  const visit = (node: ts.Node) => {
    const name = symbolNameNode(node);
    if (name) addSymbol(name.text, checker.getSymbolAtLocation(name));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return candidates;
}

function symbolNameNode(node: ts.Node): ts.Identifier | ts.StringLiteral | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyAssignment(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  if (ts.isImportClause(node) && node.name) return node.name;
  if (ts.isNamespaceImport(node)) return node.name;
  if (ts.isImportSpecifier(node)) return node.name;
  if (ts.isImportEqualsDeclaration(node)) return node.name;
  if (ts.isExportSpecifier(node)) return node.name;
  if (ts.isShorthandPropertyAssignment(node)) return node.name;
  return undefined;
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  const aliased = checker.getAliasedSymbol(symbol);
  return aliased === symbol ? symbol : aliased;
}

function declarationsForSymbol(symbol: ts.Symbol, repoRoot: string): CodeRefDeclaration[] {
  return (symbol.declarations ?? [])
    .map((declaration) => declarationToMetadata(declaration, repoRoot))
    .filter((declaration): declaration is CodeRefDeclaration => declaration !== undefined)
    .sort(compareDeclarations);
}

function declarationToMetadata(
  declaration: ts.Declaration,
  repoRoot: string,
): CodeRefDeclaration | undefined {
  const kind = kindForDeclaration(declaration);
  if (!kind) return undefined;
  const sourceFile = declaration.getSourceFile();
  if (!isWithinRoot(repoRoot, resolve(sourceFile.fileName))) return undefined;
  const locationNode = declarationLocationNode(declaration);
  const location = sourceFile.getLineAndCharacterOfPosition(locationNode.getStart(sourceFile));
  return {
    file: toPortablePath(relative(repoRoot, sourceFile.fileName)),
    kind,
    line: location.line + 1,
    column: location.character + 1,
  };
}

function kindForDeclaration(declaration: ts.Declaration): CodeRefKind | undefined {
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isClassDeclaration(declaration)) return "class";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isModuleDeclaration(declaration)) return "namespace";
  if (ts.isImportClause(declaration)) return "import";
  if (ts.isImportSpecifier(declaration)) return "import";
  if (ts.isNamespaceImport(declaration)) return "import";
  if (ts.isImportEqualsDeclaration(declaration)) return "import";
  if (ts.isExportSpecifier(declaration)) return "export";
  if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) return "method";
  if (
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isShorthandPropertyAssignment(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  ) {
    return "property";
  }
  if (ts.isVariableDeclaration(declaration)) return variableKind(declaration);
  return undefined;
}

function variableKind(declaration: ts.VariableDeclaration): "const" | "let" | "var" {
  const declarationList = declaration.parent;
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) return "const";
  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) return "let";
  return "var";
}

function declarationLocationNode(declaration: ts.Declaration): ts.Node {
  const named = declaration as ts.NamedDeclaration;
  if (named.name) return named.name;
  return declaration;
}

function namespacesForSymbol(symbol: ts.Symbol): CodeRefNamespace[] {
  const namespaces: CodeRefNamespace[] = [];
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) namespaces.push("value");
  if ((symbol.flags & ts.SymbolFlags.Type) !== 0) namespaces.push("type");
  if ((symbol.flags & ts.SymbolFlags.Namespace) !== 0) namespaces.push("namespace");
  return namespaces;
}

function narrowCandidates(candidates: SymbolCandidate[], ref: CodeRef): SymbolCandidate[] {
  return candidates.filter((candidate) => {
    const kindMatches = ref.kind ? candidate.kinds.includes(ref.kind) : true;
    const namespaceMatches = ref.namespace ? candidate.namespaces.includes(ref.namespace) : true;
    return kindMatches && namespaceMatches;
  });
}

function toResolvedCodeRef(ref: PreparedCodeRef, candidate: SymbolCandidate): ResolvedCodeRef {
  return {
    note_id: ref.noteId,
    ref: cleanRef(ref.ref),
    kind: ref.ref.kind ?? preferredKind(candidate.kinds),
    namespaces: candidate.namespaces,
    line: candidate.location.line,
    column: candidate.location.column,
    declarations: candidate.declarations,
  };
}

function cleanRef(ref: CodeRef): CodeRef {
  return {
    file: ref.file,
    symbol: ref.symbol,
    ...(ref.kind ? { kind: ref.kind } : {}),
    ...(ref.namespace ? { namespace: ref.namespace } : {}),
  };
}

function preferredKind(kinds: CodeRefKind[]): CodeRefKind {
  return KIND_ORDER.find((kind) => kinds.includes(kind)) ?? kinds[0] ?? "const";
}

function ambiguousMessage(ref: PreparedCodeRef, candidates: SymbolCandidate[]): string {
  const details = candidates
    .map((candidate) => `${preferredKind(candidate.kinds)}:${candidate.namespaces.join("+")}`)
    .sort()
    .join(", ");
  return `[${ref.noteId}] code_ref ${ref.ref.file}#${ref.ref.symbol} is ambiguous; add kind and/or namespace (${details})`;
}

function sortResolvedCodeRefs(refs: ResolvedCodeRef[]): ResolvedCodeRef[] {
  return [...refs].sort((a, b) => {
    const note = a.note_id.localeCompare(b.note_id);
    if (note !== 0) return note;
    const file = a.ref.file.localeCompare(b.ref.file);
    if (file !== 0) return file;
    const symbol = a.ref.symbol.localeCompare(b.ref.symbol);
    if (symbol !== 0) return symbol;
    const kind = (a.ref.kind ?? "").localeCompare(b.ref.kind ?? "");
    if (kind !== 0) return kind;
    return (a.ref.namespace ?? "").localeCompare(b.ref.namespace ?? "");
  });
}

function compareDeclarations(a: CodeRefDeclaration, b: CodeRefDeclaration): number {
  const file = a.file.localeCompare(b.file);
  if (file !== 0) return file;
  const line = a.line - b.line;
  if (line !== 0) return line;
  const column = a.column - b.column;
  if (column !== 0) return column;
  return a.kind.localeCompare(b.kind);
}

function findSourceFile(program: ts.Program, filePath: string): ts.SourceFile | undefined {
  const resolved = resolve(filePath);
  return (
    program.getSourceFile(resolved) ??
    program.getSourceFiles().find((sourceFile) => resolve(sourceFile.fileName) === resolved)
  );
}

function isWithinRoot(repoRoot: string, target: string): boolean {
  const relativePath = relative(repoRoot, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueKinds(values: CodeRefKind[]): CodeRefKind[] {
  return KIND_ORDER.filter((kind) => values.includes(kind));
}

function uniqueDeclarations(values: CodeRefDeclaration[]): CodeRefDeclaration[] {
  const byKey = new Map<string, CodeRefDeclaration>();
  for (const value of values) {
    byKey.set(`${value.file}:${value.kind}:${value.line}:${value.column}`, value);
  }
  return [...byKey.values()].sort(compareDeclarations);
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
