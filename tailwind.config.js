/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/ui/**/*.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        ink: {
          900: '#0b0e14',
          850: '#0f131b',
          800: '#141924',
          700: '#1b2230',
          600: '#242c3d',
          500: '#323c52',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
