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
        "text-primary": "#6B7280",
        "text-secondary": "#FFFFFF",
      },
      fontFamily: {
        sans: ["Inter", "'Noto Sans SC'", "system-ui", "sans-serif"],
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
