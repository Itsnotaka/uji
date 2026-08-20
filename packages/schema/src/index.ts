/**
 * Wire types shared by core, ai, and clients.
 *
 * The neutral message model (`message.ts`), the model description
 * (`model.ts`), and the tool and request context (`tool.ts`) are the contract
 * every provider adapter meets.
 */
export * from "./message.ts";
export * from "./model.ts";
export * from "./tool.ts";

/**
 * A skill: a folder with a `SKILL.md` whose frontmatter names it and says when
 * to use it. The catalog (name, description, filePath) goes into the system
 * prompt; the body is loaded on demand. Shared by core, the skills plugin, and
 * clients, so it lives on the wire.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/types.ts
 */
export interface Skill {
  /** Stable skill name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions. */
  content: string;
  /** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
  filePath: string;
  /** Exclude this skill from model-visible skill lists while still allowing explicit invocation. */
  disableModelInvocation?: boolean;
}

/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
  /** Stable template name used for lookup or command routing. */
  name: string;
  /** Optional description for command lists or autocomplete. */
  description?: string;
  /** Template content. Argument placeholders are formatted at invocation. */
  content: string;
}
