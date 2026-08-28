import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // bind 0.0.0.0 so Tailscale and LAN peers can reach it
    allowedHosts: true,
  },
})
