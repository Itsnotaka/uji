/** Discover skills once per plugin activation and expose their catalog to the harness. */
import type { Skill } from "@uji-ai/schema";
import { formatSkillsForPrompt, loadSkills } from "../../skills.ts";
import { definePlugin } from "../types.ts";

export const SKILLS_PLUGIN_ID = "skills";

export interface SkillsOptions {
  readonly directories: readonly string[];
}

export function skillsPlugin(options: SkillsOptions) {
  return definePlugin({
    id: SKILLS_PLUGIN_ID,
    async session(api) {
      const loaded = await loadSkills(options.directories);
      for (const diagnostic of loaded.diagnostics) {
        api.diagnostics.warn(`${diagnostic.path}: ${diagnostic.message}`);
      }

      const skills: Skill[] = [];
      const pathsByName = new Map<string, string>();
      for (const skill of loaded.skills) {
        const previousPath = pathsByName.get(skill.name);
        if (previousPath !== undefined) {
          api.diagnostics.warn(
            `skill "${skill.name}" from ${skill.filePath} was ignored; first loaded from ${previousPath}`,
          );
          continue;
        }
        pathsByName.set(skill.name, skill.filePath);
        skills.push(skill);
      }

      api.resources.add((draft) => {
        for (const skill of skills) {
          if (!draft.has(skill.name)) draft.set(skill.name, skill);
        }
      });

      const catalog = formatSkillsForPrompt(skills);
      if (catalog !== "") {
        api.prompt.add((draft) => draft.set("available-skills", { text: catalog, order: 90 }));
      }
    },
  });
}
