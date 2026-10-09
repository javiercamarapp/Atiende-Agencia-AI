// Funciones puras del Resumen de restaurantes (saludo en la zona de la sucursal, delta honesto, fecha de la
// ultima conversacion). Aparte de Dashboard.tsx para probarlas sin DOM.
/** Misma forma que el `delta` de `StatCard` (@atiende/ui no exporta el tipo por nombre). */
export interface DeltaKpi {
  readonly pct: number;
  readonly bueno: boolean;
}

/** Hora local (0-23) de `fecha` en la zona IANA `zona`; sin zona valida cae a la del navegador. */
export function horaEnZona(fecha: Date, zona: string | null): number {
  if (zona) {
    try {
      const h = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: zona,
      })
        .formatToParts(fecha)
        .find((p) => p.type === "hour")?.value;
      const n = h === undefined ? NaN : Number(h);
      if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
    } catch {
      // zona invalida: se usa la del navegador
    }
  }
  return fecha.getHours();
}

/** "Buenos dias" / "Buenas tardes" / "Buenas noches" segun la hora de la SUCURSAL (misma regla que `saludoPorHora`). */
export function saludoEnZona(
  fecha: Date,
  zona: string | null,
): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  const hora = horaEnZona(fecha, zona);
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 20) return "Buenas tardes";
  return "Buenas noches";
}

/** Variacion contra el periodo anterior: `null` = no hay base (la tarjeta dice "sin periodo comparable"), nunca un 0 % inventado. */
export function deltaDe(pct: number | null | undefined): DeltaKpi | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  return { pct: Math.round(pct * 10) / 10, bueno: pct >= 0 };
}

/** "2 oct, 14:05" en la zona de la sucursal; fecha invalida = null (no se pinta nada). */
export function cuandoEnZona(iso: string, zona: string | null): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opciones: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(
      "es-MX",
      zona ? { ...opciones, timeZone: zona } : opciones,
    ).format(d);
  } catch {
    return new Intl.DateTimeFormat("es-MX", opciones).format(d);
  }
}

/** La actividad mas reciente (ISO) de una lista, sin asumir el orden del servidor. */
export function actividadMasReciente(
  items: readonly { readonly actividadEn: string }[],
): string | null {
  let mejor: { iso: string; t: number } | null = null;
  for (const it of items) {
    const t = Date.parse(it.actividadEn);
    if (Number.isNaN(t)) continue;
    if (mejor === null || t > mejor.t) mejor = { iso: it.actividadEn, t };
  }
  return mejor?.iso ?? null;
}
