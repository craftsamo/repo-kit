import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { UsageError } from "../errors.mts";
import { assetPath } from "../package-root.mts";
import { repositoryRoot } from "../repository-root.mts";
import {
  GENERATED_MARKER,
  isGeneratedText,
  parseAgent,
  TARGETS,
} from "./convert.mts";

const AGENTS_DIR = ".opencode/agents";
const SKILLS_DIR = ".opencode/skills";
// Tool-native skill directories that show the same skills.
const SKILL_LINKS = [".agents/skills", ".claude/skills"];
const INSTALLED_NOTE = `${GENERATED_MARKER} from @craftsamo/repo-kit — do not edit; to change it, replace it with your own file without this line`;
const EXCLUDE_BEGIN = "# >>> repo-kit agents sync (generated, do not edit)";
const EXCLUDE_END = "# <<< repo-kit agents sync";

export interface SyncResult {
  /** Files and links the sync owns, from the repository root. */
  generated: string[];
  /** Messages about what it changed or left alone. */
  log: string[];
}

function isGenerated(file: string): boolean {
  try {
    return isGeneratedText(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** Mark a Markdown document with frontmatter as installed by repo-kit. */
export function markInstalled(raw: string): string {
  if (!raw.startsWith("---\n")) throw new Error("no frontmatter");
  return `---\n# ${INSTALLED_NOTE}\n${raw.slice("---\n".length)}`;
}

// Written read-only, so an editor or agent gets an error instead of editing a
// file the next sync replaces. The sync unlinks first, so it is unaffected.
function writeGenerated(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  writeFileSync(file, content, { mode: 0o444 });
  return true;
}

/**
 * Put repo-kit's agents into .opencode/agents, where OpenCode reads them. A
 * repository's own file of the same name, one without the marker, wins.
 */
export function installAgents(root: string, result: SyncResult): void {
  const source = assetPath("agents");
  const directory = path.join(root, AGENTS_DIR);
  const names = new Set(
    readdirSync(source).filter((file) => file.endsWith(".md")),
  );
  if (existsSync(directory)) {
    for (const file of readdirSync(directory)) {
      const full = path.join(directory, file);
      if (!names.has(file) && isGenerated(full)) {
        rmSync(full);
        result.log.push(`removed ${AGENTS_DIR}/${file}`);
      }
    }
  }
  for (const file of names) {
    const target = path.join(directory, file);
    if (existsSync(target) && !isGenerated(target)) {
      result.log.push(`kept your own ${AGENTS_DIR}/${file}`);
      continue;
    }
    const content = markInstalled(
      readFileSync(path.join(source, file), "utf8"),
    );
    if (writeGenerated(target, content)) {
      result.log.push(`wrote ${AGENTS_DIR}/${file}`);
    }
    result.generated.push(`${AGENTS_DIR}/${file}`);
  }
}

/**
 * Put repo-kit's skills into .opencode/skills. A skill directory belongs to
 * repo-kit when its SKILL.md has the marker; a repository's own skill of the
 * same name wins.
 */
export function installSkills(root: string, result: SyncResult): void {
  const source = assetPath("skills");
  const directory = path.join(root, SKILLS_DIR);
  const names = new Set(readdirSync(source));
  // A skill directory that is a link points at files repo-kit did not put
  // there, so it is never repo-kit's.
  const owned = (name: string) =>
    !isSymlink(path.join(directory, name)) &&
    isGenerated(path.join(directory, name, "SKILL.md"));
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!names.has(name) && owned(name)) {
        rmSync(path.join(directory, name), { recursive: true, force: true });
        result.log.push(`removed ${SKILLS_DIR}/${name}`);
      }
    }
  }
  for (const name of names) {
    const target = path.join(directory, name);
    if (exists(target) && !owned(name)) {
      result.log.push(`kept your own ${SKILLS_DIR}/${name}`);
      continue;
    }
    const files = readdirSync(path.join(source, name), { recursive: true })
      .map(String)
      .filter((file) => lstatSync(path.join(source, name, file)).isFile());
    const wanted = new Set(files);
    if (existsSync(target)) {
      for (const file of readdirSync(target, { recursive: true }).map(String)) {
        const full = path.join(target, file);
        if (lstatSync(full).isFile() && !wanted.has(file)) rmSync(full);
      }
    }
    let changed = false;
    for (const file of files) {
      const raw = readFileSync(path.join(source, name, file), "utf8");
      const content = file === "SKILL.md" ? markInstalled(raw) : raw;
      changed = writeGenerated(path.join(target, file), content) || changed;
      result.generated.push(`${SKILLS_DIR}/${name}/${file}`);
    }
    if (changed) result.log.push(`wrote ${SKILLS_DIR}/${name}`);
  }
}

