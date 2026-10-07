// Utilidades compartidas de las pestanas de Configuracion (H-P3-04).
export interface PestanaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** owner/gm escriben; accountant solo lee. Cosmetico: el servidor (`set_*`, RLS) decide. */
  readonly puedeEscribir: boolean;
}

/** Porcentaje que teclea la persona (16) -> razon que guarda el servidor (0.16), sin ruido de punto flotante. */
export function porcentajeARazon(pct: number): number {
  return Number((pct / 100).toFixed(4));
}

/** Razon del servidor (0.16) -> porcentaje legible (16). */
export function razonAPorcentaje(razon: number): number {
  return Number((razon * 100).toFixed(2));
}

/** Numero escrito por la persona o `null` si esta vacio o no es un numero finito. */
export function numeroODefecto(texto: string): number | null {
  if (texto.trim() === "") return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

export function mensajeDe(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
