import { type ReactNode, useEffect, useRef, useState } from "react";

interface Props {
  sidebar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

// Desktop list-column sizing. Persisted per tab so width / collapsed state
// survive reloads and navigation inside one session.
const LIST_WIDTH_KEY = "pw.listWidth";
const LIST_COLLAPSED_KEY = "pw.listCollapsed";
const LIST_WIDTH_DEFAULT = 320;
const LIST_WIDTH_MIN = 200;
const LIST_WIDTH_MAX = 600;

// Distance the pointer must travel after pressdown before we treat the
// gesture as a drag (resize) rather than a click (collapse).
const CLICK_THRESHOLD_PX = 4;

function readStoredWidth(): number {
  const raw = window.sessionStorage.getItem(LIST_WIDTH_KEY);
  if (!raw) return LIST_WIDTH_DEFAULT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return LIST_WIDTH_DEFAULT;
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, n));
}

export function Layout({ sidebar, list, detail }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(
    () => window.sessionStorage.getItem(LIST_COLLAPSED_KEY) === "1"
  );
  const [listWidth, setListWidth] = useState<number>(readStoredWidth);

  useEffect(() => {
    window.sessionStorage.setItem(LIST_WIDTH_KEY, String(listWidth));
  }, [listWidth]);
  useEffect(() => {
    window.sessionStorage.setItem(LIST_COLLAPSED_KEY, listCollapsed ? "1" : "0");
  }, [listCollapsed]);

  // Divider behavior: click (no movement) = collapse. Drag = resize.
  // We capture the pointer so drags don't lose tracking when the cursor
  // strays off the thin handle.
  const pressState = useRef<{
    startX: number;
    startWidth: number;
    moved: boolean;
  } | null>(null);

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    pressState.current = {
      startX: e.clientX,
      startWidth: listWidth,
      moved: false,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = pressState.current;
    if (!s) return;
    const delta = e.clientX - s.startX;
    if (!s.moved && Math.abs(delta) < CLICK_THRESHOLD_PX) return;
    s.moved = true;
    const next = Math.min(
      LIST_WIDTH_MAX,
      Math.max(LIST_WIDTH_MIN, s.startWidth + delta)
    );
    setListWidth(next);
  };

  const onDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = pressState.current;
    pressState.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    // Click-without-drag toggles collapse.
    if (s && !s.moved) {
      setListCollapsed(true);
    }
  };

  return (
    <div className="h-screen flex overflow-hidden bg-background p-2 gap-2">
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(true)}
        className="md:hidden fixed top-3 left-3 z-30 p-2 bg-surface shadow-card rounded-full"
        aria-label="打开导航"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Sidebar overlay for mobile */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:static z-50 transition-transform md:translate-x-0 rounded-lg overflow-hidden self-stretch ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-full" onClick={() => setSidebarOpen(false)}>{sidebar}</div>
      </div>

      {/* Collapsed state: 32px strip acts as the whole expand control — the
          entire column is clickable, not just the small icon. Highlights on
          hover so users can tell the strip itself is the button. */}
      {listCollapsed && (
        <button
          type="button"
          onClick={() => setListCollapsed(false)}
          className="hidden md:flex flex-col items-center justify-start bg-surface rounded-lg shadow-card w-8 pt-3 flex-none text-primary hover:bg-secondary/40 transition-colors cursor-pointer"
          aria-label="展开提示词列表"
          title="展开提示词列表"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Expanded list. On mobile stays full-width (default behavior).
          On desktop uses the resizable listWidth; no separate header row —
          the divider column on the right hosts the collapse affordance. */}
      {!listCollapsed && (
        <>
          {/* Mobile list (w-full) */}
          <div className="md:hidden w-full flex flex-col bg-surface rounded-lg shadow-card overflow-hidden">
            {list}
          </div>

          {/* Desktop list with custom width. No header bar — the full
              column is list content, with the divider to the right serving
              as both resize handle and collapse trigger. */}
          <div
            className="hidden md:flex flex-col bg-surface rounded-lg shadow-card overflow-hidden flex-none"
            style={{ width: `${listWidth}px` }}
          >
            {list}
          </div>

          {/* Unified divider: resize (drag) + collapse (click) in one control.
              8px hit target, 2px always-visible tinted line so users see it,
              hover reveals a chevron in the middle + stronger tint so the
              collapse affordance is obvious. Desktop only. */}
          <div
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerUp}
            className="hidden md:flex w-2 cursor-col-resize group relative flex-none items-center justify-center"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调宽 或 点击收起提示词列表"
            title="拖动调宽 · 点击收起"
          >
            {/* Always-visible tinted line */}
            <div className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-0.5 bg-primary/15 group-hover:bg-primary/40 transition-colors rounded" />
            {/* Hover-only chevron that signals click-to-collapse. 150ms
                delayed fade-in so fast passes don't flash. */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity delay-100 duration-150 bg-primary text-white rounded-full w-5 h-5 flex items-center justify-center shadow-sm pointer-events-none">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
              </svg>
            </div>
          </div>
        </>
      )}

      {/* Detail */}
      <div className="hidden md:flex flex-1 flex-col bg-surface rounded-lg shadow-card overflow-hidden">{detail}</div>
    </div>
  );
}
