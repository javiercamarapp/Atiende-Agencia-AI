// Config de vite-node SOLO para el arnes (el repo no se toca): fuerza transformacion SSR para todo, asi `pg` (y otros
// modulos de Node) no pasan por el optimizador "web" de vite (que rompe `class extends EventEmitter`).
export default {
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { external: ["pg"] },
  test: {},
};
