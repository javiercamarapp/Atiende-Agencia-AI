// Avisos in-app (campana, core.notification) del ciclo de limpieza de rentas. UNICO productor de dos eventos del catalogo
// (packages/db/src/notificaciones/catalogo.ts):
//   * "rentas.limpieza.tarea_asignada"  -- a quien opera limpieza cuando una tarea queda asignada (manual, por responsable
//     por omision, o por el barrido). La cola es `rentas.notificacion_tarea` (migracion 033, `notificada_in_app_en`): TODA
//     asignacion (`asignarTarea`) deja ahi una fila, venga de la API, del motor iCal o del barrido; el barrido las drena.
//   * "rentas.limpieza.sin_asignar"      -- al administrador cuando una tarea de MAÑANA sigue sin responsable pasadas las
//     18:00 locales de la propiedad. Lo calcula el barrido (ningun GET emite).
// Contrato de las funciones: best-effort y SIN PII (solo conteos y ids de tarea). Cada emision va dentro de un SAVEPOINT
// (`emitirNotificacion`); la lectura/marca de la cola tambien (`runWithSavepointFallback`): contra la base sin migrar
// (42883/42P01/42703) degradan a "sin avisos" sin abortar la transaccion compartida del request o del barrido.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { SinAsignarManana } from "@atiende/domain-rentas";

const ESTADOS_TERMINALES = new Set(["completada", "cancelada"]);

export interface ResultadoAvisos {
  readonly emitidos: number;
  /** Filas de la cola ya atendidas (emitidas, deduplicadas o de tareas que ya no aplican). */
  readonly marcados: number;
  /** `false` si la base aun no tiene la migracion 033 (la cola no existe). */
  readonly disponible: boolean;
}

/** Clave de dedupe: una por tarea Y persona asignada (reasignar a otra persona vuelve a avisar; repetir la misma no). */
function claveAsignacion(tareaId: string, asignadoA: string): string {
  return `${tareaId}:${asignadoA}`;
}

/** Aviso inmediato al asignar a mano a OTRA persona desde la API. Best-effort: nunca lanza. */
export async function avisarTareaAsignada(db: TenantDbSession, entrada: { organizationId: string; propertyId: string; tareaId: string; asignadoA: string }): Promise<void> {
  await emitirNotificacion(db, {
    evento: "rentas.limpieza.tarea_asignada",
    organizationId: entrada.organizationId,
    propertyId: entrada.propertyId,
    clave: claveAsignacion(entrada.tareaId, entrada.asignadoA),
    entidadTipo: "tarea",
    entidadId: entrada.tareaId,
  });
}

/** Marca como ya avisadas las filas de cola de una tarea (la asignacion que acaba de hacer la API: o se aviso al instante o la hizo
 *  la propia persona sobre si misma). Contra la base sin migrar no hace nada. */
export async function marcarAvisosDeTarea(db: TenantDbSession, tareaId: string): Promise<void> {
  await runWithSavepointFallback<void>({
    session: db,
    primary: async () => {
      await db.query(`update rentas.notificacion_tarea set notificada_in_app_en = now() where tarea_id = $1::uuid and evento = 'asignada' and notificada_in_app_en is null`, [tareaId]);
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => undefined,
  });
}

interface FilaCola {
  aviso_id: string;
  tarea_id: string;
  organization_id: string;
  property_id: string;
  asignado_a: string | null;
  estado: string;
}

/** Drena la cola de avisos de asignacion (las mas antiguas primero, `limite` por corrida). */
export async function drenarAvisosAsignacion(db: TenantDbSession, limite = 100): Promise<ResultadoAvisos> {
  const cola = await runWithSavepointFallback<FilaCola[] | null>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<FilaCola>(
        `select n.id as aviso_id, t.id as tarea_id, t.organization_id, t.property_id, t.asignado_a, t.estado
         from rentas.notificacion_tarea n
         join rentas.tarea_operativa t on t.id = n.tarea_id
         where n.evento = 'asignada' and n.notificada_in_app_en is null
         order by n.creado_en, n.id
         limit $1`,
        [limite],
      );
      return rows;
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => null,
  });
  if (cola === null) return { emitidos: 0, marcados: 0, disponible: false };

  let emitidos = 0;
  const atendidos: string[] = [];
  for (const fila of cola) {
    // Una tarea que ya no esta viva o que perdio a su responsable no se avisa: se da por atendida.
    if (fila.asignado_a === null || ESTADOS_TERMINALES.has(fila.estado)) {
      atendidos.push(fila.aviso_id);
      continue;
    }
    const r = await emitirNotificacion(db, {
      evento: "rentas.limpieza.tarea_asignada",
      organizationId: fila.organization_id,
      propertyId: fila.property_id,
      clave: claveAsignacion(fila.tarea_id, fila.asignado_a),
      entidadTipo: "tarea",
      entidadId: fila.tarea_id,
    });
    if (r.estado === "emitida") emitidos += 1;
    // `no_disponible`/`error` se reintentan en la siguiente corrida; `sin_nuevas` (dedupe o sin destinatarios) e `invalida` no.
    if (r.estado === "emitida" || r.estado === "sin_nuevas" || r.estado === "invalida") atendidos.push(fila.aviso_id);
  }

  if (atendidos.length > 0) {
    await runWithSavepointFallback<void>({
      session: db,
      primary: async () => {
        await db.query(`update rentas.notificacion_tarea set notificada_in_app_en = now() where id = any($1::uuid[]) and notificada_in_app_en is null`, [atendidos]);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => undefined,
    });
  }
  return { emitidos, marcados: atendidos.length, disponible: true };
}

/** Aviso al administrador por propiedad y dia de las tareas de manana sin responsable (una por propiedad y fecha). */
export async function avisarSinAsignarManana(db: TenantDbSession, items: readonly SinAsignarManana[]): Promise<number> {
  let emitidos = 0;
  for (const item of items) {
    const r = await emitirNotificacion(db, {
      evento: "rentas.limpieza.sin_asignar",
      organizationId: item.organizationId,
      propertyId: item.propertyId,
      clave: `${item.propertyId}:${item.fecha}`,
      parametros: { cantidad: item.cantidad },
    });
    if (r.estado === "emitida") emitidos += 1;
  }
  return emitidos;
}
