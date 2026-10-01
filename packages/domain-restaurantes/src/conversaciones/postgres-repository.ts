// Adaptador Postgres de `ConversacionesRepository` y de `HandoffAgentGate`. REGLA DURA de compatibilidad con
// la base SIN migrar: mergear despliega el codigo al instante y la migracion 028 no se aplica sola. Toda
// consulta corre dentro de la transaccion UNICA de un request (`withAppSession`), donde un error de Postgres
// la deja abortada (25P02) y el COMMIT seria un ROLLBACK silencioso; por eso TODA operacion usa
// `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) antes de degradar: lecturas ->
// `disponible: false`, escrituras -> `ConversacionesNoDisponibleError` (503), el gate del agente -> "sin toma".
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { ConversacionesRepository, HandoffAgentGate } from "./repository.ts";
import {
  CALLBACK_RESULTADOS,
  ConversacionesNoDisponibleError,
  ConversacionesConflictoError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  HANDOFF_ESTADOS,
  HandoffYaTomadoError,
  SinNumeroWhatsappError,
} from "./types.ts";
import type {
  BandejaFiltro,
  BandejaItem,
  BandejaPagina,
  CallbackIntento,
  CallbackIntentoEntrada,
  CallbackItem,
  CallbackResultado,
  ConversacionCanal,
  ConversacionDetalle,
  ConversacionesLectura,
  HandoffDetalle,
  HandoffEstado,
  MensajeConversacion,
  NotaInterna,
  TurnoEntrada,
  TurnoPersonal,
} from "./types.ts";

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Objeto de la migracion 028 inexistente: tabla, columna o funcion. */
export function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

