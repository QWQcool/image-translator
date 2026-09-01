import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#EAF4FC',
        cloud: '#F7FBFF',
        halo: '#E8C547',
        blush: '#E85A7A',
        sky: {
          DEFAULT: '#3B8BE0',
          deep: '#1F64B8',
        },
        ink: {
          50: '#F7FBFF',
          100: '#243044',
          200: '#2E3D52',
          300: '#3D5168',
          400: '#5C738C',
          500: '#7B93AB',
          600: '#9AADC0',
          700: '#C5D4E4',
          800: '#D5E4F2',
          900: '#F7FBFF',
          950: '#1F3A58',
        },
        brand: {
          400: '#5BA3F0',
          500: '#3B8BE0',
          600: '#1F64B8',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'var(--font-noto)', 'serif'],
        sans: ['var(--font-nunito)', 'var(--font-noto)', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px -18px rgba(31, 100, 184, 0.35)',
        glass: '0 1px 0 0 rgba(232, 197, 71, 0.45)',
      },
    },
  },
  plugins: [],
} satisfies Config;
