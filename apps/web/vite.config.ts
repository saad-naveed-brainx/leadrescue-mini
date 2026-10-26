import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Must match WEB_ORIGIN in the API's settings, or the API's CORS check refuses the page.
  server: { port: 5173, strictPort: true },
});