/** Rechazos de negocio que la base declara con un SQLSTATE conocido. */
function esRechazoConocido(err: unknown): boolean {
  const c = code(err);
  return esBaseSinMigrar(err) || c === "42501" || c === "55006" || c === "P0002" || c === "22023" || c === "23514" || c === "23503" || c === "23505";
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresConversacionesRepository: las tablas/funciones de handoff todavía no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/028_conversaciones_handoff_turnos.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

function aError(err: unknown): never {
  const c = code(err);
  if (esBaseSinMigrar(err)) {
    advertirNoDisponible(err);
    throw new ConversacionesNoDisponibleError();
  }
  if (c === "55006") throw new HandoffYaTomadoError();
  if (c === "P0002") throw new SinNumeroWhatsappError();
  if (c === "22023" || c === "23514") throw new ConversacionesValidacionError("Dato fuera de rango (revisa el texto, el turno o el resultado).");
  if (c === "23505") throw new ConversacionesConflictoError();
  if (c === "23503") throw new ConversacionesValidacionError("Referencia inexistente (revisa la persona o la sucursal indicada).");
  throw new ConversacionesRechazadaError();
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrNull = (v: Date | string | null): string | null => (v === null || v === undefined ? null : iso(v));
const hhmm = (v: string): string => v.slice(0, 5);

interface BandejaRow {
  canal: string;
  conversation_id: string;
  property_id: string;
  telefono: string | null;
  vista_previa: string;
  actividad_at: Date | string;
  estado: string;
  handoff_id: string | null;
  motivo: string | null;
  solicitada_at: Date | string | null;
  ultimo_cliente_at: Date | string | null;
  tomada_por: string | null;
  tomada_por_nombre: string | null;
  tomada_at: Date | string | null;
  resultado_voz: string | null;
  total: string | number;
}

function mapBandeja(r: BandejaRow): BandejaItem {
  return {
    canal: r.canal === "voz" ? "voz" : "whatsapp",
    conversationId: r.conversation_id,
    propertyId: r.property_id,
    telefono: r.telefono,
    vistaPrevia: r.vista_previa ?? "",
    actividadAt: iso(r.actividad_at),
    estado: (HANDOFF_ESTADOS as readonly string[]).includes(r.estado) ? (r.estado as HandoffEstado) : "agente",
    handoffId: r.handoff_id,
    motivo: r.motivo,
    solicitadaAt: isoOrNull(r.solicitada_at),
    ultimoClienteAt: isoOrNull(r.ultimo_cliente_at),
    tomadaPor: r.tomada_por,
    tomadaPorNombre: r.tomada_por_nombre,
    tomadaAt: isoOrNull(r.tomada_at),
    resultadoVoz: r.resultado_voz,
  };
}

export class PostgresConversacionesRepository implements ConversacionesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private lectura<T>(savepointName: string, vacio: T, primary: () => Promise<T>): Promise<ConversacionesLectura<T>> {
    return runWithSavepointFallback<ConversacionesLectura<T>>({
      session: this.db,
      savepointName,
      primary: async () => ({ disponible: true, valor: await primary() }),
      isRecoverable: (err) => esBaseSinMigrar(err) || code(err) === "42501",
      fallback: async (err) => {
        if (code(err) === "42501") throw new ConversacionesRechazadaError();
        advertirNoDisponible(err);
        return { disponible: false, valor: vacio };
      },
    });
  }

  private escritura<T>(savepointName: string, primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({ session: this.db, savepointName, primary, isRecoverable: esRechazoConocido, fallback: aError });
  }

  async listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>> {
    return this.lectura<BandejaPagina>("sp_conv_bandeja_read", { items: [], total: 0 }, async () => {
      const { rows } = await this.db.query<BandejaRow>(
        `select canal, conversation_id, property_id, telefono, vista_previa, actividad_at, estado, handoff_id, motivo, solicitada_at,
                ultimo_cliente_at, tomada_por, tomada_por_nombre, tomada_at, resultado_voz, total
           from restaurantes.bandeja_conversaciones($1::uuid, $2::uuid, $3::text, $4::text, $5::int, $6::int);`,
        [organizationId, propertyId, filtro.estado ?? null, filtro.canal ?? null, filtro.limit ?? 25, filtro.offset ?? 0],
      );
      return { items: rows.map(mapBandeja), total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
    });
  }

  async detalle(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>> {
    return this.lectura<ConversacionDetalle | null>("sp_conv_detalle_read", null, async () => {
      // Pertenencia: la bandeja filtra por organizacion/sucursal; aqui el mismo criterio antes de leer mensajes.
      let mensajes: MensajeConversacion[] = [];
      let transcripcionDisponible = true;
      if (canal === "whatsapp") {
        const { rows } = await this.db.query<{ messages: unknown }>(
          `select messages from restaurantes.whatsapp_conversations where id = $1 and organization_id = $2 and (property_id is null or property_id = $3);`,
          [conversationId, organizationId, propertyId],
        );
        if (!rows[0]) return null;
        const arr = Array.isArray(rows[0].messages) ? (rows[0].messages as Array<Record<string, unknown>>) : [];
        mensajes = arr.map((m) => ({
          rol: m.role === "user" ? "cliente" : m.autor === "humano" ? "humano" : "agente",
          texto: typeof m.content === "string" ? m.content : "",
          createdAt: null,
        }));
      } else {
        const conv = await this.db.query<{ id: string }>(
          `select id from restaurantes.voice_conversation where id = $1 and organization_id = $2 and property_id = $3;`,
          [conversationId, organizationId, propertyId],
        );
        if (!conv.rows[0]) {
          // RLS (025): solo owner/admin o quien tomo la llamada leen la conversacion de voz. Distingue "no
          // existe" de "no la puedo leer" mirando si hay una toma visible para esa sucursal.
          const visible = await this.db.query<{ id: string }>(
            `select handoff_id as id from restaurantes.handoff_detalle($1::uuid, $2::uuid, 'voz', $3::uuid);`,
            [organizationId, propertyId, conversationId],
          );
          if (!visible.rows[0]) return null;
          transcripcionDisponible = false;
        } else {
          const turnos = await this.db.query<{ rol: string; texto: string; created_at: Date | string }>(
            `select rol, texto, created_at from restaurantes.voice_turn where conversation_id = $1 and organization_id = $2 order by seq;`,
            [conversationId, organizationId],
          );
          mensajes = turnos.rows.map((t) => ({ rol: t.rol === "cliente" ? "cliente" : t.rol === "herramienta" ? "herramienta" : "agente", texto: t.texto, createdAt: iso(t.created_at) }));
        }
      }
      const h = await this.db.query<{
        handoff_id: string; estado: string; solicitado_por: string; motivo: string | null; solicitada_at: Date | string;
        ultimo_cliente_at: Date | string | null; tomada_por: string | null; tomada_por_nombre: string | null; tomada_at: Date | string | null;
      }>(`select handoff_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, tomada_por, tomada_por_nombre, tomada_at from restaurantes.handoff_detalle($1::uuid, $2::uuid, $3::text, $4::uuid);`, [organizationId, propertyId, canal, conversationId]);
      const row = h.rows[0];
      const handoff: HandoffDetalle | null = row
        ? {
            handoffId: row.handoff_id,
            estado: row.estado as HandoffDetalle["estado"],
            solicitadoPor: row.solicitado_por === "staff" ? "staff" : "agente",
            motivo: row.motivo,
            solicitadaAt: iso(row.solicitada_at),
            ultimoClienteAt: isoOrNull(row.ultimo_cliente_at),
            tomadaPor: row.tomada_por,
            tomadaPorNombre: row.tomada_por_nombre,
            tomadaAt: isoOrNull(row.tomada_at),
          }
        : null;
      let notas: NotaInterna[] = [];
      if (handoff) {
        const n = await this.db.query<{ id: string; autor_id: string | null; autor_nombre: string | null; texto: string; created_at: Date | string }>(
          `select id, autor_id, autor_nombre, texto, created_at from restaurantes.handoff_notas($1::uuid, $2::uuid, $3::uuid);`,
          [organizationId, propertyId, handoff.handoffId],
        );
        notas = n.rows.map((x) => ({ id: x.id, autorId: x.autor_id, autorNombre: x.autor_nombre, texto: x.texto, createdAt: iso(x.created_at) }));
      }
      return { canal, conversationId, mensajes, transcripcionDisponible, handoff, notas };
    });
  }

  async tomar(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<string> {
    return this.escritura("sp_conv_tomar", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select restaurantes.handoff_tomar($1::uuid, $2::uuid, $3::text, $4::uuid) as id;`, [organizationId, propertyId, canal, conversationId]);
      return rows[0]!.id;
    });
  }

  async devolver(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.escritura("sp_conv_devolver", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select restaurantes.handoff_devolver($1::uuid, $2::uuid, $3::uuid) as ok;`, [organizationId, propertyId, handoffId]);
      return rows[0]!.ok === true;
    });
  }

  async cerrar(organizationId: string, propertyId: string, handoffId: string): Promise<boolean> {
    return this.escritura("sp_conv_cerrar", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select restaurantes.handoff_cerrar($1::uuid, $2::uuid, $3::uuid) as ok;`, [organizationId, propertyId, handoffId]);
      return rows[0]!.ok === true;
    });
  }

  async agregarNota(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    return this.escritura("sp_conv_nota", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select restaurantes.handoff_agregar_nota($1::uuid, $2::uuid, $3::uuid, $4::text) as id;`, [organizationId, propertyId, handoffId, texto]);
      return rows[0]!.id;
    });
  }

  async responderWhatsapp(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string> {
    return this.escritura("sp_conv_responder", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select restaurantes.handoff_responder_whatsapp($1::uuid, $2::uuid, $3::uuid, $4::text) as id;`, [organizationId, propertyId, handoffId, texto]);
      return rows[0]!.id;
    });
  }

  async listarTurnos(organizationId: string, propertyId: string): Promise<ConversacionesLectura<readonly TurnoPersonal[]>> {
    return this.lectura<readonly TurnoPersonal[]>("sp_conv_turnos_read", [], async () => {
      const { rows } = await this.db.query<{
        shift_id: string; nombre: string; dias: number[]; inicia: string; termina: string; user_id: string | null; user_nombre: string | null; orden: number | null;
      }>(`select shift_id, nombre, dias, inicia::text as inicia, termina::text as termina, user_id, user_nombre, orden from restaurantes.turnos_sucursal($1::uuid, $2::uuid);`, [organizationId, propertyId]);
      const porId = new Map<string, { id: string; nombre: string; dias: number[]; inicia: string; termina: string; miembros: TurnoPersonal["miembros"][number][] }>();
      for (const r of rows) {
        let t = porId.get(r.shift_id);
        if (!t) {
          t = { id: r.shift_id, nombre: r.nombre, dias: [...r.dias].map(Number).sort((a, b) => a - b), inicia: hhmm(r.inicia), termina: hhmm(r.termina), miembros: [] };
          porId.set(r.shift_id, t);
        }
        if (r.user_id) t.miembros.push({ userId: r.user_id, nombre: r.user_nombre, orden: Number(r.orden ?? 1) });
      }
      return [...porId.values()];
    });
  }

  async reemplazarTurnos(organizationId: string, propertyId: string, turnos: readonly TurnoEntrada[]): Promise<void> {
    await this.escritura("sp_conv_turnos_write", async () => {
      await this.db.query(`delete from restaurantes.branch_shift where organization_id = $1 and property_id = $2;`, [organizationId, propertyId]);
      for (const t of turnos) {
        const { rows } = await this.db.query<{ id: string }>(
          `insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina)
           values ($1, $2, $3, $4::smallint[], $5::time, $6::time) returning id;`,
          [organizationId, propertyId, t.nombre, t.dias, t.inicia, t.termina],
        );
        const shiftId = rows[0]!.id;
        for (const m of t.miembros) {
          await this.db.query(
            `insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ($1, $2, $3, $4, $5);`,
            [shiftId, propertyId, organizationId, m.userId, m.orden],
          );
        }
      }
    });
  }

  async listarCallbacks(organizationId: string, propertyId: string, soloAbiertos: boolean): Promise<ConversacionesLectura<readonly CallbackItem[]>> {
    return this.lectura<readonly CallbackItem[]>("sp_conv_callbacks_read", [], async () => {
      const { rows } = await this.db.query<{
        id: string; property_id: string | null; customer_name: string; customer_phone: string; reason: string | null; message: string | null;
        source: string; resolved: boolean; created_at: Date | string; intentos: unknown;
      }>(`select id, property_id, customer_name, customer_phone, reason, message, source, resolved, created_at, intentos from restaurantes.callbacks_sucursal($1::uuid, $2::uuid, $3::boolean, 100);`, [organizationId, propertyId, soloAbiertos]);
      return rows.map((r) => ({
        id: r.id,
        propertyId: r.property_id,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        reason: r.reason,
        message: r.message,
        source: (["voice", "whatsapp", "web", "admin"] as const).find((s) => s === r.source) ?? "admin",
        resolved: r.resolved === true,
        createdAt: iso(r.created_at),
        intentos: (Array.isArray(r.intentos) ? (r.intentos as Array<Record<string, unknown>>) : []).map(
          (a): CallbackIntento => ({
            id: String(a.id),
            resultado: (CALLBACK_RESULTADOS as readonly string[]).includes(String(a.resultado)) ? (a.resultado as CallbackResultado) : "no_contesto",
            nota: typeof a.nota === "string" ? a.nota : null,
            proximoIntentoAt: typeof a.proximoIntentoAt === "string" ? iso(a.proximoIntentoAt) : null,
            autor: typeof a.autor === "string" ? a.autor : null,
            creadoAt: iso(String(a.creadoAt)),
          }),
        ),
      }));
    });
  }

  async registrarIntentoCallback(organizationId: string, callbackId: string, intento: CallbackIntentoEntrada): Promise<string> {
    return this.escritura("sp_conv_callback_intento", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `select restaurantes.callback_registrar_intento($1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz) as id;`,
        [organizationId, callbackId, intento.resultado, intento.nota, intento.proximoIntentoAt],
      );
      return rows[0]!.id;
    });
  }
}

/** Gate del agente de WhatsApp: corre en la sesion de SISTEMA del webhook. Contra la base sin migrar el agente
 * sigue respondiendo como siempre (nunca falla el turno por esto). */
export class PostgresHandoffAgentGate implements HandoffAgentGate {
  constructor(private readonly db: TenantDbSession) {}

  async estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null> {
    return runWithSavepointFallback<"pendiente" | "tomada" | null>({
      session: this.db,
      savepointName: "sp_handoff_gate_estado",
      primary: async () => {
        const { rows } = await this.db.query<{ estado: string | null }>(`select restaurantes.handoff_whatsapp_estado($1::uuid, $2::text) as estado;`, [organizationId, phone]);
        const e = rows[0]?.estado;
        return e === "pendiente" || e === "tomada" ? e : null;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return null;
      },
    });
  }

  async solicitarHumano(input: { organizationId: string; propertyId: string | null; phone: string; motivo: string }): Promise<string | null> {
    return runWithSavepointFallback<string | null>({
      session: this.db,
      savepointName: "sp_handoff_gate_solicitar",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string | null }>(`select restaurantes.handoff_solicitar_whatsapp($1::uuid, $2::uuid, $3::text, $4::text) as id;`, [input.organizationId, input.propertyId, input.phone, input.motivo]);
        return rows[0]?.id ?? null;
      },
      // 42501: el numero que recibio el mensaje no coincide con la sucursal ya guardada en la conversacion. No es
      // recuperable reintentando (Meta reintentaria y volveria a correr el LLM): el gate degrada a null y el aviso
      // de callback existente sigue su camino.
      isRecoverable: (err) => esBaseSinMigrar(err) || code(err) === "42501",
      fallback: async (err) => {
        if (esBaseSinMigrar(err)) advertirNoDisponible(err);
        return null;
      },
    });
  }
}
