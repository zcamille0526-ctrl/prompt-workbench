import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#111827",
        secondary: "#FFEDD5",
        background: "#E5E7EB",
        surface: "#FFFFFF",
        accent: "#111827",
        error: "#DC2626",
        // Bumped from #6B7280 (gray-500) to #374151 (gray-700) so body copy
        // is darker and easier to read; headings still use `primary` (#111827).
        "text-primary": "#374151",
        "text-secondary": "#FFFFFF",
      },
      fontFamily: {
        sans: [
          "Inter",
          "'Noto Sans SC'",
          // 系统中文字体栈作为 fallback：在 Noto Sans SC 加载完成前
          // 直接用本机已有的字体，避免显示系统默认（如 Windows 宋体）
          "'PingFang SC'", // macOS / iOS
          "'Microsoft YaHei'", // Windows
          "'Source Han Sans CN'", // Adobe 思源黑体
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "10px",
        lg: "12px",
        xl: "16px",
        full: "9999px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
        glass: "0 2px 8px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06)",
        elevated: "0 4px 16px rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.12)",
        subtle: "0 1px 3px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [typography],
};

export default config;
