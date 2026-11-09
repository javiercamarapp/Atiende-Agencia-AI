import { idiomaActivo } from "./activo.ts";
import { registrarModuloEs, type Clave } from "./mensajes/index.ts";
import type { ModuloEs, Variables } from "./tipos.ts";
import { traducir, type Traductor } from "./traducir.ts";

const registrados = /* @__PURE__ */ new WeakSet<ModuloEs>();

/**
 * `t` para codigo SIN React que arma texto visible (etiquetas de `lib/*.ts` que llaman las paginas durante su render): traduce
 * al idioma efectivo de la consola (`idiomaActivo`, que fija `IdiomaProvider`) y registra el espanol de sus modulos de area la
 * primera vez que se usa (no al importar: el modulo no tiene efectos). Como las paginas que lo llaman consumen el contexto
 * (`useT`), se vuelven a pintar al cambiar de idioma y este `t` ya da el nuevo.
 */
export function traductorActivo(...modulos: readonly ModuloEs[]): Traductor {
  return (clave: Clave, variables?: Variables) => {
    for (const m of modulos) {
      if (!registrados.has(m)) {
        registrarModuloEs(m);
        registrados.add(m);
      }
    }
    return traducir(idiomaActivo(), clave, variables);
  };
}

/**
 * Mapa `id -> etiqueta` (estados, canales...) que traduce en CADA lectura al idioma activo: sustituye a un `Record` de textos fijos
 * sin cambiar a quien lo lee (`ETIQUETAS[s]`, `Object.entries(ETIQUETAS)`). En espanol da los textos de siempre.
 */
export function etiquetasTraducidas<K extends string>(ids: readonly K[], clave: (id: K) => Clave, ...modulos: readonly ModuloEs[]): Readonly<Record<K, string>> {
  const t = traductorActivo(...modulos);
  const mapa = {} as Record<K, string>;
  for (const id of ids) Object.defineProperty(mapa, id, { enumerable: true, get: () => t(clave(id)) });
  return Object.freeze(mapa);
}
