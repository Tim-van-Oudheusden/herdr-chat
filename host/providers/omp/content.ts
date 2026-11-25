// What only omp's messages carry. Content blocks are Pi's (../pi/content.ts).
//
// A skill invocation (`/skill:name args`) reaches the transcript as one
// `custom` message with customType "skill-prompt" (the skill's text, attributed
// to the user) instead of a user message; its `details` hold what was typed.
import type { SkillRef } from "../types.ts";

type Rec = Record<string, any>;

export const SKILL_PROMPT = "skill-prompt";

/** The skill a `skill-prompt` message invoked, and the text typed after it. */
export function skillInvocation(details: unknown): { skill: SkillRef; args: string } | null {
  const d = details as Rec | null;
  if (!d || typeof d !== "object" || typeof d.name !== "string" || !d.name) return null;
  return {
    skill: { name: d.name, command: `skill:${d.name}`, ...(typeof d.path === "string" ? { path: d.path } : {}) },
    args: typeof d.args === "string" ? d.args.trim() : "",
  };
}

/** A `skill-prompt` message as the person typed it ("/skill:name args"), or null. */
export function skillTyped(details: unknown): string | null {
  const s = skillInvocation(details);
  return s ? `/${s.skill.command}${s.args ? ` ${s.args}` : ""}` : null;
}
