// Structured-output schemas of the synthesis pipeline (strict-compatible: closed objects, all keys required).
type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const strs: Schema = { type: "array", items: str };
const bool: Schema = { type: "boolean" };
const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: Schema): Schema => ({ type: "array", items });

export const PHOTO_SCHEMA = obj({ description: str, transcript: str, uncertain: strs });
export const VERIFY_SCHEMA = obj({ transcript: str, corrections: strs, uncertain: strs });
export const PDF_SCHEMA = obj({ text: str, uncertain: strs });

export const PLAN_SCHEMA = obj({
  session: str,
  summary: str,
  sources: arr(obj({ sourceId: str, role: str, contributes: str })),
  issues: strs,
  module: obj({ id: str, title: str, mode: { type: "string", enum: ["new", "existing"] }, folder: str, dependsOn: strs, summary: str }),
  fiches: arr(
    obj({
      id: str,
      title: str,
      path: str,
      action: { type: "string", enum: ["create", "extend"] },
      objective: str,
      outline: strs,
      sources: arr(obj({ sourceId: str, what: str })),
      dependsOn: strs,
      keywords: strs,
    }),
  ),
  questions: strs,
  changes: strs,
  preferences: strs,
});

export const WRITE_SCHEMA = obj({ content: str, summary: str });
export const COVERAGE_SCHEMA = obj({ sources: arr(obj({ sourceId: str, covered: bool, missing: arr(obj({ item: str, fiche: str })) })) });

export interface PhotoAnswer {
  description: string;
  transcript: string;
  uncertain: string[];
}
export interface VerifyAnswer {
  transcript: string;
  corrections: string[];
  uncertain: string[];
}
export interface PdfAnswer {
  text: string;
  uncertain: string[];
}
export interface WriteAnswer {
  content: string;
  summary: string;
}
export interface CoverageAnswer {
  sources: { sourceId: string; covered: boolean; missing: { item: string; fiche: string }[] }[];
}
