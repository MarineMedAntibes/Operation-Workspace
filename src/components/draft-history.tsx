"use client";

import { useState } from "react";
import { Redo2, Save, Undo2 } from "lucide-react";

export function useDraftHistory<T>(initial: T) {
  const [history, setHistory] = useState(() => ({ steps: [initial], index: 0, saved: initial }));
  const value = history.steps[history.index];
  function edit(next: T | ((current: T) => T)) {
    setHistory(current => {
      const previous = current.steps[current.index];
      const value = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      if (Object.is(previous, value)) return current;
      const steps = [...current.steps.slice(Math.max(0, current.index - 98), current.index + 1), value];
      return { ...current, steps, index: steps.length - 1 };
    });
  }
  function step(offset: number) {
    setHistory(current => {
      const index = current.index + offset;
      return index >= 0 && index < current.steps.length ? { ...current, index } : current;
    });
  }
  return {
    value, edit,
    reset: (next: T) => setHistory({ steps: [next], index: 0, saved: next }),
    canUndo: history.index > 0,
    canRedo: history.index < history.steps.length - 1,
    dirty: !Object.is(value, history.saved),
    undo: () => step(-1),
    redo: () => step(1),
  };
}

export function DraftActions({ busy, locked = false, dirty, canUndo, canRedo, undo, redo, onSave, saveLabel = "Save", saveDisabled = false, label = "Draft changes" }: {
  busy: boolean; locked?: boolean; dirty?: boolean; canUndo?: boolean; canRedo?: boolean;
  undo: () => void; redo: () => void; onSave?: () => void; saveLabel?: string; saveDisabled?: boolean; label?: string;
}) {
  return <div className="draft-controls" role="group" aria-label={label}>
    <button type="button" className="secondary" disabled={locked || busy || !canUndo} onClick={undo}><Undo2 size={16} />Undo</button>
    <button type="button" className="secondary" disabled={locked || busy || !canRedo} onClick={redo}><Redo2 size={16} />Redo</button>
    {onSave && <button type="button" className="secondary" disabled={locked || busy || saveDisabled} onClick={onSave}><Save size={16} />{saveLabel}</button>}
    <span role="status">{busy ? "Saving…" : dirty ? "Unsaved changes" : "No unsaved changes"}</span>
  </div>;
}
