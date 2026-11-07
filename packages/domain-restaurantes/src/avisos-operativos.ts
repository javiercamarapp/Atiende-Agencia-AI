// R-16 -- alertas operativas de restaurantes: "entrega tardia", "programado por vencer" y (QA R2 automatizacion-04/-05, migracion 076)
// "pedido sin aceptar" (pending sin aceptar 15 min) y "pedido estancado" (listo_para_recoger o en_camino sin cerrar 6 h). El candidato lo decide la
// base (`restaurantes.avisos_operativos_candidatos`, migracion 043, SOLO sistema); este modulo lo convierte en
// notificaciones in-app por el productor compartido (`emitirNotificacion`: catalogo, dedupe, destinatarios en SQL,
// preferencias por usuario y texto sin PII: solo el numero de pedido).
//
// Idempotente: la clave de dedupe es el id del pedido, asi que dos barridos (o dos ticks) dejan UNA alerta por
// pedido y tipo; el segundo cuenta `sinNuevas`. El barrido corre dentro del tick existente
// /internal/restaurantes/promover-programados como unidad INDEPENDIENTE (su propia sesion de sistema): cada
// emision va en su SAVEPOINT (emitirNotificacion) y una falla jamas toca la promocion ni la comanda.
//
// Base sin migrar: el candidato lanza 42883 dentro de un SAVEPOINT y el barrido devuelve `disponible: false`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { createHash } from "node:crypto";
import { ALERTA_MINUTOS_POR_OMISION, correoDeAviso, destinatariosAlerta, destinatariosDelEquipo, llaveConNivel, nivelDebido, type MiembroDelEquipo } from "./whatsapp/cerebro-v2/avisos.ts";

export type TipoAvisoOperativo =
  | "restaurantes.pedido.entrega_tardia"
  | "restaurantes.pedido.programado_por_vencer"
  | "restaurantes.pedido.sin_aceptar"
  | "restaurantes.pedido.estancado";

const TIPOS_CONOCIDOS: ReadonlySet<string> = new Set<TipoAvisoOperativo>([
  "restaurantes.pedido.entrega_tardia",
  "restaurantes.pedido.programado_por_vencer",
  "restaurantes.pedido.sin_aceptar",
  "restaurantes.pedido.estancado",
]);

export interface CandidatoAviso {
  readonly tipo: TipoAvisoOperativo;
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderNumber: number;
}

export interface ResultadoBarridoAvisos {
  /** `false` = la base aun no tiene la migracion 043 (no hay nada que barrer). */
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly emitidas: number;
  /** Ya existia (dedupe), nadie a quien avisar o tope de volumen. */
  readonly sinNuevas: number;
  readonly errores: number;
}

const SIN_BARRIDO: ResultadoBarridoAvisos = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };

export async function listarCandidatosAvisos(session: TenantDbSession, now?: Date): Promise<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAviso[] }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAviso[] }>({
    session,
    primary: async () => {
      const { rows } = await session.query<{ tipo: TipoAvisoOperativo; order_id: string; organization_id: string; property_id: string; order_number: string | number }>(
        `select tipo, order_id, organization_id, property_id, order_number from restaurantes.avisos_operativos_candidatos($1::timestamptz);`,
        [now ? now.toISOString() : null],
      );
      return {
        disponible: true,
        candidatos: rows.map((r) => ({ tipo: r.tipo, orderId: r.order_id, organizationId: r.organization_id, propertyId: r.property_id, orderNumber: Number(r.order_number) })),
      };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, candidatos: [] }),
  });
}

/** Emite las alertas de los candidatos de hoy. `now` es el instante absoluto (UTC) con que se evalua el barrido: el tick de produccion pasa el reloj de la app (la base lo interpreta en la zona de cada sucursal) y, si se omite, manda el reloj de la base. */
export async function barrerAvisosOperativos(session: TenantDbSession, options: { readonly now?: Date } = {}): Promise<ResultadoBarridoAvisos> {
  const { disponible, candidatos } = await listarCandidatosAvisos(session, options.now);
  if (!disponible) return SIN_BARRIDO;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const c of candidatos) {
    const base = { organizationId: c.organizationId, propertyId: c.propertyId, clave: c.orderId, parametros: { numero: c.orderNumber }, entidadTipo: "order", entidadId: c.orderId } as const;
    // Un tipo que este codigo no conoce (una base mas nueva que el despliegue) se salta en vez de emitirse con un texto equivocado.
    if (!TIPOS_CONOCIDOS.has(c.tipo)) continue;
    const r = await emitirNotificacion(session, { evento: c.tipo, ...base });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatos: candidatos.length, emitidas, sinNuevas, errores };
}

/**
 * Cerebro v2 (suelto, alertas-operativas.ts: «repeticion cada 10 min hasta el nivel 3»): cada aviso URGENTE (marca al inicio) sin resolver de una organizacion con
 * cerebro_v2, creado hace 10 min o mas y en las ultimas 24 h (lo elige la base: `restaurantes.avisos_urgentes_sin_resolver`, migracion 193), vuelve a
 * notificar con severidad critica y la llave del nivel que toca (nivelDebido / llaveConNivel: el nivel 1 es la notificacion del alta, misma llave). El
 * correo al dueño del nivel 3 del suelto no existe aqui (hueco conocido: no hay canal de correo de avisos). Base sin la 193 (42883): nada que barrer.
 */
