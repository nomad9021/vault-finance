import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface Command {
  id: string;
  label: string;
  /** Section heading this command sits under. */
  group: string;
  icon?: IconName;
  /** Extra words that should match — synonyms, old page names, categories. */
  keywords?: string;
  /** Right-aligned hint, e.g. a shortcut or the destination. */
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

/**
 * ⌘K / Ctrl-K jump-to-anything.
 *
 * Deep navigation is only pleasant if you never have to walk it. The palette
 * is what lets the sidebar be organised by meaning rather than by "what do I
 * click most", because everything stays one keystroke away regardless.
 *
 * Matching is a simple subsequence test, so "bdgpl" finds "Budget Planner".
 */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after paint so the animation doesn't eat the first keystroke.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll<HTMLElement>(".palette-item")
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) {
        onClose();
        cmd.run();
      }
    }
  };

  // Group headings are emitted inline while walking the flat, ranked list, so
  // the arrow-key index and the rendered order can't drift apart.
  let lastGroup = "";

  return (
    <div className="palette-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search pages, accounts, actions…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="empty empty-sm">
              <div className="empty-body">Nothing matches “{query}”.</div>
            </div>
          ) : (
            results.map((cmd, i) => {
              const heading = cmd.group !== lastGroup ? cmd.group : null;
              lastGroup = cmd.group;
              return (
                <div key={cmd.id}>
                  {heading && <div className="palette-group-label">{heading}</div>}
                  <button
                    type="button"
                    className="palette-item"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active ? "true" : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      onClose();
                      cmd.run();
                    }}
                  >
                    {cmd.icon && <Icon name={cmd.icon} size={17} />}
                    <span className="truncate">{cmd.label}</span>
                    {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Subsequence match, ranked so that a prefix beats a word-start beats a
 * scattered match. Exported for tests.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const scored: Array<{ cmd: Command; score: number }> = [];
  for (const cmd of commands) {
    const label = cmd.label.toLowerCase();
    const haystack = `${label} ${cmd.group.toLowerCase()} ${cmd.keywords?.toLowerCase() ?? ""}`;
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (new RegExp(`\\b${escapeRegExp(q)}`).test(haystack)) score = 1;
    else if (haystack.includes(q)) score = 2;
    else if (isSubsequence(q, label)) score = 3;
    if (score >= 0) scored.push({ cmd, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.cmd.label.localeCompare(b.cmd.label))
    .map((s) => s.cmd);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
