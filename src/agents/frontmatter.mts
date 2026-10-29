// A minimal parser for the YAML subset agent frontmatter uses, so repo-kit
// needs no YAML dependency: nested maps by 2-space indentation, lists of maps
// (`- key: value` items, as in the OpenCode V2 `permissions` array), bare or
// double-quoted keys, and bare, double-quoted or single-quoted scalars.
// Lists of scalars, block scalars, flow collections and anchors are not
// supported: parsing throws, so a caller can skip the file instead of
// converting it wrongly.

export type YamlValue = string | boolean | YamlMap | YamlMap[];
export interface YamlMap {
  [key: string]: YamlValue;
}

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

/** The frontmatter and body of a Markdown document, or undefined without. */
export function splitFrontmatter(
  raw: string,
): { frontmatter: string; body: string } | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  return { frontmatter: match[1]!, body: match[2]! };
}

export function parseFrontmatter(text: string): YamlMap {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`odd indentation at line ${index + 1}`);
    }
    lines.push({ indent, text: trimmed, lineNo: index + 1 });
  });

  const [first] = lines;
  if (!first) return {};
  const [value, next] = parseBlock(lines, 0, first.indent);
  if (next < lines.length) {
    throw new Error(`unexpected indentation at line ${lines[next]!.lineNo}`);
  }
  if (Array.isArray(value)) throw new Error("frontmatter must be a map");
  return value;
}

function isListItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
): [YamlMap | YamlMap[], number] {
  return isListItem(lines[start]!.text)
    ? parseList(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseMap(
  lines: Line[],
  start: number,
  indent: number,
): [YamlMap, number] {
  const map: YamlMap = {};
  let index = start;
  while (
    index < lines.length &&
    lines[index]!.indent === indent &&
    !isListItem(lines[index]!.text)
  ) {
    const { text, lineNo } = lines[index]!;
    const { key, rest } = splitKey(text, lineNo);
    index += 1;
    if (rest !== "") {
      map[key] = parseScalar(rest, lineNo);
    } else if (index < lines.length && lines[index]!.indent > indent) {
      const [value, next] = parseBlock(lines, index, lines[index]!.indent);
      map[key] = value;
      index = next;
    } else {
      map[key] = {};
    }
  }
  if (index < lines.length && lines[index]!.indent > indent) {
    throw new Error(`unexpected indentation at line ${lines[index]!.lineNo}`);
  }
  return [map, index];
}

function parseList(
  lines: Line[],
  start: number,
  indent: number,
): [YamlMap[], number] {
  const list: YamlMap[] = [];
  let index = start;
  while (
    index < lines.length &&
    lines[index]!.indent === indent &&
    isListItem(lines[index]!.text)
  ) {
    const { text, lineNo } = lines[index]!;
    const item = text.slice(1).trimStart();
    // The item's first key sits after the dash; re-seat it at its real column
    // so parseMap collects the continuation keys of the same item.
    const itemIndent = indent + (text.length - item.length);
    if (
      item === "" ||
      !/^("(?:[^"\\]|\\.)*"|[^:"'\s][^:"']*?)\s*:(\s|$)/.test(item)
    ) {
      throw new Error(`lists of scalars are not supported (line ${lineNo})`);
    }
    lines[index] = { indent: itemIndent, text: item, lineNo };
    const [map, next] = parseMap(lines, index, itemIndent);
    list.push(map);
    index = next;
  }
  return [list, index];
}

function splitKey(
  entry: string,
  lineNo: number,
): { key: string; rest: string } {
  if (entry.startsWith('"')) {
    const match = entry.match(/^("(?:[^"\\]|\\.)*")\s*:\s*(.*)$/);
    if (!match) throw new Error(`unterminated quoted key at line ${lineNo}`);
    return { key: JSON.parse(match[1]!) as string, rest: match[2]! };
  }
  const match = entry.match(/^([^:"']+?)\s*:\s*(.*)$/);
  if (!match) throw new Error(`expected "key: value" at line ${lineNo}`);
  return { key: match[1]!, rest: match[2]! };
}

function parseScalar(text: string, lineNo: number): string | boolean {
  if (text.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) {
      throw new Error(`unsupported quoted value at line ${lineNo}`);
    }
    return JSON.parse(text) as string;
  }
  if (text.startsWith("'")) {
    const match = text.match(/^'((?:[^']|'')*)'$/);
    if (!match) throw new Error(`unsupported quoted value at line ${lineNo}`);
    return match[1]!.replaceAll("''", "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[{[&|>]/.test(text)) {
    throw new Error(`unsupported YAML syntax at line ${lineNo}`);
  }
  return text;
}
