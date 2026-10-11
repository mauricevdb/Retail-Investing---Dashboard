// JSON schemas for structured output. Kept strict-compatible: every object is closed and lists
// all its keys as required; optional values are nullable instead. No recursion (sub-sections are
// a separate, childless schema).
import type { Assignment, NewSection } from "../core/mapMerge";
import type { DashboardDecision, FileDigest, LinkKind, PlanOp, Resource, Understanding } from "../core/types";
import { DOC_TYPES } from "../core/types";

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const nstr: Schema = { type: ["string", "null"] };
const strs: Schema = { type: "array", items: str };
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: Schema): Schema => ({ type: "array", items });
const docType: Schema = { type: "string", enum: [...DOC_TYPES] };

export const DIGEST_SCHEMA = obj({
  files: arr(obj({ path: str, docType, title: str, summary: str, topics: strs, sequence: nstr, transcript: nstr })),
});

const resource = obj({ path: str, role: docType, label: str });
const sectionFields = { id: str, title: str, summary: str, keywords: strs, dependsOn: strs, folder: nstr, resources: arr(resource) };
const section = obj({ ...sectionFields, children: arr(obj(sectionFields)) });
const op = obj({
  kind: { type: "string", enum: ["mkdir", "move", "archive", "create_note", "append_note", "transcribe", "integrate"] },
  source: nstr,
  sources: { type: ["array", "null"], items: str },
  target: nstr,
  content: nstr,
  reason: str,
});

export const INITIAL_SCHEMA = obj({
  understanding: obj({ kind: str, purpose: str, usage: str, principle: str }),
  summary: str,
  questions: strs,
  changes: strs,
  dashboards: arr(obj({ path: str, decision: { type: "string", enum: ["keep", "merge", "archive"] }, rationale: str })),
  ops: arr(op),
  map: obj({
    dashboardTitle: str,
    linkKind: { type: "string", enum: ["prerequisite", "sequence", "none"] },
    summary: str,
    conventions: str,
    preferences: strs,
    sections: arr(section),
    transverse: arr(resource),
  }),
});

export const INCREMENTAL_SCHEMA = obj({
  summary: str,
  questions: strs,
  changes: strs,
  ops: arr(op),
  newSections: arr(obj({ id: str, title: str, summary: str, keywords: strs, dependsOn: strs, parentId: nstr, folder: nstr })),
  assignments: arr(obj({ path: str, sectionId: nstr, role: docType, label: str })),
  keywordUpdates: arr(obj({ sectionId: str, keywords: strs })),
  preferences: strs,
});

export const MERGE_SCHEMA = obj({ content: str, summary: str });

export const ROUTE_SCHEMA = obj({
  routes: arr(obj({ path: str, space: nstr, reason: str })),
});

// Shapes of the answers.

export interface DigestAnswer {
  files: (FileDigest & { path: string })[];
}

export interface RawSection {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  dependsOn: string[];
  folder: string | null;
  resources: Resource[];
  children?: RawSection[];
}

export interface InitialAnswer {
  understanding: Understanding;
  summary: string;
  questions: string[];
  changes: string[];
  dashboards: DashboardDecision[];
  ops: PlanOp[];
  map: {
    dashboardTitle: string;
    linkKind: LinkKind;
    summary: string;
    conventions: string;
    preferences: string[];
    sections: RawSection[];
    transverse: Resource[];
  };
}

export interface IncrementalAnswer {
  summary: string;
  questions: string[];
  changes: string[];
  ops: PlanOp[];
  newSections: NewSection[];
  assignments: Assignment[];
  keywordUpdates: { sectionId: string; keywords: string[] }[];
  preferences: string[];
}

export interface MergeAnswer {
  content: string;
  summary: string;
}

export interface RouteAnswer {
  routes: { path: string; space: string | null; reason: string }[];
}