export async function barrerAvisosUrgentesSinResolver(session: TenantDbSession, ahora: Date): Promise<ResultadoBarridoAvisos> {
  type Fila = { id: string; organization_id: string; property_id: string | null; created_at: string | Date };
  const filas = await runWithSavepointFallback<Fila[] | null>({
    session,
    primary: async () => (await session.query<Fila>(`select id, organization_id, property_id, created_at from restaurantes.avisos_urgentes_sin_resolver($1::timestamptz, $2::int);`, [ahora.toISOString(), ALERTA_MINUTOS_POR_OMISION])).rows,
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => null,
  });
  if (filas === null) return SIN_BARRIDO;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const f of filas) {
    const nivel = nivelDebido(new Date(f.created_at), ahora, ALERTA_MINUTOS_POR_OMISION);
    const r = await emitirNotificacion(session, { evento: "restaurantes.callback.pendiente", organizationId: f.organization_id, propertyId: f.property_id, clave: llaveConNivel(f.id, nivel), entidadTipo: "callback_request", entidadId: f.id, severidad: "critica" });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatos: filas.length, emitidas, sinNuevas, errores };
}

export interface ResultadoBarridoCorreo {
  /** `false` = la base aun no tiene la migracion 194 (no hay nada que barrer). */
  readonly disponible: boolean;
  readonly candidatos: number;
  /** Correos encolados en esta corrida (uno por aviso, nivel y destinatario; el outbox deduplica por llave). */
  readonly encolados: number;
  /** Avisos sin nadie a quien avisar (ni personal ni dueño con correo). */
  readonly sinDestinatario: number;
  readonly errores: number;
}

/**
 * Cerebro v2 (suelto alertas-operativas.ts + alertas-ruteo.ts): los avisos del agente sin atender salen del panel por CORREO con la escalera del suelto: nivel 1
 * a los 10 min (los URGENTES de inmediato), repeticion a los 20 (nivel 2) y escalada al dueño a los 30 (nivel 3); el de posible baja solo el nivel 1. Los
 * candidatos y el equipo los decide la base (migracion 194: solo organizaciones con cerebro_v2 Y `avisos_correo_escalera`, solo sesion de sistema); el ruteo es
 * `destinatariosAlerta` del suelto. Se encola en el outbox de correo existente con llave `aviso-correo:<id>:n<nivel>:<huella del correo>` (idempotente: dos
 * barridos no duplican). Cada aviso en su SAVEPOINT. Base sin la 194 (42883): nada que barrer.
 */
export async function barrerAvisosPorCorreo(session: TenantDbSession, ahora: Date): Promise<ResultadoBarridoCorreo> {
  type Fila = { id: string; organization_id: string; property_id: string | null; created_at: string | Date; urgente: boolean; solo_primer_aviso: boolean };
  const filas = await runWithSavepointFallback<Fila[] | null>({
    session,
    primary: async () => (await session.query<Fila>(`select id, organization_id, property_id, created_at, urgente, solo_primer_aviso from restaurantes.avisos_para_correo($1::timestamptz, $2::int);`, [ahora.toISOString(), ALERTA_MINUTOS_POR_OMISION])).rows,
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => null,
  });
  if (filas === null) return { disponible: false, candidatos: 0, encolados: 0, sinDestinatario: 0, errores: 0 };
  const equipos = new Map<string, readonly MiembroDelEquipo[]>();
  let encolados = 0;
  let sinDestinatario = 0;
  let errores = 0;
  for (const f of filas) {
    try {
      await runWithSavepointFallback<void>({
        session,
        primary: async () => {
          let equipo = equipos.get(f.organization_id);
          if (!equipo) {
            equipo = (await session.query<MiembroDelEquipo>(`select email, vertical_role, platform_role, property_ids from restaurantes.equipo_para_avisos_correo($1::uuid);`, [f.organization_id])).rows;
            equipos.set(f.organization_id, equipo);
          }
          const creado = new Date(f.created_at);
          const nivel = f.solo_primer_aviso ? 1 : nivelDebido(creado, ahora, ALERTA_MINUTOS_POR_OMISION);
          const { correos } = destinatariosAlerta(destinatariosDelEquipo(equipo, f.property_id), f.property_id, nivel);
          if (correos.length === 0) {
            sinDestinatario += 1;
            return;
          }
          const correo = correoDeAviso({ nivel, minutos: (ahora.getTime() - creado.getTime()) / 60_000, urgente: f.urgente });
          let deEste = 0;
          for (const to of correos) {
            const huella = createHash("sha256").update(to).digest("hex").slice(0, 16);
            await session.query(`select restaurantes.enqueue_messaging_outbox($1, $2, $3, $4, $5::jsonb);`, [f.organization_id, "email", "alerta.aviso_sin_atender", `aviso-correo:${f.id}:n${nivel}:${huella}`, JSON.stringify({ to, ...correo })]);
            deEste += 1;
          }
          encolados += deEste;
        },
        isRecoverable: () => true,
        fallback: async () => {
          errores += 1;
        },
      });
    } catch {
      errores += 1;
    }
  }
  return { disponible: true, candidatos: filas.length, encolados, sinDestinatario, errores };
}
