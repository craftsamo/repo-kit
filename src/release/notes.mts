// The release notes and the version of the next release, worked out from the
// pull requests whose merge commit landed on main since the last release.
// Matching a pull request by its merge commit rather than by its base branch
// is what keeps every layer of a stacked pull request merged in one go: the
// upper layers merge into the branch below them, yet their merge commit is the
// one that lands on main.

export type Increment = "major" | "minor" | "patch";

export interface Category {
  title: string;
  // Omitted for the one category that takes every pull request the others
  // did not.
  labels?: string[];
  increment?: Exclude<Increment, "major">;
}

export interface NotesConfig {
  name: string;
  tagPrefix: string;
  exclude: string[];
  major: string[];
  titleEscapes: string;
  categories: Category[];
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  labels: string[];
  mergedAt: string;
  mergeCommit: string;
}

export interface Section {
  title: string;
  pullRequests: PullRequest[];
}

const INCREMENTS: Increment[] = ["patch", "minor", "major"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "")
  ) {
    throw new Error(`${field} must be a list of label names.`);
  }
  return value as string[];
}

export function parseNotesConfig(source: string): NotesConfig {
  const raw = JSON.parse(source) as Record<string, unknown>;
  for (const field of ["name", "tagPrefix", "titleEscapes"]) {
    if (typeof raw[field] !== "string") {
      throw new Error(`${field} must be a string.`);
    }
  }
  if (!(raw.name as string).includes("{version}")) {
    throw new Error("name must contain {version}.");
  }
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
    throw new Error("categories must list at least one category.");
  }
  const categories = (raw.categories as Array<Record<string, unknown>>).map(
    (category, index): Category => {
      if (typeof category.title !== "string" || category.title === "") {
        throw new Error(`categories[${index}].title must be a string.`);
      }
      const increment = category.increment;
      if (
        increment !== undefined &&
        increment !== "minor" &&
        increment !== "patch"
      ) {
        throw new Error(
          `categories[${index}].increment must be "minor" or "patch".`,
        );
      }
      return {
        title: category.title,
        ...(category.labels === undefined
          ? {}
          : {
              labels: stringList(
                category.labels,
                `categories[${index}].labels`,
              ),
            }),
        ...(increment === undefined ? {} : { increment }),
      };
    },
  );
  if (categories.filter((category) => !category.labels).length > 1) {
    throw new Error("Only one category may omit labels.");
  }
  return {
    name: raw.name as string,
    tagPrefix: raw.tagPrefix as string,
    exclude: stringList(raw.exclude ?? [], "exclude"),
    major: stringList(raw.major ?? [], "major"),
    titleEscapes: raw.titleEscapes as string,
    categories,
  };
}

/**
 * The pull requests whose merge commit is one of `commits`, once each,
 * newest first. A search for merged pull requests also returns those merged
 * into other long-lived branches, or before the last release; their merge
 * commit is not in the range, so they drop out here.
 */
export function pullRequestsInRange(
  pullRequests: PullRequest[],
  commits: Set<string>,
): PullRequest[] {
  const byNumber = new Map<number, PullRequest>();
  for (const pullRequest of pullRequests) {
    if (commits.has(pullRequest.mergeCommit)) {
      byNumber.set(pullRequest.number, pullRequest);
    }
  }
  return [...byNumber.values()].sort(
    (a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number,
  );
}

function categoryOf(
  pullRequest: PullRequest,
  config: NotesConfig,
): Category | undefined {
  return (
    config.categories.find((category) =>
      category.labels?.some((label) => pullRequest.labels.includes(label)),
    ) ?? config.categories.find((category) => !category.labels)
  );
}

/**
 * The sections of the notes, in the configured order, and the increment the
 * next version takes. A pull request lands under the first category whose
 * label it carries, and an excluded one counts for neither. Without any
 * pull request left, there is nothing to release.
 */
export function releaseChanges(
  pullRequests: PullRequest[],
  config: NotesConfig,
): { sections: Section[]; increment: Increment } | undefined {
  const included = pullRequests.filter(
    (pullRequest) =>
      !pullRequest.labels.some((label) => config.exclude.includes(label)),
  );
  if (included.length === 0) return undefined;

  const sections = new Map<Category, PullRequest[]>();
  let increment: Increment = "patch";
  const raise = (to: Increment) => {
    if (INCREMENTS.indexOf(to) > INCREMENTS.indexOf(increment)) increment = to;
  };
  for (const pullRequest of included) {
    if (pullRequest.labels.some((label) => config.major.includes(label))) {
      raise("major");
    }
    const category = categoryOf(pullRequest, config);
    if (!category) continue;
    raise(category.increment ?? "patch");
    sections.set(category, [...(sections.get(category) ?? []), pullRequest]);
  }
  return {
    sections: config.categories
      .filter((category) => sections.has(category))
      .map((category) => ({
        title: category.title,
        pullRequests: sections.get(category)!,
      })),
    increment,
  };
}

export function nextVersion(previous: string, increment: Increment): string {
  const match = SEMVER.exec(previous);
  if (!match) throw new Error(`"${previous}" is not a semantic version.`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  if (increment === "major") return `${major + 1}.0.0`;
  if (increment === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version a release tag names, or undefined for a tag of another shape. */
export function versionOfTag(
  tag: string,
  config: NotesConfig,
): string | undefined {
  if (!tag.startsWith(config.tagPrefix)) return undefined;
  const version = tag.slice(config.tagPrefix.length);
  return SEMVER.test(version) ? version : undefined;
}

/**
 * The title with Markdown characters escaped, except inside backtick code
 * spans, which Markdown already shows literally.
 */
export function escapeTitle(title: string, escapes: string): string {
  return title
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : [...part]
            .map((character) =>
              escapes.includes(character) ? `\\${character}` : character,
            )
            .join(""),
    )
    .join("");
}

export function renderNotes(sections: Section[], config: NotesConfig): string {
  return `${sections
    .map(
      (section) =>
        `## ${section.title}\n\n${section.pullRequests
          .map(
            (pullRequest) =>
              `- ${escapeTitle(pullRequest.title, config.titleEscapes)} @${pullRequest.author} (#${pullRequest.number})`,
          )
          .join("\n")}`,
    )
    .join("\n\n")}\n`;
}
