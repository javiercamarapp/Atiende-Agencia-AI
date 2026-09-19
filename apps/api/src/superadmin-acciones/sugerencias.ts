// Motor puro de sugerencias -- SIN I/O, 100% testeable, MISMO criterio que
// `../salud/motor.ts`/`../resumen-diario/motor.ts`: nunca un LLM decidiendo
// qué sugerir, siempre determinista a partir de datos YA calculados/leídos
// por el caller (mensajes muertos reales, prospectos ya marcados
// `necesita_seguimiento_desde` por la automatización real -- nunca se
// recalcula aquí el umbral de días, se reutiliza el mismo estado que la
// automatización ya persistió, para que sugerencia y automatización nunca
// diverjan).
//
// Una sugerencia JAMÁS ejecuta nada por sí sola -- cada una trae el tipo de
// acción y el payload YA precargado para que el frontend cree el intent con
// un clic (`POST /superadmin/acciones/intents`), pero la creación del
// intent sigue exigiendo el flujo completo de confirmación.
import type { OutboxDeadMessageRow } from "@atiende/db";

export interface SugerenciaAccion {
  /** Estable por fila de origen -- útil como `key` en el frontend. */
  readonly id: string;
  readonly titulo: string;
  readonly detalle: string;
  readonly tipoAccion: "reencolar_mensaje_muerto" | "cerrar_prospecto";
  readonly payloadSugerido: Record<string, unknown>;
}

export interface ProspectoNecesitaSeguimiento {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  /** ISO 8601, no-nulo por contrato -- el caller ya filtró por
   *  `necesitaSeguimientoDesde !== null` antes de construir este input (ver
   *  `../routes/superadmin-acciones.ts`). */
  readonly necesitaSeguimientoDesde: string;
}

export interface CalcularSugerenciasInput {
  readonly mensajesMuertos: readonly OutboxDeadMessageRow[];
  readonly prospectosNecesitanSeguimiento: readonly ProspectoNecesitaSeguimiento[];
  readonly ahora: Date;
}

function diasDesde(iso: string, ahora: Date): number {
  return Math.max(0, Math.floor((ahora.getTime() - new Date(iso).getTime()) / 86_400_000));
}

/** Agrupa mensajes muertos por cola para el título ("hay N mensajes muertos
 *  en <cola>") pero devuelve UNA sugerencia POR MENSAJE (cada una con su
 *  propio payload precargado, `queue` + `id` del mensaje concreto) -- una
 *  sugerencia agregada no podría crear un intent de un clic, que exige
 *  UN mensaje concreto (ver `core.superadmin_action_intent`). */
export function calcularSugerencias(input: CalcularSugerenciasInput): readonly SugerenciaAccion[] {
  const sugerencias: SugerenciaAccion[] = [];

  const totalPorCola = new Map<string, number>();
  for (const m of input.mensajesMuertos) totalPorCola.set(m.queueName, (totalPorCola.get(m.queueName) ?? 0) + 1);

  for (const m of input.mensajesMuertos) {
    const total = totalPorCola.get(m.queueName) ?? 1;
    sugerencias.push({
      id: `outbox:${m.queueName}:${m.id}`,
      titulo: total > 1 ? `${total} mensajes muertos en ${m.queueName}: revisar y reencolar` : `1 mensaje muerto en ${m.queueName}: revisar y reencolar`,
      detalle: `${m.organizationName} · canal ${m.channel} · ${m.error ?? "sin detalle de error registrado"}`,
      tipoAccion: "reencolar_mensaje_muerto",
      payloadSugerido: { queue: m.queueName, mensajeId: m.id },
    });
  }

  for (const p of input.prospectosNecesitanSeguimiento) {
    const dias = diasDesde(p.necesitaSeguimientoDesde, input.ahora);
    sugerencias.push({
      id: `prospecto:${p.id}`,
      titulo: `Prospecto "${p.empresa}" lleva ${dias} día(s) sin movimiento: ¿cerrarlo?`,
      detalle: `Vertical ${p.vertical}.`,
      tipoAccion: "cerrar_prospecto",
      payloadSugerido: { prospectoId: p.id, estado: "perdido" },
    });
  }

  return sugerencias;
}
