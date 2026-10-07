// Texto del horario semanal para el directorio publico. Los turnos vienen del servidor tal cual los configuro el
// negocio ({dias: 0 = domingo .. 6, abre, cierra}); aqui solo se redactan, sin inventar nada. Sin `toLocale*`.
export interface TurnoPublico {
  readonly dias: readonly number[];
  readonly abre: string;
  readonly cierra: string;
}

const CORTO = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0] as const;

/** "lun-vie", "vie-dom", "lun, mié" a partir de los dias del turno (lunes primero). */
export function textoDias(dias: readonly number[]): string {
  const set = new Set(dias);
  if (set.size >= 7) return "todos los días";
  const rachas: number[][] = [];
  let previo = -2;
  ORDEN_SEMANA.forEach((d, idx) => {
    if (!set.has(d)) return;
    if (idx === previo + 1 && rachas.length > 0) rachas[rachas.length - 1]!.push(d);
    else rachas.push([d]);
    previo = idx;
  });
  return rachas.map((r) => (r.length >= 3 ? `${CORTO[r[0]!]}-${CORTO[r[r.length - 1]!]}` : r.map((d) => CORTO[d]).join(", "))).join(", ");
}

/** Una linea por turno: "lun-vie · 12:00 a 01:00 (cierra después de medianoche)". */
export function lineasHorario(horario: readonly TurnoPublico[] | null): string[] {
  if (!horario || horario.length === 0) return [];
  return horario.map((t) => `${textoDias(t.dias)} · ${t.abre} a ${t.cierra}${t.cierra <= t.abre ? " (cierra después de medianoche)" : ""}`);
}

/** Enlace tel: solo con digitos y el + inicial; null si no hay un telefono usable. */
export function enlaceTel(telefono: string | null): string | null {
  if (!telefono) return null;
  const limpio = telefono.replace(/[^\d+]/g, "");
  return limpio.replace(/\D/g, "").length >= 8 ? `tel:${limpio}` : null;
}
