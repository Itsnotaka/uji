import type { ModelThinkingLevel } from "@uji-ai/ai";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@uji-ai/ui";
import { IconBrain, IconSettingsGear1, IconUser } from "central-icons";
import { useState } from "react";

import type { RuntimeSettingsChange, UjiSnapshot } from "../desktop-api.ts";

export type ThemePreference = "system" | "light" | "dark";
type SettingsSection = "general" | "model";

const SETTINGS_SECTION_COPY = {
  general: {
    description: "Account and appearance settings.",
    title: "General",
  },
  model: {
    description: "Model and reasoning choices used for the next response.",
    title: "Model",
  },
} satisfies Record<SettingsSection, { description: string; title: string }>;

const THEME_OPTIONS = [
  { label: "Follow System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const satisfies readonly { label: string; value: ThemePreference }[];

export function SettingsDialog({
  onLogin,
  onLogout,
  onOpenChange,
  onRuntimeChange,
  onThemeChange,
  open,
  pendingAction,
  snapshot,
  theme,
}: {
  onLogin: () => void;
  onLogout: () => void;
  onOpenChange: (open: boolean) => void;
  onRuntimeChange: (change: RuntimeSettingsChange) => void;
  onThemeChange: (theme: ThemePreference) => void;
  open: boolean;
  pendingAction?: string;
  snapshot: UjiSnapshot;
  theme: ThemePreference;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const selectedModel = snapshot.runtime.models.find(
    (model) => model.key === snapshot.runtime.modelKey,
  );
  const sectionCopy = SETTINGS_SECTION_COPY[section];
  const hasRunningConversation = snapshot.conversations.some(
    (conversation) => conversation.running,
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="settings-dialog" showCloseButton>
        <aside className="settings-sidebar">
          <nav aria-label="Settings sections">
            <SettingsNavButton
              active={section === "general"}
              icon={<IconSettingsGear1 size={16} />}
              label="General"
              onClick={() => setSection("general")}
            />
            <SettingsNavButton
              active={section === "model"}
              icon={<IconBrain size={16} />}
              label="Model"
              onClick={() => setSection("model")}
            />
          </nav>
        </aside>

        <section className="settings-content">
          <DialogTitle>{sectionCopy.title}</DialogTitle>
          <DialogDescription className="visually-hidden">
            {sectionCopy.description}
          </DialogDescription>
          <div className="settings-panel-body">
            {section === "general" && (
              <div className="settings-panel">
                <SettingsGroup title="Account">
                  <div className="account-card">
                    <span className="account-card-mark">
                      <IconUser size={18} />
                    </span>
                    <span>
                      <strong>{snapshot.auth.signedIn ? "ChatGPT" : "Not connected"}</strong>
                      <small>{snapshot.auth.label}</small>
                    </span>
                    {snapshot.auth.signedIn ? (
                      <Button
                        disabled={pendingAction !== undefined || hasRunningConversation}
                        onClick={onLogout}
                        size="sm"
                        variant="outline"
                      >
                        {pendingAction === "logout" ? "Signing out…" : "Sign out"}
                      </Button>
                    ) : (
                      <Button disabled={pendingAction !== undefined} onClick={onLogin} size="sm">
                        {pendingAction === "login" ? "Waiting…" : "Connect"}
                      </Button>
                    )}
                  </div>
                </SettingsGroup>

                <SettingsGroup title="Appearance">
                  <label className="settings-control-row">
                    <span>
                      <strong>Theme</strong>
                    </span>
                    <select
                      aria-label="Theme"
                      onChange={(event) => {
                        const option = THEME_OPTIONS.find(
                          (candidate) => candidate.value === event.currentTarget.value,
                        );
                        if (option !== undefined) onThemeChange(option.value);
                      }}
                      value={theme}
                    >
                      {THEME_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </SettingsGroup>
              </div>
            )}

            {section === "model" && (
              <div className="settings-panel">
                <SettingsGroup title="Default model">
                  <label className="settings-control-row">
                    <span>
                      <strong>Model</strong>
                      <small>{selectedModel?.provider ?? "Provider unavailable"}</small>
                    </span>
                    <select
                      disabled={pendingAction !== undefined || hasRunningConversation}
                      onChange={(event) =>
                        onRuntimeChange({ kind: "model", modelKey: event.target.value })
                      }
                      value={snapshot.runtime.modelKey}
                    >
                      {snapshot.runtime.models.map((model) => (
                        <option key={model.key} value={model.key}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedModel !== undefined && (
                    <dl className="settings-facts-card">
                      <SettingsFact
                        label="Context window"
                        value={formatTokens(selectedModel.contextWindow)}
                      />
                      <SettingsFact
                        label="Max output"
                        value={formatTokens(selectedModel.maxTokens)}
                      />
                      <SettingsFact
                        label="Reasoning"
                        value={selectedModel.reasoning ? "Supported" : "Unavailable"}
                      />
                    </dl>
                  )}
                </SettingsGroup>

                <SettingsGroup title="Reasoning">
                  <label className="settings-control-row">
                    <span>
                      <strong>Effort</strong>
                      <small>Applied to new runs.</small>
                    </span>
                    <select
                      disabled={pendingAction !== undefined || hasRunningConversation}
                      onChange={(event) => {
                        const level = selectedModel?.thinkingLevels.find(
                          (candidate) => candidate === event.target.value,
                        );
                        if (level !== undefined) {
                          onRuntimeChange({ kind: "thinking", thinkingLevel: level });
                        }
                      }}
                      value={snapshot.runtime.thinkingLevel}
                    >
                      {(selectedModel?.thinkingLevels ?? ["off"]).map((level) => (
                        <ThinkingOption key={level} level={level} />
                      ))}
                    </select>
                  </label>
                </SettingsGroup>
              </div>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SettingsNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-current={active ? "page" : undefined} onClick={onClick} type="button">
      {icon}
      {label}
    </button>
  );
}

function SettingsGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SettingsFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ThinkingOption({ level }: { level: ModelThinkingLevel }) {
  return <option value={level}>{level === "off" ? "Off" : titleCase(level)}</option>;
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}
