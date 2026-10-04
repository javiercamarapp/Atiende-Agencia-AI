import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // R-37: el presupuesto de bundle (scripts/verify-bundle-budget) lee este manifiesto para calcular, por ruta, el JS
    // que el navegador realmente descarga (entrada + imports estáticos), sin adivinar por nombre de archivo.
    manifest: true,
  },
});
