import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm off-white terminal palette
        paper: "#faf8f3",
        panel: "#fffdf9",
        ink: "#26231d",
        "ink-soft": "#5c5648",
        "ink-faint": "#8a8272",
        line: "#e4ded1",
        "line-strong": "#cfc7b5",
        pos: "#15803d",
        "pos-soft": "#e9f5ec",
        neg: "#b91c1c",
        "neg-soft": "#fbeaea",
        warn: "#b45309",
        "warn-soft": "#fcf3e3",
        accent: "#1d4ed8",
        "accent-soft": "#e9effc",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Cascadia Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
    },
  },
  plugins: [],
};

export default config;
