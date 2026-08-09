import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#090c10",
        panel: "#11161c",
        raised: "#181e26",
        line: "#28313b",
        cyan: "#22b8cf",
        mint: "#77d6b4",
        amber: "#e9ad5b",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Microsoft YaHei", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
