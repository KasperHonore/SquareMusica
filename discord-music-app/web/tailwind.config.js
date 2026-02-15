/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#121212',
          raised: '#181818',
          elevated: '#282828',
        },
        accent: {
          DEFAULT: '#1DB954',
          hover: '#1ed760',
        },
      },
      borderRadius: {
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        soft: '0 8px 24px rgba(0,0,0,0.5)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
