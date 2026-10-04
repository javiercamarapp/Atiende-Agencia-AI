// Utilidades de la cartera cargada: lista de taxonomias por vertical, etiquetas de subtipo/tamano, fuentes presentes y estado visible.
import type { ProspectoMapa, TaxonomiaApi } from "./datos.ts";
import { claveTamano } from "./filtros.ts";
import { nombreVertical } from "./verticales.ts";

export function taxonomiaPorVertical(taxonomias: readonly TaxonomiaApi[]): ReadonlyMap<string, TaxonomiaApi> {
  return new Map(taxonomias.map((t) => [t.vertical, t]));
}

export function etiquetaTamano(p: Pick<ProspectoMapa, "tamano" | "vertical">, tax: ReadonlyMap<string, TaxonomiaApi>): string | null {
  if (!p.tamano) return null;
  const t = tax.get(p.vertical);
  const rango = t?.rangosTamano.rangos.find((r) => r.clave === p.tamano);
  return rango ? `${rango.etiqueta} ${t!.rangosTamano.unidad}` : p.tamano;
}

export function nombreSubtipo(p: Pick<ProspectoMapa, "subtipo" | "vertical">, tax: ReadonlyMap<string, TaxonomiaApi>): string | null {
  if (!p.subtipo) return null;
  return tax.get(p.vertical)?.subtipos.find((s) => s.clave === p.subtipo)?.nombre ?? p.subtipo;
}

export interface OpcionFiltro {
  readonly clave: string;
  readonly nombre: string;
  readonly n: number;
}

/** Fuentes que de verdad hay en la cartera (texto libre del alta), con su conteo; "Sin fuente" cuando no se capturo. */
export function fuentesPresentes(lista: readonly ProspectoMapa[]): OpcionFiltro[] {
  const m = new Map<string, number>();
  for (const p of lista) {
    const k = p.fuente ?? "sin-fuente";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([clave, n]) => ({ clave, nombre: clave === "sin-fuente" ? "Sin fuente" : clave, n }))
    .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre));
}

/** Subtipos presentes por vertical (clave compuesta `vertical:subtipo`), con el nombre de la taxonomia. */
export function subtiposPresentes(lista: readonly ProspectoMapa[], tax: ReadonlyMap<string, TaxonomiaApi>): OpcionFiltro[] {
  const m = new Map<string, number>();
  for (const p of lista) {
    if (!p.subtipo) continue;
    const k = `${p.vertical}:${p.subtipo}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([clave, n]) => {
      const [vertical, subtipo] = clave.split(":") as [string, string];
      return { clave, nombre: nombreSubtipo({ vertical, subtipo }, tax) ?? subtipo, n };
    })
    .sort((a, b) => b.n - a.n || a.nombre.localeCompare(b.nombre));
}

/** Tamanos presentes (clave `vertical:rango`, o `n/d` sin dato) con la etiqueta de la taxonomia de su vertical. */
export function tamanosPresentes(lista: readonly ProspectoMapa[], tax: ReadonlyMap<string, TaxonomiaApi>): OpcionFiltro[] {
  const m = new Map<string, { nombre: string; n: number }>();
  for (const p of lista) {
    const k = claveTamano(p);
    const nombre = p.tamano === null ? "Sin dato" : `${nombreVertical(p.vertical)} · ${etiquetaTamano(p, tax) ?? p.tamano}`;
    m.set(k, { nombre, n: (m.get(k)?.n ?? 0) + 1 });
  }
  return [...m.entries()].map(([clave, v]) => ({ clave, nombre: v.nombre, n: v.n })).sort((a, b) => a.nombre.localeCompare(b.nombre));
}
