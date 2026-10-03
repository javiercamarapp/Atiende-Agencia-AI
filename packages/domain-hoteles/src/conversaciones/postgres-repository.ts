// Adaptador Postgres de la bandeja de conversaciones (H-20) sobre `TenantDbSession` (auth.uid() real por request). Toda la
// autoridad vive en las funciones `security definer` de la migracion 043 (rol, property, transicion, responsable, outbox).
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; una funcion inexistente
// (42883) o tabla/columna inexistente la dejaria ABORTADA (25P02). Cada llamada corre dentro de `runWithSavepointFallback`:
// las lecturas degradan a `disponible: false` con lista vacia honesta, las escrituras a 503. El SQL lo ejercita
// scripts/verify-hoteles-conversaciones contra Postgres real.
//
// Sistema (webhook): `PostgresConversacionesSistema`. Tambien emite la notificacion `hoteles.conversacion.handoff` (una por
// derivacion) con el productor compartido de @atiende/db.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { ConversacionesRepository } from "./repository.ts";
import {
  CONFLICTO_MENSAJES,
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesNoEncontradaError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  estadoEnvioDeOutbox,
  type ConversacionActor,
  type ConversacionBandeja,
  type ConversacionConflictoCodigo,
  type ConversacionDetalle,
  type ConversacionItem,
  type ConversacionMensaje,
  type ConversacionModo,
  type ConversacionNota,
  type ConversacionesFiltro,
  type ConversacionesSistemaPort,
  type DerivacionResultado,
  type ResponderResultado,
  type TomarResultado,
} from "./tipos.ts";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

const CONFLICTO_CODIGOS = Object.keys(CONFLICTO_MENSAJES) as ConversacionConflictoCodigo[];

/** Traduce un error de Postgres de las funciones 043 a un error de dominio tipado. */
export function mapConversacionesPgError(err: unknown, operacion: string): unknown {
  if (
    err instanceof ConversacionesNoDisponibleError ||
    err instanceof ConversacionesNoEncontradaError ||
    err instanceof ConversacionesRechazadaError ||
    err instanceof ConversacionesValidacionError ||
    err instanceof ConversacionesConflictoError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new ConversacionesNoDisponibleError(operacion);
  const message = err instanceof Error ? err.message : "";
  switch (pgCode(err)) {
    case "42501":
      return new ConversacionesRechazadaError(message.includes("responsable") || message.includes("reasignar") ? message : undefined);
    case "P0002":
      return new ConversacionesNoEncontradaError();
    case "22023":
      return new ConversacionesValidacionError(message.replace(/^[a-z_0-9]+:\s*/, "") || "Dato inválido.");
    case "55000": {
      const codigo = CONFLICTO_CODIGOS.find((c) => message.startsWith(`${c}:`));
      return codigo ? new ConversacionesConflictoError(codigo, CONFLICTO_MENSAJES[codigo]) : err;
    }
    default:
      return err;
  }
}

interface ItemRow {
  id: string;
  phone: string;
  modo: ConversacionModo;
  responsable_id: string | null;
  responsable_nombre: string | null;
  tomada_en: string | null;
  handoff_motivo: string | null;
  handoff_en: string | null;
  no_leidos: number;
  ultimo_entrante_en: string | null;
  actividad_en: string;
  huesped_id: string | null;
  huesped_nombre: string | null;
}
interface ListRow extends ItemRow {
  vista_previa: string | null;
  ultimo_rol: string | null;
  total: string;
}
interface DetalleRow extends ItemRow {
  property_id: string;
  handoff_n: number;
  cerrada_en: string | null;
  total_mensajes: number;
  mensajes: unknown;
}

const ts = (col: string) => `${col}::text as ${col}`;

function mapItem(r: ItemRow, vistaPrevia: string | null, ultimoRol: string | null): ConversacionItem {
  return {
    id: r.id,
    telefono: r.phone,
    modo: r.modo,
    responsableId: r.responsable_id,
    responsableNombre: r.responsable_nombre,
    tomadaEn: r.tomada_en,
    motivo: r.handoff_motivo,
    handoffEn: r.handoff_en,
    noLeidos: Number(r.no_leidos),
    ultimoEntranteEn: r.ultimo_entrante_en,
    actividadEn: r.actividad_en,
    vistaPrevia,
    ultimoRol: ultimoRol === "user" || ultimoRol === "assistant" ? ultimoRol : null,
    huespedId: r.huesped_id,
    huespedNombre: r.huesped_nombre,
  };
}

/** Un mensaje del historial (jsonb de la base) a la forma de la API. Tolera filas viejas sin `origen`/`creado_en`. */
export function mapMensaje(raw: unknown): ConversacionMensaje | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const rol = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null;
  if (!rol || typeof m.content !== "string") return null;
  const origen = rol === "user" ? "huesped" : m.origen === "humano" ? "personal" : "agente";
  return {
    rol,
    origen,
    texto: m.content,
    creadoEn: typeof m.creado_en === "string" ? m.creado_en : null,
    autorId: typeof m.autor_id === "string" ? m.autor_id : null,
    envio: origen === "personal" ? (estadoEnvioDeOutbox(typeof m.envio === "string" ? m.envio : null) ?? "pendiente_envio") : null,
  };
}

