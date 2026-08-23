import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { AuthInteraction, AuthPrompt } from "@uji-ai/ai";

async function ask(message: string, signal: AbortSignal): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message, { signal });
  } finally {
    rl.close();
  }
}

/**
 * CLI driver for the login funnel: prompts over readline, events to stdout.
 * A GUI implements this same interface with windows and forms.
 */
export function cliInteraction(signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt): Promise<string> {
      const promptSignal =
        prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal]);
      if (prompt.type === "select") {
        for (const [index, option] of prompt.options.entries()) {
          console.log(`  ${String(index + 1)}. ${option.label}`);
        }
        const answer = await ask(`${prompt.message} [1] `, promptSignal);
        const choice = prompt.options[Number(answer.trim() || "1") - 1];
        if (choice === undefined) throw new Error(`Invalid choice: ${answer}`);
        return choice.id;
      }
      const hint = prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`;
      return ask(`${prompt.message}${hint} `, promptSignal);
    },
    notify(event) {
      switch (event.type) {
        case "auth_url":
          console.log(
            `\n${event.instructions ?? "Open this URL to continue:"}\n\n  ${event.url}\n`,
          );
          break;
        case "device_code":
          console.log(`\nVisit ${event.verificationUri} and enter code: ${event.userCode}\n`);
          break;
        case "info":
        case "progress":
          console.log(event.message);
          break;
      }
    },
  };
}
