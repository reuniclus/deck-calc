import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Project Pages are served from /<repo>/ — dev stays at root.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/deck-calc/' : '/',
  plugins: [react()],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
}));