export class PostgresConversacionesRepository implements ConversacionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async write<T>(operacion: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapConversacionesPgError(err, operacion);
      },
    });
  }

  /** La conversacion debe pertenecer a la property de la ruta (RLS ya filtra por acceso); si no, no existe para esta ruta. */
  private async assertEnPropiedad(propertyId: string, conversationId: string): Promise<void> {
    const { rows } = await this.db.query<{ ok: number }>(`select 1 as ok from hoteles.whatsapp_conversations where id = $1::uuid and property_id = $2::uuid;`, [conversationId, propertyId]);
    if (rows.length === 0) throw new ConversacionesNoEncontradaError();
  }

  async listar(_actor: ConversacionActor, propertyId: string, f: ConversacionesFiltro): Promise<ConversacionBandeja> {
    try {
      return await runWithSavepointFallback<ConversacionBandeja>({
        session: this.db,
        primary: async () => {
          const { rows } = await this.db.query<ListRow>(
            `select id, phone, modo, responsable_id, responsable_nombre, ${ts("tomada_en")}, handoff_motivo, ${ts("handoff_en")}, no_leidos,
                    ${ts("ultimo_entrante_en")}, ${ts("actividad_en")}, vista_previa, ultimo_rol, huesped_id, huesped_nombre, total::text as total
               from hoteles.conversaciones_listar($1::uuid, $2, $3, $4, $5, $6);`,
            [propertyId, f.modo, f.soloNoLeidas, f.telefonoClave, f.limit, f.offset],
          );
          return { disponible: true, total: rows.length === 0 ? 0 : Number(rows[0]!.total), items: rows.map((r) => mapItem(r, r.vista_previa, r.ultimo_rol)) };
        },
        isRecoverable: () => true,
        fallback: async (err) => {
          if (isMigrationPendingError(err)) return { disponible: false, total: 0, items: [] };
          throw err;
        },
      });
    } catch (err) {
      throw mapConversacionesPgError(err, "listar conversaciones");
    }
  }

  async detalle(_actor: ConversacionActor, propertyId: string, conversationId: string): Promise<{ disponible: boolean; valor: ConversacionDetalle | null }> {
    try {
      return await runWithSavepointFallback<{ disponible: boolean; valor: ConversacionDetalle | null }>({
        session: this.db,
        primary: async () => {
          const { rows } = await this.db.query<DetalleRow>(
            `select id, property_id, phone, modo, responsable_id, responsable_nombre, ${ts("tomada_en")}, handoff_motivo, ${ts("handoff_en")}, handoff_n,
                    no_leidos, ${ts("ultimo_entrante_en")}, ${ts("cerrada_en")}, ${ts("actividad_en")}, total_mensajes, mensajes, huesped_id, huesped_nombre
               from hoteles.conversacion_detalle($1::uuid);`,
            [conversationId],
          );
          const r = rows[0];
          if (!r || r.property_id !== propertyId) return { disponible: true, valor: null };
          const notas = await this.db.query<{ id: string; autor_id: string | null; autor_nombre: string | null; texto: string; creada_en: string }>(
            `select id, autor_id, autor_nombre, texto, creada_en::text as creada_en from hoteles.conversacion_notas($1::uuid);`,
            [conversationId],
          );
          const crudos = Array.isArray(r.mensajes) ? (r.mensajes as unknown[]) : [];
          const base = mapItem(r, null, null);
          const mensajes = crudos.map(mapMensaje).filter((m): m is ConversacionMensaje => m !== null);
          const ultimo = mensajes[mensajes.length - 1];
          const valor: ConversacionDetalle = {
            ...base,
            vistaPrevia: ultimo ? ultimo.texto.slice(0, 160) : null,
            ultimoRol: ultimo ? ultimo.rol : null,
            propertyId: r.property_id,
            handoffN: Number(r.handoff_n),
            cerradaEn: r.cerrada_en,
            totalMensajes: Number(r.total_mensajes),
            mensajes,
            notas: notas.rows.map((n): ConversacionNota => ({ id: n.id, autorId: n.autor_id, autorNombre: n.autor_nombre, texto: n.texto, creadaEn: n.creada_en })),
          };
          return { disponible: true, valor };
        },
        isRecoverable: () => true,
        fallback: async (err) => {
          if (isMigrationPendingError(err)) return { disponible: false, valor: null };
          throw err;
        },
      });
    } catch (err) {
      const mapped = mapConversacionesPgError(err, "ver la conversación");
      if (mapped instanceof ConversacionesNoEncontradaError) return { disponible: true, valor: null };
      throw mapped;
    }
  }

  async leer(_actor: ConversacionActor, propertyId: string, conversationId: string): Promise<void> {
    await this.write("marcar la conversación como leída", async () => {
      await this.assertEnPropiedad(propertyId, conversationId);
      await this.db.query(`select hoteles.conversacion_leer($1::uuid);`, [conversationId]);
    });
  }

  async tomar(_actor: ConversacionActor, propertyId: string, conversationId: string, reasignar: boolean): Promise<TomarResultado> {
    return this.write("tomar la conversación", async () => {
      await this.assertEnPropiedad(propertyId, conversationId);
      const { rows } = await this.db.query<{ modo: ConversacionModo; responsable_id: string | null; tomada_en: string | null }>(
        `select modo, responsable_id, tomada_en::text as tomada_en from hoteles.conversacion_tomar($1::uuid, $2::boolean);`,
        [conversationId, reasignar],
      );
      const r = rows[0];
      if (!r) throw new ConversacionesNoEncontradaError();
      return { modo: r.modo, responsableId: r.responsable_id, tomadaEn: r.tomada_en };
    });
  }

  private async cambiarModo(propertyId: string, conversationId: string, fn: "conversacion_devolver" | "conversacion_cerrar", operacion: string): Promise<ConversacionModo> {
    return this.write(operacion, async () => {
      await this.assertEnPropiedad(propertyId, conversationId);
      const { rows } = await this.db.query<{ modo: ConversacionModo }>(`select hoteles.${fn}($1::uuid) as modo;`, [conversationId]);
      const r = rows[0];
      if (!r) throw new ConversacionesNoEncontradaError();
      return r.modo;
    });
  }

  devolver(_actor: ConversacionActor, propertyId: string, conversationId: string): Promise<ConversacionModo> {
    return this.cambiarModo(propertyId, conversationId, "conversacion_devolver", "devolver la conversación al agente");
  }

  cerrar(_actor: ConversacionActor, propertyId: string, conversationId: string): Promise<ConversacionModo> {
    return this.cambiarModo(propertyId, conversationId, "conversacion_cerrar", "cerrar la conversación");
  }

  async agregarNota(_actor: ConversacionActor, propertyId: string, conversationId: string, texto: string): Promise<string> {
    return this.write("agregar la nota", async () => {
      await this.assertEnPropiedad(propertyId, conversationId);
      const { rows } = await this.db.query<{ id: string }>(`select hoteles.conversacion_agregar_nota($1::uuid, $2) as id;`, [conversationId, texto]);
      const r = rows[0];
      if (!r) throw new ConversacionesNoEncontradaError();
      return r.id;
    });
  }

  async responder(_actor: ConversacionActor, propertyId: string, conversationId: string, texto: string): Promise<ResponderResultado> {
    return this.write("responder la conversación", async () => {
      await this.assertEnPropiedad(propertyId, conversationId);
      const { rows } = await this.db.query<{ outbox_id: string; envio: string }>(`select outbox_id, envio from hoteles.conversacion_responder($1::uuid, $2);`, [conversationId, texto]);
      const r = rows[0];
      if (!r) throw new ConversacionesNoEncontradaError();
      return { outboxId: r.outbox_id, envio: estadoEnvioDeOutbox(r.envio) ?? "pendiente_envio" };
    });
  }
}

