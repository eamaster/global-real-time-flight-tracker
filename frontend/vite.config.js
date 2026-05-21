import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env variables for the current mode so we can read VITE_BASE_PATH
  // during config resolution (before the app bundle is built).
  const env = loadEnv(mode, process.cwd(), '')

  // Base path:
  //   - GitHub Pages subpath (default in GitHub Actions CI): '/global-real-time-flight-tracker/'
  //   - Localhost / custom root domains:                       '/'
  const base = env.VITE_BASE_PATH || (process.env.GITHUB_ACTIONS === 'true' ? '/global-real-time-flight-tracker/' : '/')

  return {
    plugins: [react()],
    base,
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
    },
    server: {
      // Vite dev-server proxy: forwards /api/* → local Express backend.
      // This is used when VITE_API_URL is empty (local development).
      // In production, VITE_API_URL points directly to the Cloudflare Worker.
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
