import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

// Palette: Happy Hues 13 — warm cream + pink + mint.
// primary   = headline + stroke + button text
// text-primary = paragraph (body) color, warmer than primary
// accent    = pink highlight / primary button bg
// tertiary  = mint, used for draft badge and low-temperature callouts
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#33272a",        // headline / stroke / button text (was #111827)
        secondary: "#ffc6c7",      // soft pink chips + selected bg (was #FFEDD5)
        background: "#faeee7",     // page cream (was #E5E7EB)
        surface: "#fffffe",        // cards / panels (was #FFFFFF)
        accent: "#ff8ba7",         // pink highlight / primary button (was #111827)
        "accent-hover": "#e66a87", // deeper pink for btn hover
        error: "#c83b3b",          // softened red (was #DC2626)
        "text-primary": "#594a4e", // paragraph (was #374151)
        "text-secondary": "#fffffe", // text on dark sidebar (kept light)
        tertiary: "#c3f0ca",       // mint for draft badge (new)
        "tertiary-dark": "#1a5a3f",// deep green on mint bg (new)
      },
      fontFamily: {
        sans: [
          "Inter",
          "'Noto Sans SC'",
          "'PingFang SC'",
          "'Microsoft YaHei'",
          "'Source Han Sans CN'",
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
