import { useMemo, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from "react";

type Agent = {
  id: string;
  name: string;
  role: string;
  description: string;
  accent: string;
  mark: string;
};

type ChatMessage = {
  id: string;
  author: "bot" | "user";
  body: ReactNode;
  note?: string;
};

const agents: Agent[] = [
  {
    id: "june",
    name: "June",
    role: "Chief of staff",
    description:
      "Keeps projects moving, follows up on loose ends, and coordinates the rest of your team.",
    accent: "#e77b4f",
    mark: "J",
  },
  {
    id: "tweeter",
    name: "Tweeter",
    role: "Social editor",
    description:
      "Finds the strongest angle, drafts posts in your voice, and keeps an eye on the conversation.",
    accent: "#3389e9",
    mark: "T",
  },
  {
    id: "slacker",
    name: "Slacker",
    role: "Team concierge",
    description:
      "Summarizes busy channels, catches unanswered questions, and turns decisions into follow-ups.",
    accent: "#7a65d1",
    mark: "S",
  },
  {
    id: "rawr",
    name: "Rawr",
    role: "Research lead",
    description:
      "Runs focused research sprints and returns with a clear recommendation instead of a link pile.",
    accent: "#54a66f",
    mark: "R",
  },
];

const initialMessages: Record<string, ChatMessage[]> = {
  june: [
    {
      id: "june-1",
      author: "bot",
      body: "Morning! I pulled the open threads from yesterday. Want the short version?",
      note: "9:41 AM",
    },
    {
      id: "june-2",
      author: "user",
      body: "Yes — and can you make sure the launch brief is ready before our 2 PM review?",
      note: "9:43 AM",
    },
    {
      id: "june-3",
      author: "bot",
      body: (
        <>
          Already on it. I’ll consolidate the latest feedback, ask Tweeter for the final positioning
          line, and leave you a review-ready brief by 1:15 PM.
        </>
      ),
      note: "9:43 AM",
    },
  ],
  tweeter: [
    {
      id: "tweeter-1",
      author: "bot",
      body: "I found three launch angles. The direct, product-first version is winning so far.",
      note: "8:24 AM",
    },
    {
      id: "tweeter-2",
      author: "user",
      body: "Use that one. Keep it confident, not breathless.",
      note: "8:31 AM",
    },
  ],
  slacker: [
    {
      id: "slacker-1",
      author: "bot",
      body: "Seven channels checked. Two decisions need an owner; everything else is moving.",
      note: "10:02 AM",
    },
  ],
  rawr: [
    {
      id: "rawr-1",
      author: "user",
      body: "Compare the onboarding patterns we bookmarked and recommend one for the demo.",
      note: "Yesterday",
    },
    {
      id: "rawr-2",
      author: "bot",
      body: "Got it. I’ll optimize for time-to-value and keep host-specific setup out of the first run.",
      note: "Yesterday",
    },
  ],
};

type IconName =
  | "arrow-up"
  | "calendar"
  | "chevron"
  | "compose"
  | "more"
  | "paperclip"
  | "plus"
  | "search"
  | "settings"
  | "x";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-up": (
      <>
        <path d="M12 19V5" />
        <path d="m6 11 6-6 6 6" />
      </>
    ),
    calendar: (
      <>
        <path d="M6 2v4M18 2v4M3 9h18" />
        <rect x="3" y="4" width="18" height="18" rx="3" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    compose: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    paperclip: (
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.04a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.04a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
      </>
    ),
    x: <path d="M18 6 6 18M6 6l12 12" />,
  };

  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {paths[name]}
      </g>
    </svg>
  );
}

function Avatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`agent-avatar${large ? " agent-avatar-large" : ""}`}
      style={{ "--agent-accent": agent.accent } as CSSProperties}
    >
      <span>{agent.mark}</span>
    </span>
  );
}