/**
 * Write every agent of .opencode/agents in each other tool's format.
 * Generated files of agents that are gone are removed; files without the
 * marker are never touched.
 */
export function convertAgents(root: string, result: SyncResult): void {
  const directory = ["agents", "agent"]
    .map((name) => path.join(root, ".opencode", name))
    .find((candidate) => existsSync(candidate));
  if (!directory) return;

  const agents = readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .flatMap((file) => {
      try {
        return [
          parseAgent(
            readFileSync(path.join(directory, file), "utf8"),
            file.slice(0, -".md".length),
          ),
        ];
      } catch (error) {
        result.log.push(
          `skipped ${file}: ${error instanceof Error ? error.message : error}`,
        );
        return [];
      }
    });

  for (const target of TARGETS) {
    const outDir = path.join(root, target.dir);
    const expected = new Set(
      agents.map((agent) => `${agent.name}${target.ext}`),
    );
    if (existsSync(outDir)) {
      for (const file of readdirSync(outDir)) {
        const full = path.join(outDir, file);
        if (!expected.has(file) && isGenerated(full)) {
          rmSync(full);
          result.log.push(`removed ${target.dir}/${file}`);
        }
      }
    }
    for (const agent of agents) {
      const relative = `${target.dir}/${agent.name}${target.ext}`;
      const full = path.join(root, relative);
      if (existsSync(full) && !isGenerated(full)) {
        result.log.push(`kept your own ${relative}`);
        continue;
      }
      if (writeGenerated(full, target.emit(agent))) {
        result.log.push(`wrote ${relative}`);
      }
      result.generated.push(relative);
    }
  }
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(file: string): boolean {
  return existsSync(file) || isSymlink(file);
}

/**
 * Link each tool's skill directory to .opencode/skills, so every tool sees
 * the same skills: a relative symlink, or a junction on Windows, which needs
 * no administrator rights. Only a missing directory is linked; whatever is
 * there already, a directory of the repository's own skills or a link it
 * chose, stays.
 */
export function linkSkills(root: string, result: SyncResult): void {
  const canonical = path.join(root, SKILLS_DIR);
  if (!existsSync(canonical)) return;
  for (const relative of SKILL_LINKS) {
    const link = path.join(root, relative);
    if (exists(link)) {
      let target: string | undefined;
      try {
        target = path.resolve(path.dirname(link), readlinkSync(link));
      } catch {
        // Not a link.
      }
      if (target === canonical) result.generated.push(relative);
      else result.log.push(`kept your own ${relative}`);
      continue;
    }
    mkdirSync(path.dirname(link), { recursive: true });
    if (process.platform === "win32") symlinkSync(canonical, link, "junction");
    else symlinkSync(path.relative(path.dirname(link), canonical), link);
    result.generated.push(relative);
    result.log.push(`linked ${relative} -> ${SKILLS_DIR}`);
  }
}

/**
 * Replace the managed block of the repository's info/exclude with the
 * generated paths. The file is the repository's own ignore list that is not
 * committed, so the repository needs no change when repo-kit adds a file.
 */
export function updateExclude(
  root: string,
  paths: string[],
): string | undefined {
  let file: string;
  try {
    file = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  file = path.resolve(root, file);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const begin = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END, begin);
  const kept = (
    begin === -1 || end === -1
      ? current
      : current.slice(0, begin) + current.slice(end + EXCLUDE_END.length)
  )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
  const block = [
    EXCLUDE_BEGIN,
    ...[...new Set(paths)].sort().map((entry) => `/${entry}`),
    EXCLUDE_END,
  ].join("\n");
  const next = `${kept ? `${kept}\n\n` : ""}${block}\n`;
  if (next !== current) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return file;
}

export function sync(root: string): SyncResult {
  const result: SyncResult = { generated: [], log: [] };
  installAgents(root, result);
  installSkills(root, result);
  convertAgents(root, result);
  linkSkills(root, result);
  updateExclude(root, result.generated);
  return result;
}

export function run(argv: string[]): void {
  if (argv.length > 0) throw new UsageError("Usage: repo-kit agents sync");
  for (const line of sync(repositoryRoot()).log) {
    console.log(`agents sync: ${line}`);
  }
}
