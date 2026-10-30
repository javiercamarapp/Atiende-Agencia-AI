// Vocabulario del menu para el STT de la llamada (keyterms de Deepgram): nombres de los productos DISPONIBLES de la sucursal marcada y sus apodos
// (`search_keywords`: gringas, mestizas, alambre...). Sin datos personales: solo catalogo. Orden DETERMINISTA: populares primero, luego `displayOrder` (si el producto lo trae), luego
// nombre. El tope (`max`, config-plataforma `deepgram.keytermsMax` = 50) se llena MEZCLANDO por producto su nombre y su primer apodo, para que los apodos entren aunque haya mas de 50
// productos; despues los nombres que falten y al final el resto de apodos. `SearchableProduct` hoy no trae popularidad ni orden: sin ellos manda el nombre.
import type { SearchableProduct } from "../../repository.ts";

export const VOCABULARIO_VOZ_MAX = 50;

type ProductoVocab = Pick<SearchableProduct, "name" | "searchKeywords"> & { readonly isPopular?: boolean; readonly displayOrder?: number };

const limpiar = (t: string): string => t.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

export function vocabularioMenuVoz(productos: readonly ProductoVocab[], max: number = VOCABULARIO_VOZ_MAX): string[] {
  const orden = [...productos].sort(
    (a, b) => Number(b.isPopular ?? false) - Number(a.isPopular ?? false) || (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name, "es"),
  );
  const vistos = new Map<string, string>();
  const agregar = (t: string): void => {
    const l = limpiar(t);
    if (l.length >= 3 && l.length <= 60 && vistos.size < max && !vistos.has(l.toLowerCase())) vistos.set(l.toLowerCase(), l);
  };
  for (const p of orden) {
    agregar(p.name);
    if (p.searchKeywords?.[0] !== undefined) agregar(p.searchKeywords[0]);
  }
  for (const p of orden) agregar(p.name);
  for (const p of orden) for (const k of p.searchKeywords ?? []) agregar(k);
  return [...vistos.values()];
}
