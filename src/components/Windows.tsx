import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";

interface WindowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  emphasis?: "primary" | "danger" | "destructive" | "secondary";
}

interface WindowsProps {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: readonly WindowAction[];
  onClose: () => void;
  closeLabel: string;
  danger?: boolean;
  dismissible?: boolean;
  restoreFocusTo?: HTMLElement | null;
}

export function Windows({
  open,
  title,
  children,
  actions,
  onClose,
  closeLabel,
  danger = false,
  dismissible = true,
  restoreFocusTo,
}: WindowsProps) {
  const titleId = useId();
  const panelRef = useModalFocus<HTMLDivElement>({
    open,
    dismissible,
    onClose,
    restoreFocusTo,
  });

  if (!open) return null;
  return (
    <div
      className="window-backdrop"
      data-mely-dialog="true"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`window-panel ${danger ? "window-panel--danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="window-panel__header">
          <h2 id={titleId}>{title}</h2>
          {dismissible ? (
            <button type="button" className="window-panel__close" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
              <X size={18} />
            </button>
          ) : null}
        </header>
        <div className="window-panel__body">{children}</div>
        <footer className="window-panel__actions">
          {actions.map((action) => (
            <button
              type="button"
              key={action.label}
              className={`window-action window-action--${action.emphasis ?? "secondary"}`}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </footer>
      </div>
    </div>
  );
}

export type { WindowAction, WindowsProps };
