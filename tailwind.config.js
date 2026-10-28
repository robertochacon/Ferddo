/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta de Ferddo, sacada del logo (public/brand/ferddo-wordmark.png).
        // Los componentes solo usan los nombres brand-*/mint-*/accent-*, nunca
        // hex sueltos, así que cambiar estas escalas re-tematiza toda la app.
        brand: {
          50: '#eef5ff',
          100: '#d9e8ff',
          200: '#bcd7ff',
          300: '#8ebeff',
          400: '#5999fd',
          500: '#3377f8',
          600: '#1a5ce6', // azul del isotipo (botones, enlaces, theme-color)
          700: '#1549cc',
          800: '#173da5',
          900: '#183882',
          950: '#0b2559', // navy del logotipo "Ferddo"
        },
        // Turquesa de la segunda hoja del isotipo: acentos de marca y éxito.
        mint: {
          50: '#effefa',
          100: '#c8fff1',
          200: '#91fee4',
          300: '#53f5d4',
          400: '#1fe0c0',
          500: '#07c4a8',
          600: '#029e8a',
          700: '#077e70',
          800: '#0b645b',
          900: '#0e534b',
          950: '#00332f',
        },
        // Ámbar de apoyo: avisos, destacados y el plan recomendado.
        accent: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
          950: '#451a03',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        // Sombras tintadas con el navy de la marca en vez de negro puro: sobre
        // fondos claros el gris neutro se ve sucio.
        card: '0 1px 2px 0 rgb(11 37 89 / 0.04), 0 4px 16px -2px rgb(11 37 89 / 0.08)',
        'card-hover': '0 2px 4px 0 rgb(11 37 89 / 0.06), 0 12px 28px -6px rgb(11 37 89 / 0.14)',
      },
      borderRadius: {
        xl: '0.9rem',
        '2xl': '1.25rem',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
      },
    },
  },
  plugins: [],
}
