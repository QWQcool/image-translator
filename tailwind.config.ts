import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5dae3',
          300: '#b0bacb',
          400: '#8493ad',
          500: '#637493',
          600: '#4e5d79',
          700: '#404b62',
          800: '#374153',
          900: '#222834',
          950: '#15181f',
        },
        brand: {
          400: '#4da3ff',
          500: '#1d7fea',
          600: '#0b63c5',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
