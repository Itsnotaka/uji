import { IconCrossSmall, IconWarningSign } from "central-icons";

export interface Notice {
  id: string;
  message: string;
  tone: "error" | "info";
  action?: { label: string; run: () => void };
}

export function NoticeStack({
  notices,
  onDismiss,
}: {
  notices: readonly Notice[];
  onDismiss: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="notice-stack">
      {notices.map((notice) => (
        <div className="notice" data-tone={notice.tone} key={notice.id} role="status">
          {notice.tone === "error" && <IconWarningSign aria-hidden="true" size={13} />}
          <span>{notice.message}</span>
          {notice.action !== undefined && (
            <button className="notice-action" onClick={notice.action.run} type="button">
              {notice.action.label}
            </button>
          )}
          <button
            aria-label="Dismiss"
            className="notice-dismiss"
            onClick={() => onDismiss(notice.id)}
            type="button"
          >
            <IconCrossSmall size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