export function App() {
  const [selectedId, setSelectedId] = useState("june");
  const [query, setQuery] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth > 720);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);

  const activeAgent = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const filteredAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.role}`.toLowerCase().includes(normalized),
    );
  }, [query]);

  function selectAgent(id: string) {
    setSelectedId(id);
    setSettingsOpen(false);
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    const message: ChatMessage = {
      id: `${selectedId}-${Date.now()}`,
      author: "user",
      body,
      note: "Now",
    };

    setMessages((current) => ({
      ...current,
      [selectedId]: [...(current[selectedId] ?? []), message],
    }));
    setDraft("");
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const activeMessages = messages[selectedId] ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-topbar">
          <div className="brand-lockup" aria-label="Grok Bot">
            <span className="brand-mark">G</span>
            <span className="brand-name">Grok Bot</span>
          </div>
          <button
            className="icon-button sidebar-compose"
            type="button"
            aria-label="New conversation"
          >
            <Icon name="compose" size={17} />
          </button>
        </div>

        <label className="agent-search">
          <Icon name="search" size={17} />
          <input
            aria-label="Search bots"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            type="search"
            value={query}
          />
          <kbd>⌘K</kbd>
        </label>

        <div className="sidebar-section-heading">
          <span>Bots</span>
          <button className="quiet-button" type="button" aria-label="Add a bot">
            <Icon name="plus" size={16} />
          </button>
        </div>

        <nav className="agent-list" aria-label="Bots">
          {filteredAgents.map((agent) => (
            <button
              className={`agent-row${agent.id === selectedId ? " is-active" : ""}`}
              key={agent.id}
              onClick={() => selectAgent(agent.id)}
              type="button"
            >
              <Avatar agent={agent} />
              <span className="agent-row-copy">
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </span>
              <span className="online-dot" title="Online" />
            </button>
          ))}
          {filteredAgents.length === 0 && <p className="empty-search">No bots found</p>}
        </nav>

        <button className="account-row" type="button">
          <span className="account-avatar">DT</span>
          <span className="account-copy">
            <strong>Daniel</strong>
            <small>Personal workspace</small>
          </span>
          <Icon name="chevron" size={15} />
        </button>
      </aside>

      <main className="chat-stage">
        <section className="conversation" aria-label={`Conversation with ${activeAgent.name}`}>
          <header className="chat-header">
            <button
              aria-expanded={detailsOpen}
              className="chat-agent-button"
              onClick={() => setDetailsOpen(true)}
              type="button"
            >
              <Avatar agent={activeAgent} />
              <span>
                <strong>{activeAgent.name}</strong>
                <small>Online</small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
            <button className="icon-button" type="button" aria-label="Conversation options">
              <Icon name="more" size={20} />
            </button>
          </header>

          <div className="message-scroll" aria-live="polite">
            <div className="date-divider">
              <span>Today</span>
            </div>
            <div className="message-stack">
              {activeMessages.map((message) => (
                <div className={`message-row message-row-${message.author}`} key={message.id}>
                  {message.author === "bot" && <Avatar agent={activeAgent} />}
                  <div className="message-wrap">
                    <div className="message-bubble">{message.body}</div>
                    {message.note && <time>{message.note}</time>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="composer-area">
            <form className="composer" onSubmit={sendMessage}>
              <textarea
                aria-label={`Message ${activeAgent.name}`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={`Message ${activeAgent.name}`}
                rows={1}
                value={draft}
              />
              <div className="composer-actions">
                <button
                  className="icon-button composer-tool"
                  type="button"
                  aria-label="Attach a file"
                >
                  <Icon name="paperclip" size={18} />
                </button>
                <span className="composer-hint">Shift ↵ for a new line</span>
                <button
                  className="send-button"
                  disabled={!draft.trim()}
                  type="submit"
                  aria-label="Send message"
                >
                  <Icon name="arrow-up" size={17} />
                </button>
              </div>
            </form>
            <p>Mock conversation · Protocol connection not required</p>
          </div>
        </section>

        <aside
          className={`details-pane${detailsOpen ? " is-open" : ""}`}
          aria-hidden={!detailsOpen}
        >
          <header className="details-header">
            <strong>Bot info</strong>
            <div>
              <button
                aria-label="Bot settings"
                className={`icon-button${settingsOpen ? " is-selected" : ""}`}
                onClick={() => setSettingsOpen((open) => !open)}
                type="button"
              >
                <Icon name="settings" size={17} />
              </button>
              <button
                aria-label="Close bot info"
                className="icon-button"
                onClick={() => setDetailsOpen(false)}
                type="button"
              >
                <Icon name="x" size={19} />
              </button>
            </div>
          </header>

          <div className="details-content">
            <div className="profile-block">
              <Avatar agent={activeAgent} large />
              <h1>{activeAgent.name}</h1>
              <p className="profile-role">
                <span /> {activeAgent.role}
              </p>
              <p className="profile-description">{activeAgent.description}</p>
            </div>

            {settingsOpen && (
              <div className="settings-stub" role="status">
                <span>
                  <Icon name="settings" size={16} />
                </span>
                <div>
                  <strong>Settings are a stub</strong>
                  <p>
                    Model, permissions, and tool-host controls will arrive through the June
                    protocol.
                  </p>
                </div>
              </div>
            )}

            <section className="routines-section">
              <div className="section-title-row">
                <div>
                  <span className="eyebrow">Automation</span>
                  <h2>Routines</h2>
                </div>
                <button className="small-button" type="button">
                  <Icon name="plus" size={14} /> New
                </button>
              </div>
              <div className="routine-placeholder">
                <span className="routine-icon">
                  <Icon name="calendar" size={21} />
                </span>
                <strong>No routines yet</strong>
                <p>Teach {activeAgent.name} a repeatable workflow, then schedule it here.</p>
              </div>
            </section>
          </div>
        </aside>
      </main>
    </div>
  );
}
