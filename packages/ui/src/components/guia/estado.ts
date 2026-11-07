// Progreso del recorrido guiado: SOLO lo no derivable de los datos (visto, omitido, descartado, paso, activo, modo, terminado).
// Dos capas: el navegador (localStorage, siempre en try/catch: modo privado o cuota llena no rompen nada) y el servidor
// (GET/PUT /v1/onboarding/progreso, migracion 0075) para retomar en otro equipo. Sin red o con la base sin migrar, la guia sigue con lo
// del navegador. Gana la copia con la marca de tiempo mas nueva. La clave local lleva un hash corto de persona+organizacion, nunca el id.
// «Primeros pasos» NUNCA se guarda aqui: se recalcula con datos reales en el servidor.
import type { ModoTour } from "./motor";

export const PREFIJO_GUIA = "atiende-guia.";
export const VERSION_GUIA = "v1";

export interface Almacen {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export interface ProgresoLocal {
  readonly visto: boolean;
  readonly omitido: boolean;
  readonly descartado: boolean;
  readonly paso: string | null;
  readonly activo: boolean;
  readonly modo: ModoTour | null;
  readonly terminado: boolean;
  /** ms epoch de la ultima escritura (local o del servidor). 0 = nunca. */
  readonly actualizado: number;
}

export const PROGRESO_VACIO: ProgresoLocal = Object.freeze({ visto: false, omitido: false, descartado: false, paso: null, activo: false, modo: null, terminado: false, actualizado: 0 });

/** FNV-1a de 32 bits (8 hex). No es criptografico: solo evita dejar el id en claro en el navegador. */
export function hashCorto(a: string, b: string): string {
  let h = 0x811c9dc5;
  const texto = `${a}\u0000${b}`;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const claveProgreso = (persona: string, organizacion: string, pista: string): string => `${PREFIJO_GUIA}${VERSION_GUIA}.${hashCorto(persona, organizacion)}.${pista}`;

export function almacenDelNavegador(): Almacen | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizar(crudo: unknown): ProgresoLocal {
  if (!crudo || typeof crudo !== "object") return { ...PROGRESO_VACIO };
  const c = crudo as Record<string, unknown>;
  const actualizado = typeof c.actualizado === "number" && Number.isFinite(c.actualizado) ? c.actualizado : typeof c.actualizado === "string" ? Date.parse(c.actualizado) || 0 : 0;
  return {
    visto: c.visto === true,
    omitido: c.omitido === true,
    descartado: c.descartado === true,
    activo: c.activo === true,
    terminado: c.terminado === true,
    modo: c.modo === "corto" || c.modo === "completo" ? c.modo : null,
    paso: typeof c.paso === "string" && c.paso.length <= 80 && /^[a-z0-9._:-]+$/.test(c.paso) ? c.paso : null,
    actualizado,
  };
}

export function leerLocal(almacen: Almacen | null, clave: string): ProgresoLocal {
  try {
    const texto = almacen?.getItem(clave);
    return texto ? normalizar(JSON.parse(texto)) : { ...PROGRESO_VACIO };
  } catch {
    return { ...PROGRESO_VACIO };
  }
}

export function guardarLocal(almacen: Almacen | null, clave: string, estado: ProgresoLocal): boolean {
  try {
    if (!almacen) return false;
    almacen.setItem(clave, JSON.stringify(normalizar(estado)));
    return true;
  } catch {
    return false;
  }
}

/** Gana la copia mas nueva. «terminado» es un hito: si cualquiera de las dos lo tiene, queda. */
export function reconciliar(local: ProgresoLocal, servidor: ProgresoLocal | null): ProgresoLocal {
  if (!servidor) return local;
  const base = servidor.actualizado > local.actualizado ? servidor : local;
  return { ...base, terminado: local.terminado || servidor.terminado };
}

/** Borra todas las claves de la guia (al cerrar sesion en un equipo compartido). Nunca lanza. */
export function limpiarProgresoGuia(almacen: Almacen | null): number {
  try {
    if (!almacen) return 0;
    const claves: string[] = [];
    for (let i = 0; i < almacen.length; i++) {
      const k = almacen.key(i);
      if (k && k.startsWith(PREFIJO_GUIA)) claves.push(k);
    }
    let n = 0;
    for (const k of claves) {
      try {
        almacen.removeItem(k);
        n++;
      } catch {
        // sigue con las demas
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** Puente al servidor. Lo implementa apps/web (fetch con el token); @atiende/ui no hace red. */
export interface ServidorProgreso {
  /** null = sin fila o no disponible (base sin migrar, sin red). */
  leer(): Promise<ProgresoLocal | null>;
  guardar(estado: ProgresoLocal): Promise<void>;
}
