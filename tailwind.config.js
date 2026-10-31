/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          ink: '#1a1a1a',
          gold: '#b08d57',
          cream: '#f7f4ef',
        },
      },
    },
  },
  plugins: [],
};
