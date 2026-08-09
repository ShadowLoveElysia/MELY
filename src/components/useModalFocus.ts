import { useEffect, useRef } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const modalSelector = '[role="dialog"][aria-modal="true"]';

const focusableElements = (dialog: HTMLElement) => (
  [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true")
);

const isTopmostModal = (dialog: HTMLElement) => {
  const dialogs = document.querySelectorAll<HTMLElement>(modalSelector);
  return dialogs.length === 0 || dialogs[dialogs.length - 1] === dialog;
};

interface ModalFocusOptions {
  open: boolean;
  dismissible?: boolean;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

export function useModalFocus<T extends HTMLElement>({
  open,
  dismissible = true,
  onClose,
  restoreFocusTo,
}: ModalFocusOptions) {
  const dialogRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    previousFocusRef.current = restoreFocusTo
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusTimer = window.setTimeout(() => {
      (focusableElements(dialog)[0] ?? dialog).focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(dialog)) return;
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[nextIndex].focus();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      window.setTimeout(() => {
        if (!previousFocus?.isConnected) return;
        const dialogs = document.querySelectorAll<HTMLElement>(modalSelector);
        const topmost = dialogs[dialogs.length - 1];
        if (!topmost || topmost.contains(previousFocus)) previousFocus.focus();
      }, 0);
    };
  }, [dismissible, open, restoreFocusTo]);

  return dialogRef;
}
