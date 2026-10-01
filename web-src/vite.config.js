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
        // 把重型库拆出主 bundle：three 系只在 3D 组件懒加载时取，hljs/marked 可独立缓存。
        // React 必须显式归入自己的 chunk：manual chunk 会把成员未归属的依赖一并吸走，旧配置下
        // react / jsx-runtime 被吸进 three chunk，入口为拿 React 被迫静态 import 整个 968KB 的
        // three chunk（index.html 还对它 modulepreload），3D 懒加载形同虚设。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (/[\\/]node_modules[\\/](three|@react-three|postprocessing)[\\/]/.test(id)) return 'three'
          if (/[\\/]node_modules[\\/](marked|dompurify)[\\/]/.test(id)) return 'markdown'
          // 代码高亮由 markdown.js 按需 import()：单独成 chunk，首屏不加载
          if (/[\\/]node_modules[\\/]highlight\.js[\\/]/.test(id)) return 'hljs'
          return undefined
        },
      },
    },
  },
})
