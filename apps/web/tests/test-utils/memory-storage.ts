// Node 22+ trae un `localStorage` global experimental propio (requiere el flag
// `--localstorage-file`, ausente en la config de vitest de este repo) cuyo
// accessor (`get`/`set` en `globalThis`) pisa el `window.localStorage` real que
// jsdom intentaría exponer bajo `// @vitest-environment jsdom` -- cualquier Shell
// que lea `window.localStorage` directo (todas: HotelesShell/CitasShell/
// RestaurantesShell/DespachosShell/RentasShell/LicitacionesShell) revienta con
// "Cannot read properties of undefined" en vez de encontrar un storage real, sin
// que el código de producción tenga ningún bug -- es un artefacto del runtime de
// Node de ESTE entorno de test. El descriptor de Node es `configurable: true`
// (verificado con `Object.getOwnPropertyDescriptor(globalThis, "localStorage")`),
// así que puede reemplazarse por un stub en memoria real (misma superficie que
// `Storage`) sin tocar ninguna API de jsdom.
class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

/** Instala un `localStorage` real (en memoria, aislado por llamada) en
 * `globalThis`/`window` para este archivo de test -- llamar una vez, antes de
 * cualquier render que dependa de `window.localStorage` (sesión persistida,
 * selección de property, etc.). No hace falta desinstalarlo entre tests: cada
 * llamada reemplaza la instancia anterior por una vacía. */
export function installMemoryLocalStorage(): Storage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return storage;
}

/** jsdom (el `environment: "jsdom"` de vitest.config.ts) no implementa
 * `window.matchMedia` -- lo dispara `<ThemeSelector>` (@atiende/ui, montado
 * dentro de `<Sidebar>`, presente en TODOS los Shells de vertical) para
 * detectar `prefers-color-scheme`. Sin este stub, cualquier test que monte un
 * Shell completo (no solo una página aislada) revienta con "window.matchMedia
 * is not a function" -- artefacto del entorno de test, no del componente real
 * (en un navegador real `matchMedia` sí existe). `matches: false` es
 * intencional: ningún test de este archivo depende de qué tema resuelve. */
export function installMatchMediaStub(): void {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
