"use client";
import { useEffect, useRef, type ReactNode } from "react";
import ui from "./vs01-workspace.module.css";

/** Native modal owns focus, Escape and the backdrop; unmount always releases it. */
export function WorkspaceDialog({
  children,
  close,
  labelledBy,
  drawer = false,
}: {
  children: ReactNode;
  close: () => void;
  labelledBy: string;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={ui.workspaceDialog}
      data-drawer={drawer}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          close();
      }}
    >
      {children}
    </dialog>
  );
}
