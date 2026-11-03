import path from "node:path";

export type VersionFileFormat = "json" | "yaml";

const FORMATS: Record<string, VersionFileFormat> = {
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
};

// `version: 1.2.3` at the start of a line, the value bare or in one pair of
// quotes and possibly followed by a comment. A key such as `appVersion:` or an
// indented `version:` does not match.
const YAML_VERSION =
  /^(version[ \t]*:[ \t]*(["']?))[^"'\s#]+\2(?=[ \t]*(?:#.*)?\r?$)/m;

const YAML_DOCUMENT_START = /^---(?:[ \t].*)?\r?$/gm;
// What may stand before a leading `---`: blank lines, comments and directives.
const YAML_PREAMBLE = /^(?:[ \t]*(?:[#%].*)?\r?\n)*$/;

/**
 * Where the first document of a YAML stream ends: at the first `---` line
 * that follows any leading `---`, else at the end of the text.
 */
function firstYamlDocumentEnd(source: string): number {
  YAML_DOCUMENT_START.lastIndex = 0;
  let start = YAML_DOCUMENT_START.exec(source);
  if (start && YAML_PREAMBLE.test(source.slice(0, start.index))) {
    start = YAML_DOCUMENT_START.exec(source);
  }
  return start ? start.index : source.length;
}

/** The format a version file is edited in, by its extension. */
export function versionFileFormat(file: string): VersionFileFormat | undefined {
  return FORMATS[path.extname(file).toLowerCase()];
}

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index]!)) index++;
  return index;
}

/** The index after the string literal opening at `start`. */
function stringEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === '"') return index + 1;
    else index++;
  }
  return source.length;
}

/** The characters of the string value that follows the key ending at `from`. */
function valueRange(
  source: string,
  from: number,
): [number, number] | undefined {
  const colon = skipWhitespace(source, from);
  if (source[colon] !== ":") return undefined;
  const start = skipWhitespace(source, colon + 1);
  if (source[start] !== '"') return undefined;
  const end = stringEnd(source, start);
  return source[end - 1] === '"' && end - 1 > start
    ? [start + 1, end - 1]
    : undefined;
}

/**
 * The characters between the quotes of the top-level "version" string of a
 * JSON object, found by scanning the text so that nesting, indentation and
 * minified files make no difference.
 */
function jsonVersionRange(source: string): [number, number] | undefined {
  const containers: string[] = [];
  let expectKey = false;
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') {
      const end = stringEnd(source, index);
      if (containers.length === 1 && containers[0] === "{" && expectKey) {
        expectKey = false;
        if (source.slice(index + 1, end - 1) === "version") {
          return valueRange(source, end);
        }
      }
      index = end;
      continue;
    }
    if (character === "{" || character === "[") {
      containers.push(character);
      if (containers.length === 1) expectKey = character === "{";
    } else if (character === "}" || character === "]") {
      containers.pop();
    } else if (character === "," && containers.length === 1) {
      expectKey = true;
    }
    index++;
  }
  return undefined;
}

/**
 * The file's text with its top-level version replaced and nothing else
 * touched: the value is rewritten in place so the file keeps its formatting.
 * A "version" key inside another object, or an indented `version:`, is left
 * alone, and so is any YAML document after the first.
 */
export function bumpedVersionFile(
  file: string,
  source: string,
  version: string,
): string {
  const format = versionFileFormat(file);
  if (format === undefined) {
    throw new Error(`${file} is not a .json, .yml or .yaml file.`);
  }
  if (format === "json") {
    const range = jsonVersionRange(source);
    if (range === undefined) {
      throw new Error(`${file} has no top-level version field.`);
    }
    return `${source.slice(0, range[0])}${version}${source.slice(range[1])}`;
  }
  const end = firstYamlDocumentEnd(source);
  const document = source.slice(0, end);
  if (!YAML_VERSION.test(document)) {
    throw new Error(`${file} has no top-level version field.`);
  }
  return (
    document.replace(
      YAML_VERSION,
      (_match, opening: string, quote: string) =>
        `${opening}${version}${quote}`,
    ) + source.slice(end)
  );
}
