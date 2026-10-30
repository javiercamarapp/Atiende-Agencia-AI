// Vocabulario del menu para el STT de la llamada (keyterms de Deepgram): nombres de los productos DISPONIBLES de la sucursal marcada y sus apodos
// (`search_keywords`: gringas, mestizas, alambre...). Sin datos personales: solo catalogo. Los nombres van primero (cada termino cuesta tokens) y el total
// se topa en `max` (config-plataforma `deepgram.keytermsMax` = 50). Defecto de produccion: el controlador no pasaba `vocabulario` y el STT no recibia nada.
import type { SearchableProduct } from "../../repository.ts";

export const VOCABULARIO_VOZ_MAX = 50;

const limpiar = (t: string): string => t.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

export function vocabularioMenuVoz(productos: readonly Pick<SearchableProduct, "name" | "searchKeywords">[], max: number = VOCABULARIO_VOZ_MAX): string[] {
  const vistos = new Map<string, string>();
  const agregar = (t: string): void => {
    const l = limpiar(t);
    if (l.length >= 3 && l.length <= 60 && vistos.size < max && !vistos.has(l.toLowerCase())) vistos.set(l.toLowerCase(), l);
  };
  for (const p of productos) agregar(p.name);
  for (const p of productos) for (const k of p.searchKeywords ?? []) agregar(k);
  return [...vistos.values()];
}