/** Puerto de SISTEMA del webhook: sesion sin usuario. Degrada a null contra la base sin la 043; la derivacion es best-effort. */
export class PostgresConversacionesSistema implements ConversacionesSistemaPort {
  constructor(private readonly db: TenantDbSession) {}

  async registrarEntrante(propertyId: string, phone: string): Promise<ConversacionModo | null> {
    return runWithSavepointFallback<ConversacionModo | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ modo: ConversacionModo | null }>(`select hoteles.conversacion_registrar_entrante($1::uuid, $2) as modo;`, [propertyId, phone]);
        return rows[0]?.modo ?? null;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async derivarAHumano(propertyId: string, phone: string, motivo: string): Promise<DerivacionResultado | null> {
    const resultado = await runWithSavepointFallback<DerivacionResultado | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ conversation_id: string; organization_id: string; handoff_n: number; transicion: boolean }>(
          `select conversation_id, organization_id, handoff_n, transicion from hoteles.conversacion_derivar_a_humano($1::uuid, $2, $3);`,
          [propertyId, phone, motivo],
        );
        const r = rows[0];
        return r ? { conversationId: r.conversation_id, organizationId: r.organization_id, handoffN: Number(r.handoff_n), transicion: r.transicion } : null;
      },
      // Best-effort: la respuesta del agente ya esta lista; un fallo aqui nunca debe tumbar ni reintentar el turno.
      isRecoverable: () => true,
      fallback: async () => null,
    });
    if (resultado?.transicion) {
      // `emitirNotificacion` nunca lanza (SAVEPOINT propio, dedupe por derivacion = conversacion + numero de derivacion).
      await emitirNotificacion(this.db, {
        evento: "hoteles.conversacion.handoff",
        organizationId: resultado.organizationId,
        propertyId,
        clave: `${resultado.conversationId}:${resultado.handoffN}`,
        entidadTipo: "whatsapp_conversation",
        entidadId: resultado.conversationId,
      });
    }
    return resultado;
  }
}
