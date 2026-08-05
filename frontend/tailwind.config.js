/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "#b4f953",
        success: "#10b981",
        "lc-black": "#0a0a0a",
        "lc-dark": "#171717",
        "lc-card": "#1a1a1a",
        "lc-border": "#262626",
        "lc-muted": "#a3a3a3",
        "lc-green": "#b4f953",
        "lc-green-dark": "#8bc34a",
        "lc-white": "#fafafa",
        "lc-olive": "#2d3a1a",
        "lc-olive-dark": "#1e2812",
      },
    },
  },
  plugins: [],
};
