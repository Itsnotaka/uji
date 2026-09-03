import { blobatarUri } from "blobatar/uri";

import type { Agent, AgentTone } from "../agents.ts";

/**
 * A tone pins the blobatar's hue. "neutral" lets blobatar derive the colour from the name,
 * so the default is a colour nobody had to choose.
 */
const TONE_HUE: Record<Exclude<AgentTone, "neutral">, number> = {
  orange: 28,
  blue: 232,
  violet: 282,
  green: 152,
};

const AVATAR_PX = { xs: 24, sm: 28, md: 32, lg: 40, xl: 72 } as const;

export type AvatarSize = keyof typeof AVATAR_PX;

/** Same name, same face: the blobatar is derived from the assistant's name and tone. */
export function agentAvatarUri(name: string, tone: AgentTone): string {
  const seed = name.trim() === "" ? "New assistant" : name.trim();
  return blobatarUri(seed, tone === "neutral" ? {} : { hue: TONE_HUE[tone] });
}

export function AgentAvatar({
  agent,
  size = "md",
}: {
  agent: Pick<Agent, "avatar" | "name">;
  size?: AvatarSize;
}) {
  const px = AVATAR_PX[size];
  return (
    <img
      alt=""
      className="blob-avatar"
      data-size={size}
      draggable={false}
      height={px}
      src={agentAvatarUri(agent.name, agent.avatar)}
      width={px}
    />
  );
}

/** The signed-in person: a circle-backed blobatar seeded from the account label. */
export function PersonAvatar({
  name,
  offline = false,
  size = "lg",
}: {
  name: string;
  offline?: boolean;
  size?: AvatarSize;
}) {
  const px = AVATAR_PX[size];
  return (
    <img
      alt=""
      className="blob-avatar person-avatar"
      data-offline={offline || undefined}
      data-size={size}
      draggable={false}
      height={px}
      src={blobatarUri(name.trim() === "" ? "you" : name.trim(), { background: "circle" })}
      width={px}
    />
  );
}
