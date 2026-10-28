import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/editor/app/',
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@elah/editor', '@elah/core', '@elah/react', '@elah/timeline', 'mediabunny'] },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    manifest: 'manifest.json',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'embed.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
