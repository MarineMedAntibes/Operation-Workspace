"use client";

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { DraftActions } from "./draft-history";

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Snapshot = Record<string, string | boolean>;
type History = { steps: Snapshot[]; cursor: number; saved: Snapshot };
type Props = Omit<ComponentPropsWithoutRef<"form">, "onChange"> & {
  busy: boolean;
  locked?: boolean;
  onDraftChange?: (form: HTMLFormElement) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

function fields(form: HTMLFormElement): Field[] {
  return Array.from(form.elements).filter((field): field is Field =>
    (field instanceof HTMLInputElement && !["file", "password", "radio", "submit", "reset", "button"].includes(field.type) ||
      field instanceof HTMLSelectElement && !field.multiple ||
      field instanceof HTMLTextAreaElement) && !!field.name);
}

function isCheckbox(field: Field): field is HTMLInputElement {
  return field instanceof HTMLInputElement && field.type === "checkbox";
}

function capture(form: HTMLFormElement): Snapshot {
  return Object.fromEntries(fields(form).map(field => [field.name, isCheckbox(field) ? field.checked : field.value]));
}

function same(left: Snapshot, right: Snapshot) {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([name, value]) => right[name] === value);
}

export default function DraftForm({ busy, locked, onDraftChange, onDirtyChange, children, onKeyDown, ...props }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [history, setHistory] = useState<History>();

  useEffect(() => {
    if (!formRef.current) return;
    const saved = capture(formRef.current);
    setHistory({ steps: [saved], cursor: 0, saved });
  }, []);

  function step(offset: number) {
    const form = formRef.current;
    if (!form || !history || busy) return;
    const cursor = history.cursor + offset;
    const snapshot = history.steps[cursor];
    if (!snapshot) return;
    for (const field of fields(form)) {
      const value = snapshot[field.name];
      if (isCheckbox(field) && typeof value === "boolean") field.checked = value;
      else if (typeof value === "string") field.value = value;
    }
    setHistory({ ...history, cursor });
    onDraftChange?.(form);
  }

  const dirty = !!history && !same(history.saved, history.steps[history.cursor]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  return <form {...props} ref={formRef} onChange={event => {
    const form = event.currentTarget;
    const snapshot = capture(form);
    setHistory(current => {
      if (!current) return { steps: [snapshot], cursor: 0, saved: snapshot };
      if (same(current.steps[current.cursor], snapshot)) return current;
      const steps = [...current.steps.slice(Math.max(0, current.cursor - 98), current.cursor + 1), snapshot];
      return { ...current, steps, cursor: steps.length - 1 };
    });
    onDraftChange?.(form);
  }} onKeyDown={event => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!busy && !locked) event.currentTarget.requestSubmit();
    }
  }}>
    <DraftActions busy={busy} locked={locked} dirty={dirty} canUndo={!!history?.cursor}
      canRedo={!!history && history.cursor < history.steps.length - 1}
      undo={() => step(-1)} redo={() => step(1)} onSave={() => formRef.current?.requestSubmit()} />
    {children}
  </form>;
}
