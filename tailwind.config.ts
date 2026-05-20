import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

// Palette: Modern Red-White-Grey-Black
// primary   = near-black for headlines / strokes / button text
// accent    = vivid red for primary actions
// background = off-white page
// surface   = pure white cards
// secondary = light grey chips
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#1a1a1a",           // near-black headline / stroke
        secondary: "#e5e5e5",         // light grey chips + selected bg
        background: "#f5f5f5",        // off-white page
        surface: "#ffffff",           // cards / panels
        accent: "#e02020",            // vivid red primary action
        "accent-hover": "#b91c1c",    // deeper red hover
        error: "#b91c1c",             // error red
        "text-primary": "#2d2d2d",    // body text
        "text-secondary": "#f5f5f5",  // text on dark sidebar
        tertiary: "#fecaca",          // soft red for draft badge
        "tertiary-dark": "#7f1d1d",   // deep red on soft red bg
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
