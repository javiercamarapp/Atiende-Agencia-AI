// Barril de ARRANQUE: solo lo que la entrada de apps/web (main.tsx, App.tsx, carga-perezosa.tsx) pinta antes de que cargue
// cualquier ruta perezosa. Existe por el presupuesto de bundle (scripts/verify-bundle-budget): si la entrada importa el
// barril completo (./index.ts), Rollup mete en el chunk de entrada TODO modulo de @atiende/ui que alguna ruta use (selects,
// menus, tabs, tooltips...), aunque la entrada no los toque. Importando desde aqui, esos modulos se reparten en chunks
// compartidos que bajan con la primera ruta que los necesita. Mismos componentes, mismas instancias: el barril completo
// re-exporta estos mismos modulos.
export { CapaArranque } from "./components/CapaArranque.js";
export { ThemeBoot } from "./components/ThemeBoot.js";
export { EstadoError } from "./components/EstadoError.js";
export { EstadoCargando } from "./components/EstadoCargando.js";
export { VerticalNoEncontrado } from "./components/VerticalNoEncontrado.js";
export { Toaster } from "./components/ui/sonner.js";
