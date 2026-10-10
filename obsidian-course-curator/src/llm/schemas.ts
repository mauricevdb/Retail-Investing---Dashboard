// JSON schemas for structured output. Kept strict-compatible: every object is closed and lists
// all its keys as required; optional values are nullable instead. No recursion (sub-modules are
// a separate, childless schema).
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
  files: arr(
    obj({
      path: str,
      docType,
      title: str,
      summary: str,
      topics: strs,
      sequence: nstr,
      transcript: nstr,
    }),
  ),
});

const resource = obj({ path: str, role: docType, label: str });
const moduleFields = {
  id: str,
  title: str,
  summary: str,
  concepts: strs,
  prerequisites: strs,
  folder: nstr,
  resources: arr(resource),
};
const childModule = obj(moduleFields);
const module = obj({ ...moduleFields, children: arr(childModule) });

const op = obj({
  kind: { type: "string", enum: ["mkdir", "move", "archive", "create_note", "append_note", "transcribe"] },
  source: nstr,
  target: nstr,
  content: nstr,
  reason: str,
});

export const ONBOARD_SCHEMA = obj({
  summary: str,
  questions: strs,
  dashboards: arr(obj({ path: str, decision: { type: "string", enum: ["keep", "merge", "archive"] }, rationale: str })),
  ops: arr(op),
  courseMap: obj({ summary: str, modules: arr(module), transverse: arr(resource) }),
});

export const INCREMENTAL_SCHEMA = obj({
  summary: str,
  questions: strs,
  ops: arr(op),
  newModules: arr(
    obj({ id: str, title: str, summary: str, concepts: strs, prerequisites: strs, parentId: nstr, folder: nstr }),
  ),
  assignments: arr(obj({ path: str, moduleId: nstr, role: docType, label: str })),
  conceptUpdates: arr(obj({ moduleId: str, concepts: strs })),
});

export const ROUTE_SCHEMA = obj({
  routes: arr(obj({ path: str, course: nstr, reason: str })),
});

// Shapes of the answers.
import type { DashboardDecision, FileDigest, PlanOp, Resource } from "../core/types";
import type { Assignment, NewModule } from "../core/mapMerge";

export interface DigestAnswer {
  files: (FileDigest & { path: string })[];
}

export interface RawModule {
  id: string;
  title: string;
  summary: string;
  concepts: string[];
  prerequisites: string[];
  folder: string | null;
  resources: Resource[];
  children?: RawModule[];
}

export interface OnboardAnswer {
  summary: string;
  questions: string[];
  dashboards: DashboardDecision[];
  ops: PlanOp[];
  courseMap: { summary: string; modules: RawModule[]; transverse: Resource[] };
}

export interface IncrementalAnswer {
  summary: string;
  questions: string[];
  ops: PlanOp[];
  newModules: NewModule[];
  assignments: Assignment[];
  conceptUpdates: { moduleId: string; concepts: string[] }[];
}

export interface RouteAnswer {
  routes: { path: string; course: string | null; reason: string }[];
}
