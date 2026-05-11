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

  // Drag-to-resize. Pointer capture keeps tracking even if the cursor
  // strays off the thin handle during fast drags.
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartWidth.current = listWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartWidth.current === 0) return;
    const delta = e.clientX - dragStartX.current;
    const next = Math.min(
      LIST_WIDTH_MAX,
      Math.max(LIST_WIDTH_MIN, dragStartWidth.current + delta)
    );
    setListWidth(next);
  };
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStartWidth.current = 0;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
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

      {/* Collapsed list: narrow strip with an expand button. Mobile ignores
          collapsed state — users need the full list to navigate. */}
      {listCollapsed && (
        <div className="hidden md:flex flex-col items-center bg-surface rounded-lg shadow-card w-8 pt-3 flex-none">
          <button
            type="button"
            onClick={() => setListCollapsed(false)}
            className="p-1 rounded hover:bg-gray-100 text-text-primary/70 hover:text-primary"
            aria-label="展开提示词列表"
            title="展开提示词列表"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}

      {/* Expanded list. On mobile stays full-width (default behavior).
          On desktop uses the resizable listWidth; a collapse button sits
          top-right and a drag handle on the right edge resizes it. */}
      {!listCollapsed && (
        <>
          {/* Mobile list (w-full) */}
          <div className="md:hidden w-full flex flex-col bg-surface rounded-lg shadow-card overflow-hidden">
            {list}
          </div>

          {/* Desktop list with custom width + dedicated header strip that
              hosts the collapse button. A header row (not absolute-over) so
              the button never steals clicks from the first prompt card. */}
          <div
            className="hidden md:flex flex-col bg-surface rounded-lg shadow-card overflow-hidden flex-none"
            style={{ width: `${listWidth}px` }}
          >
            <div className="flex justify-end px-2 pt-2 pb-0">
              <button
                type="button"
                onClick={() => setListCollapsed(true)}
                className="p-1 rounded hover:bg-gray-100 text-text-primary/50 hover:text-primary"
                aria-label="收起提示词列表"
                title="收起提示词列表"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">{list}</div>
          </div>

          {/* Drag handle between list and detail. 6px hit target, thin line
              visible on hover so it's discoverable without being noisy. */}
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            className="hidden md:block w-1.5 cursor-col-resize group relative flex-none"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整提示词列表宽度"
          >
            <div className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-0.5 bg-gray-200 group-hover:bg-primary/40 transition-colors rounded" />
          </div>
        </>
      )}

      {/* Detail */}
      <div className="hidden md:flex flex-1 flex-col bg-surface rounded-lg shadow-card overflow-hidden">{detail}</div>
    </div>
  );
}
