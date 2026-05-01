/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        complete: '#86efac',
        warning: '#fde68a',
        danger: '#fca5a5',
      },
    },
  },
  plugins: [],
};
