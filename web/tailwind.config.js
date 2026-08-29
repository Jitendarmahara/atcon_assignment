/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          50: "#f2f4ff",
          100: "#e6e9fe",
          200: "#d0d6fd",
          300: "#aab3fb",
          400: "#7c86f6",
          500: "#5b5eee",
          600: "#4740e0",
          700: "#3c34c2",
          800: "#332c9c",
          900: "#2d2a7c",
          950: "#1b1749",
        },
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)",
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 8px 24px -8px rgb(15 23 42 / 0.10)",
        glow: "0 0 0 1px rgb(91 94 238 / 0.08), 0 8px 30px -8px rgb(91 94 238 / 0.35)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s ease-out both",
        "fade-in": "fade-in 0.4s ease-out both",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #4740e0 0%, #5b5eee 45%, #8b7ef2 100%)",
        "brand-mesh":
          "radial-gradient(60% 50% at 15% 10%, rgb(91 94 238 / 0.16) 0%, transparent 60%), radial-gradient(50% 40% at 85% 0%, rgb(139 126 242 / 0.14) 0%, transparent 60%)",
      },
    },
  },
  plugins: [],
};
