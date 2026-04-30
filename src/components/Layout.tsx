import { type ReactNode, useState } from "react";

interface Props {
  sidebar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

export function Layout({ sidebar, list, detail }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(true)}
        className="md:hidden fixed top-3 left-3 z-30 p-2 bg-white border border-gray-200 rounded-md shadow-sm"
        aria-label="打开导航"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Sidebar overlay for mobile */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:static z-50 h-full transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div onClick={() => setSidebarOpen(false)}>{sidebar}</div>
      </div>

      {/* List */}
      <div className="w-full md:w-72 border-r border-gray-200 flex flex-col">
        <div className="md:hidden h-12" />
        {list}
      </div>

      {/* Detail */}
      <div className="hidden md:flex flex-1 flex-col">{detail}</div>
    </div>
  );
}
