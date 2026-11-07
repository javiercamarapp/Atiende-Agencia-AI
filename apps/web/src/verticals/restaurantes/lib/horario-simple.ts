// Modo SIMPLE del horario de una sucursal: una fila por dia (abierto/cerrado, abre, cierra), como el editor del repo suelto
// (`parsearHorario`/`serializarHorario` de SucursalesSection), pero sobre el modelo ESTRUCTURADO de turnos de M (migracion 023,
// `TurnoHorario[]` de la politica de la sucursal), no sobre texto libre. Funciones puras: ReglasSucursal sigue siendo quien guarda.
//
// Representable en modo simple = a lo mas UN turno por dia y sin «ultimo pedido» propio (eso solo se edita en Avanzado). Un turno que
// cierra pasada la medianoche (12:00 a 01:00) SI es representable: sigue siendo un solo intervalo de ese dia. Los puentes (horario por
// fecha) son otra seccion y no cambian.
import type { TurnoHorario } from "./modelo-pm-client.ts";

export interface DiaSimple {
  readonly abierto: boolean;
  readonly abre: string;
  readonly cierra: string;
}

/** Indice = dia de la semana del modelo (0 = domingo .. 6 = sabado). Siempre 7 entradas. */
export type HorarioSimple = readonly DiaSimple[];

/** Orden de las filas en pantalla: lunes primero, como se lee un horario en Mexico. */
export const ORDEN_DIAS_SIMPLE: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** Horas sugeridas para un dia que se abre por primera vez (las mismas que «Agregar turno»). */
export const DIA_SIMPLE_POR_OMISION: DiaSimple = { abierto: false, abre: "12:00", cierra: "01:00" };

export type MotivoNoSimple = "variosTurnosPorDia" | "ultimoPedido";

export type LecturaSimple = { readonly ok: true; readonly horario: HorarioSimple } | { readonly ok: false; readonly motivo: MotivoNoSimple };

/**
 * Turnos -> filas por dia. Sin turnos (= sin limite de horario) da los 7 dias cerrados con las horas sugeridas: al guardar sin marcar
 * ningun dia vuelve a ser «sin turnos», exactamente lo de antes.
 */
export function aHorarioSimple(turnos: readonly TurnoHorario[]): LecturaSimple {
  const dias: DiaSimple[] = Array.from({ length: 7 }, () => ({ ...DIA_SIMPLE_POR_OMISION }));
  const ocupado = new Set<number>();
  for (const t of turnos) {
    if (t.ultimoPedidoDomicilio || t.ultimoPedidoRecoger) return { ok: false, motivo: "ultimoPedido" };
    for (const d of t.dias) {
      if (!Number.isInteger(d) || d < 0 || d > 6) continue;
      if (ocupado.has(d)) return { ok: false, motivo: "variosTurnosPorDia" };
      ocupado.add(d);
      dias[d] = { abierto: true, abre: t.abre, cierra: t.cierra };
    }
  }
  return { ok: true, horario: dias };
}

/**
 * Filas por dia -> turnos. Los dias abiertos con las mismas horas se juntan en un solo turno (compacto, como lo escribe Avanzado);
 * los turnos salen ordenados por su primer dia y cada uno con sus dias en orden. Ningun dia abierto -> [] (sin limite de horario).
 */
export function desdeHorarioSimple(horario: HorarioSimple): TurnoHorario[] {
  const grupos = new Map<string, { abre: string; cierra: string; dias: number[] }>();
  horario.forEach((dia, d) => {
    if (!dia.abierto) return;
    const clave = `${dia.abre}-${dia.cierra}`;
    const g = grupos.get(clave);
    if (g) g.dias.push(d);
    else grupos.set(clave, { abre: dia.abre, cierra: dia.cierra, dias: [d] });
  });
  return [...grupos.values()].sort((a, b) => (a.dias[0] ?? 0) - (b.dias[0] ?? 0)).map((g) => ({ dias: g.dias, abre: g.abre, cierra: g.cierra }));
}

/** Cambia un dia (0..6) sin tocar los demas. */
export function conDia(horario: HorarioSimple, dia: number, cambio: Partial<DiaSimple>): HorarioSimple {
  return horario.map((d, i) => (i === dia ? { ...d, ...cambio } : d));
}

/** Copia las horas (y el abierto/cerrado) de un dia a toda la semana: el «aplicar a todos» del original. */
export function copiarATodos(horario: HorarioSimple, dia: number): HorarioSimple {
  const fuente = horario[dia];
  return fuente ? horario.map(() => ({ ...fuente })) : horario;
}

/** Dias abiertos que no se pueden guardar: sin hora o con la misma hora de apertura y cierre (el servidor lo rechaza igual). */
export function diasInvalidos(horario: HorarioSimple): number[] {
  return horario.flatMap((d, i) => (d.abierto && (!d.abre || !d.cierra || d.abre === d.cierra) ? [i] : []));
}

/** El dia cierra pasada la medianoche (misma regla que `describirTurno`: cierre menor o igual a la apertura). */
export function cruzaMedianoche(dia: DiaSimple): boolean {
  return dia.abierto && !!dia.abre && !!dia.cierra && dia.cierra <= dia.abre;
}
