import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { repositoryRoot } from "../repository-root.mts";
import { api } from "./gh.mts";
import type { ApiRequest } from "./gh.mts";

/** The file a repository declares its labels in, from its root. */
export const LABELS_FILE = ".github/labels.yml";

const PAGE_SIZE = 100;

export interface Label {
  name: string;
  description: string;
  color: string;
}

export interface CurrentLabel {
  name: string;
  description: string | null;
  color: string;
}

export interface LabelUpdate {
  current: CurrentLabel;
  desired: Label;
}

export interface LabelDiff {
  create: Label[];
  update: LabelUpdate[];
  remove: CurrentLabel[];
}

/**
 * Parse a labels manifest: a YAML list of `name`, `description` and `color`
 * entries, as action-label-syncer reads it.
 */
export function parseLabels(source: string): Label[] {
  const labels: Label[] = [];
  let label: Partial<Label> | undefined;

  for (const line of source.split("\n")) {
    const name = line.match(/^\s*- name:\s*(.+)\s*$/);
    if (name) {
      if (label) labels.push(validateLabel(label));
      label = { name: parseYamlString(name[1] as string) };
      continue;
    }

    const property = line.match(/^\s+(description|color):\s*(.+)\s*$/);
    if (label && property) {
      const key = property[1] as "description" | "color";
      label[key] = parseYamlString(property[2] as string);
    }
  }

  if (label) labels.push(validateLabel(label));
  if (labels.length === 0)
    throw new Error(`No labels found in ${LABELS_FILE}.`);
  return labels;
}

function parseYamlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
  if (trimmed.startsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function validateLabel(label: Partial<Label>): Label {
  if (!label.name || label.description === undefined || !label.color) {
    throw new Error(`Incomplete label definition: ${label.name ?? "unknown"}`);
  }
  return label as Label;
}

/**
 * The labels the repository declares, or undefined when it declares none.
 * A repository without the file keeps the labels it has.
 */
export function readLabels(
  root: string = repositoryRoot(),
): Label[] | undefined {
  const file = path.join(root, LABELS_FILE);
  return existsSync(file) ? parseLabels(readFileSync(file, "utf8")) : undefined;
}

export function diffLabels(
  desired: Label[],
  current: CurrentLabel[],
): LabelDiff {
  const currentByName = new Map(
    current.map((label) => [label.name.toLowerCase(), label]),
  );
  const desiredNames = new Set(
    desired.map((label) => label.name.toLowerCase()),
  );
  const create = [];
  const update = [];

  for (const label of desired) {
    const existing = currentByName.get(label.name.toLowerCase());
    if (!existing) {
      create.push(label);
      continue;
    }
    if (
      existing.name !== label.name ||
      (existing.description ?? "") !== label.description ||
      existing.color.toLowerCase() !== label.color.toLowerCase()
    ) {
      update.push({ current: existing, desired: label });
    }
  }

  const remove = current.filter(
    (label) => !desiredNames.has(label.name.toLowerCase()),
  );
  return { create, update, remove };
}

/** Every label of the repository, page by page. */
export function getCurrentLabels(
  repository: string,
  request: ApiRequest = api,
): CurrentLabel[] {
  const labels: CurrentLabel[] = [];
  for (let page = 1; ; page += 1) {
    const batch =
      request<CurrentLabel[]>(
        "GET",
        `/repos/${repository}/labels?per_page=${PAGE_SIZE}&page=${page}`,
      ) ?? [];
    labels.push(...batch);
    if (batch.length < PAGE_SIZE) return labels;
  }
}

export function applyLabels(
  repository: string,
  changes: LabelDiff,
  request: ApiRequest = api,
): void {
  for (const label of changes.create) {
    request("POST", `/repos/${repository}/labels`, label);
  }
  for (const { current, desired } of changes.update) {
    request(
      "PATCH",
      `/repos/${repository}/labels/${encodeURIComponent(current.name)}`,
      {
        new_name: desired.name,
        color: desired.color,
        description: desired.description,
      },
    );
  }
  for (const label of changes.remove) {
    request(
      "DELETE",
      `/repos/${repository}/labels/${encodeURIComponent(label.name)}`,
    );
  }
}

export function printLabelDiff(changes: LabelDiff): void {
  console.log("\nLabels");
  for (const label of changes.create) console.log(`  Create: ${label.name}`);
  for (const { current, desired } of changes.update) {
    console.log(`  Update: ${current.name} -> ${desired.name}`);
  }
  for (const label of changes.remove) console.log(`  Delete: ${label.name}`);
  if (
    !changes.create.length &&
    !changes.update.length &&
    !changes.remove.length
  ) {
    console.log("  No changes.");
  }
}
