import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
  },
  build: {
    outDir: '../jarvis/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 把重型库拆出主 bundle：three 系只在 3D 组件懒加载时取，hljs/marked 可独立缓存
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/postprocessing', 'postprocessing'],
          markdown: ['marked', 'dompurify', 'highlight.js/lib/common'],
        },
      },
    },
  },
})
