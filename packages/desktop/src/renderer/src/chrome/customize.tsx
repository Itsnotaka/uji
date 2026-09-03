import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginInfo, SessionId, SettingInfo } from "@uji-ai/core";
import type { Skill } from "@uji-ai/schema";
import { Icon } from "../components/icons.tsx";
import { focus } from "../components/ui.tsx";
import { uji } from "../uji.ts";
import { customizeStyles as styles } from "./customize.stylex.ts";

interface CustomizeInventory {
  readonly plugins: readonly PluginInfo[];
  readonly settings: readonly SettingInfo[];
  readonly skills: readonly Skill[];
}

function pluginDetail(plugin: PluginInfo): string {
  if (plugin.status === "failed") return plugin.error;
  return `${plugin.source} · ${plugin.version}`;
}

function InventoryLoading(): ReactElement {
  return (
    <>
      {(["connections", "skills"] as const).map((key) => (
        <section key={key} aria-busy="true" {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHeading)}>
            <div {...stylex.props(styles.loadingLine)} />
          </div>
          <div {...stylex.props(styles.list)}>
            <div {...stylex.props(styles.quiet)}>
              <div {...stylex.props(styles.loadingLine)} />
            </div>
            <div {...stylex.props(styles.quiet)}>
              <div {...stylex.props(styles.loadingLine)} />
            </div>
          </div>
        </section>
      ))}
    </>
  );
}

function PluginSettings({
  sessionId,
  settings,
}: {
  sessionId: SessionId;
  settings: readonly SettingInfo[];
}): ReactElement | null {
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | undefined>();
  const apply = useMutation({
    mutationFn: (input: { id: string; choiceId: string }) =>
      uji.plugins.settings.apply({ sessionId, ...input }),
    onSuccess: (outcome) => {
      if (outcome.kind !== "applied") {
        setFailure("That setting is no longer available.");
        return;
      }
      setFailure(undefined);
      void client.invalidateQueries({ queryKey: ["customize", sessionId] });
    },
    onError: (cause) => {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    },
  });

  if (settings.length === 0) return null;
  return (
    <section aria-labelledby="customize-settings-title" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHeading)}>
        <h2 id="customize-settings-title" {...stylex.props(styles.sectionTitle)}>
          Plugin settings
        </h2>
        <p {...stylex.props(styles.sectionDescription)}>
          Choices supplied by the active plugins for this session.
        </p>
      </div>
      <div {...stylex.props(styles.list)}>
        {settings.map((setting) => (
          <label key={setting.id} {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowBody)}>
              <span {...stylex.props(styles.rowTitle)}>{setting.label}</span>
              <span {...stylex.props(styles.rowDetail)}>{setting.owner}</span>
            </span>
            <select
              aria-label={setting.label}
              disabled={apply.isPending}
              value={setting.current}
              {...stylex.props(styles.select, focus.ring)}
              onChange={(event) => {
                const choiceId = event.target.value;
                if (setting.choices.some((choice) => choice.id === choiceId)) {
                  apply.mutate({ id: setting.id, choiceId });
                }
              }}
            >
              {setting.choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {failure !== undefined && <div {...stylex.props(styles.error)}>{failure}</div>}
    </section>
  );
}

function Inventory({
  sessionId,
  inventory,
}: {
  sessionId: SessionId;
  inventory: CustomizeInventory;
}): ReactElement {
  return (
    <>
      <section aria-labelledby="customize-connections-title" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionHeading)}>
          <h2 id="customize-connections-title" {...stylex.props(styles.sectionTitle)}>
            MCP servers and plugins
          </h2>
          <p {...stylex.props(styles.sectionDescription)}>
            Host extensions available to this session. Failed connections stay visible.
          </p>
        </div>
        <div {...stylex.props(styles.list)}>
          {inventory.plugins.length === 0 ? (
            <div {...stylex.props(styles.quiet)}>No MCP servers or plugins reported.</div>
          ) : (
            inventory.plugins.map((plugin) => (
              <div key={plugin.id} {...stylex.props(styles.row)}>
                <span {...stylex.props(styles.rowIcon)}>
                  <Icon name="globe" size={14} />
                </span>
                <span {...stylex.props(styles.rowBody)}>
                  <span {...stylex.props(styles.rowTitle)}>{plugin.id}</span>
                  <span title={pluginDetail(plugin)} {...stylex.props(styles.rowDetail)}>
                    {pluginDetail(plugin)}
                  </span>
                </span>
                <span
                  {...stylex.props(styles.badge, plugin.status === "failed" && styles.failedBadge)}
                >
                  {plugin.status}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section aria-labelledby="customize-skills-title" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionHeading)}>
          <h2 id="customize-skills-title" {...stylex.props(styles.sectionTitle)}>
            Skills
          </h2>
          <p {...stylex.props(styles.sectionDescription)}>
            Instructions Uji can load when a task matches them.
          </p>
        </div>
        <div {...stylex.props(styles.list)}>
          {inventory.skills.length === 0 ? (
            <div {...stylex.props(styles.quiet)}>No skills found for this workspace.</div>
          ) : (
            inventory.skills.map((skill) => (
              <div key={skill.filePath} {...stylex.props(styles.row)}>
                <span {...stylex.props(styles.rowIcon)}>
                  <Icon name="sparkle" size={14} />
                </span>
                <span {...stylex.props(styles.rowBody)}>
                  <span {...stylex.props(styles.rowTitle)}>{skill.name}</span>
                  <span title={skill.description} {...stylex.props(styles.rowDetail)}>
                    {skill.description}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <PluginSettings sessionId={sessionId} settings={inventory.settings} />
    </>
  );
}

export function CustomizeSettings({
  sessionId,
}: {
  sessionId: SessionId | undefined;
}): ReactElement {
  const inventory = useQuery<CustomizeInventory>({
    queryKey: ["customize", sessionId],
    enabled: sessionId !== undefined,
    queryFn: async () => {
      if (sessionId === undefined) return { plugins: [], settings: [], skills: [] };
      const [plugins, settings, skills] = await Promise.all([
        uji.plugins.list({ sessionId }),
        uji.plugins.settings.list({ sessionId }),
        uji.plugins.resources.list({ sessionId }),
      ]);
      return { plugins, settings, skills };
    },
  });

  if (sessionId === undefined) {
    return (
      <div {...stylex.props(styles.noSession)}>
        <div {...stylex.props(styles.noSessionTitle)}>Start a chat to inspect its setup</div>
        <div {...stylex.props(styles.noSessionDetail)}>
          MCP servers, plugins, and skills are activated per session. New Chat stays empty until you
          send the first message.
        </div>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.root)}>
      {inventory.isPending && <InventoryLoading />}
      {inventory.isError && (
        <div role="alert" {...stylex.props(styles.error)}>
          {inventory.error.message}
        </div>
      )}
      {inventory.data !== undefined && (
        <Inventory sessionId={sessionId} inventory={inventory.data} />
      )}
    </div>
  );
}
