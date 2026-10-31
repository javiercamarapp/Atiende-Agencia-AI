// Reactivacion AUTOMATICA de clientes dormidos (PM R23, F3): acceso TypeScript a la migracion 150 y el orquestador determinista.
//
// Reglas duras (todas verificables sin red):
//   * SOLO con opt-in: el candidato debe traer `optinEstado === "otorgado"`; cualquier otro valor se bloquea (`sin_optin`). Hoy el universo es 0.
//   * Ventana de dias [diasMin, diasMax] inclusiva (mediana de recompra de PM ~14 dias), favorito del cliente obligatorio (la plantilla lo lleva).
//   * Respeto de BAJA: la baja revoca el consentimiento (052) y ademas se consulta la lista de supresion de plataforma (puerto `Suprimidos`).
//   * Topes: 1 envio cada `minDiasEntreEnvios`, maximo `maxPorMes` por mes calendario, `topeDiario` por organizacion.
//   * Horario permitido [horaDesde, horaHasta) en la zona de la sucursal principal; fuera de horario NO se envia (el siguiente tick lo recoge).
//   * Plantilla Meta aprobada obligatoria para enviar (una reactivacion es marketing: siempre plantilla, dentro o fuera de las 24 h); sin ella
//     no se envia y se avisa al panel (`requiere_plantilla_aprobada`). En modo 'simulado' nunca se envia.
//   * Interruptor por sucursal (`sucursalActiva`, punto de integracion en SQL `reactivacion_sucursal_activa`).
//   * Idempotencia: una vez por (organizacion, cliente, dia) en la base y por `dedupeKey` en el outbox.
//   * Cada corrida deja una fila de auditoria sin PII.
// Base sin migrar (42883/42P01/42703): lecturas vacias / "no disponible", nunca un 500 (SAVEPOINT por llamada).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export type ModoReactivacion = "apagado" | "simulado" | "real";

export type MotivoBloqueo =
  | "sin_optin"
  | "sin_telefono"
  | "fuera_de_ventana_dias"
  | "queja_reciente"
  | "sucursal_apagada"
  | "suprimido"
  | "tope_intervalo"
  | "tope_mensual"
  | "sin_favorito"
  | "tope_diario"
  | "ya_registrado"
  | "error";

export type AvisoReactivacion = "requiere_plantilla_aprobada" | "requiere_whatsapp_conectado" | "fuera_de_horario";

export interface ContextoReactivacion {
  readonly modo: ModoReactivacion;
  readonly diasMin: number;
  readonly diasMax: number;
  readonly minDiasEntreEnvios: number;
  readonly maxPorMes: number;
  readonly horaDesde: number;
  readonly horaHasta: number;
  readonly topeDiario: number;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
  readonly plantillaAprobada: boolean;
  readonly phoneNumberId: string | null;
  readonly zonaHoraria: string;
  readonly enviadosHoy: number;
}

export interface CandidatoReactivacion {
  readonly customerId: string;
  readonly telefono: string | null;
  readonly nombre: string | null;
  readonly propertyId: string | null;
  readonly diasSinPedir: number;
  readonly favorito: string | null;
  readonly ultimoMensajeClienteAt: string | null;
  readonly optinEstado: string;
  readonly enviosEnIntervalo: number;
  readonly enviosEnMes: number;
  readonly quejaReciente: boolean;
  readonly sucursalActiva: boolean;
  readonly control: boolean;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Puro
// ------------------------------------------------------------------------------------------------------------------------------

/** Regla pura de elegibilidad (espejo del filtro SQL + topes). `null` = elegible. El orden fija el motivo reportado. */
export function evaluarCandidato(c: CandidatoReactivacion, ctx: Pick<ContextoReactivacion, "diasMin" | "diasMax" | "maxPorMes">): MotivoBloqueo | null {
  if (c.optinEstado !== "otorgado") return "sin_optin";
  if (c.telefono === null || c.telefono.trim() === "") return "sin_telefono";
  if (!Number.isFinite(c.diasSinPedir) || c.diasSinPedir < ctx.diasMin || c.diasSinPedir > ctx.diasMax) return "fuera_de_ventana_dias";
  if (c.quejaReciente) return "queja_reciente";
  if (!c.sucursalActiva) return "sucursal_apagada";
  if (c.enviosEnIntervalo > 0) return "tope_intervalo";
  if (c.enviosEnMes >= ctx.maxPorMes) return "tope_mensual";
  if (limpiarParametro(c.favorito, 60) === "") return "sin_favorito";
  return null;
}

/** Hora local (0-23) y dia calendario `YYYY-MM-DD` en la zona dada. */
export function relojLocal(now: Date, zona: string): { readonly hora: number; readonly dia: string } {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string): string => partes.find((p) => p.type === t)?.value ?? "";
  return { hora: Number(get("hour")), dia: `${get("year")}-${get("month")}-${get("day")}` };
}

export function dentroDeHorario(now: Date, ctx: Pick<ContextoReactivacion, "horaDesde" | "horaHasta" | "zonaHoraria">): boolean {
  const { hora } = relojLocal(now, ctx.zonaHoraria);
  return hora >= ctx.horaDesde && hora < ctx.horaHasta;
}

/** Meta rechaza saltos de linea, tabuladores y 4+ espacios en los parametros de una plantilla. */
export function limpiarParametro(v: string | null | undefined, max: number): string {
  if (!v) return "";
  return v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
}

/** Parametros de la plantilla: {{1}} primer nombre (o "cliente" si no hay) y {{2}} favorito. */
export function parametrosPlantilla(nombre: string | null, favorito: string): readonly [string, string] {
  const primero = limpiarParametro(nombre, 60).split(" ")[0] ?? "";
  return [primero === "" ? "cliente" : primero, limpiarParametro(favorito, 60)];
}

/** Texto de la plantilla propuesta (se registra en Meta tal cual; aqui solo se usa como `body` de respaldo y para mostrar el ejemplo en el panel). */
export const TEXTO_PLANTILLA_REACTIVACION = "Hola {{1}}, ¿se te antoja tu {{2}} de Los Taquitos de PM? Responde PEDIR y te ayudamos. Para no recibir más mensajes, responde BAJA.";

export function renderPlantilla(params: readonly [string, string]): string {
  return TEXTO_PLANTILLA_REACTIVACION.replace("{{1}}", params[0]).replace("{{2}}", params[1]);
}

export const claveEnvio = (organizationId: string, customerId: string, dia: string): string => `react:${organizationId}:${customerId}:${dia}`;

export interface MetricasReactivacion {
  readonly enviados: number;
  readonly simulados: number;
  readonly controles: number;
  readonly respondieron: number;
  readonly recompraron: number;
  readonly recompraronControl: number;
  readonly bajas: number;
  readonly atribucionDias: number;
}

export interface TasasReactivacion {
  readonly respuesta: number | null;
  readonly recompra: number | null;
  readonly recompraControl: number | null;
  /** Recompra de tratados menos recompra del control (puntos de proporcion). null si falta alguno de los dos grupos. */
  readonly incremental: number | null;
  readonly baja: number | null;
}

const razon = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function tasasReactivacion(m: MetricasReactivacion): TasasReactivacion {
  const recompra = razon(m.recompraron, m.enviados);
  const control = razon(m.recompraronControl, m.controles);
  return { respuesta: razon(m.respondieron, m.enviados), recompra, recompraControl: control, incremental: recompra !== null && control !== null ? recompra - control : null, baja: razon(m.bajas, m.enviados) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Puertos y orquestador
// ------------------------------------------------------------------------------------------------------------------------------
export interface MensajeReactivacion {
  readonly organizationId: string;
  readonly customerId: string;
  readonly telefono: string;
  readonly phoneNumberId: string;
  readonly plantilla: string;
  readonly idioma: string;
  readonly params: readonly [string, string];
  readonly body: string;
  readonly dedupeKey: string;
}

export interface EnviadorReactivacion {
  enviar(m: MensajeReactivacion): Promise<{ readonly outboxId: string | null }>;
}

export interface Suprimidos {
  estaSuprimido(telefono: string): Promise<boolean>;
}

export interface RepoReactivacion {
  organizaciones(now: Date): Promise<readonly string[]>;
  contexto(organizationId: string): Promise<ContextoReactivacion | null>;
  candidatos(organizationId: string, now: Date): Promise<readonly CandidatoReactivacion[]>;
  /** true = nuevo; false = ya existia ese cliente ese dia. */
  registrarEnvio(a: { organizationId: string; customerId: string; propertyId: string | null; dia: string; estado: "encolado" | "simulado" | "control"; plantilla: string | null; favorito: string | null; outboxId: string | null }): Promise<boolean>;
  registrarCorrida(a: { organizationId: string; modo: "simulado" | "real"; evaluados: number; enviados: number; simulados: number; controles: number; bloqueos: Readonly<Record<string, number>>; aviso: AvisoReactivacion | null }): Promise<void>;
}

export interface DependenciasReactivacion {
  readonly repo: RepoReactivacion;
  readonly enviador: EnviadorReactivacion;
  readonly suprimidos: Suprimidos;
  /** Avisa al panel (campana). Opcional; debe ser best-effort y sin PII. */
  readonly avisarPanel?: (organizationId: string, aviso: AvisoReactivacion) => Promise<void>;
}

export interface ResultadoReactivacionOrg {
  readonly estado: "apagado" | "ejecutada";
  readonly evaluados: number;
  readonly enviados: number;
  readonly simulados: number;
  readonly controles: number;
  readonly bloqueos: Readonly<Record<string, number>>;
  readonly aviso: AvisoReactivacion | null;
}

const VACIO: ResultadoReactivacionOrg = { estado: "apagado", evaluados: 0, enviados: 0, simulados: 0, controles: 0, bloqueos: {}, aviso: null };

export async function ejecutarReactivacionOrg(deps: DependenciasReactivacion, organizationId: string, now: Date): Promise<ResultadoReactivacionOrg> {
  const ctx = await deps.repo.contexto(organizationId);
  if (!ctx || ctx.modo === "apagado") return VACIO;
  const modo = ctx.modo;
  const bloqueos: Record<string, number> = {};
  const bloquear = (m: MotivoBloqueo): void => {
    bloqueos[m] = (bloqueos[m] ?? 0) + 1;
  };
  const cerrar = async (r: Omit<ResultadoReactivacionOrg, "estado" | "bloqueos"> & { bloqueos?: Record<string, number> }): Promise<ResultadoReactivacionOrg> => {
    const out: ResultadoReactivacionOrg = { estado: "ejecutada", evaluados: r.evaluados, enviados: r.enviados, simulados: r.simulados, controles: r.controles, bloqueos: r.bloqueos ?? bloqueos, aviso: r.aviso };
    await deps.repo.registrarCorrida({ organizationId, modo, evaluados: out.evaluados, enviados: out.enviados, simulados: out.simulados, controles: out.controles, bloqueos: out.bloqueos, aviso: out.aviso });
    if (out.aviso && deps.avisarPanel) await deps.avisarPanel(organizationId, out.aviso).catch(() => undefined);
    return out;
  };

  // Requisitos globales: sin ellos NO se envia y el panel se entera. En 'simulado' la falta de plantilla se reporta pero la simulacion sigue.
  let aviso: AvisoReactivacion | null = null;
  if (!ctx.plantillaAprobada || !ctx.plantillaNombre) aviso = "requiere_plantilla_aprobada";
  else if (!ctx.phoneNumberId) aviso = "requiere_whatsapp_conectado";
  if (aviso && modo === "real") return cerrar({ evaluados: 0, enviados: 0, simulados: 0, controles: 0, aviso });
  if (!dentroDeHorario(now, ctx)) return cerrar({ evaluados: 0, enviados: 0, simulados: 0, controles: 0, aviso: aviso ?? "fuera_de_horario" });

  const dia = relojLocal(now, ctx.zonaHoraria).dia;
  const candidatos = [...(await deps.repo.candidatos(organizationId, now))].sort((a, b) => (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0));
  let enviados = 0;
  let simulados = 0;
  let controles = 0;
  let hoy = ctx.enviadosHoy;
  for (const c of candidatos) {
    try {
      const motivo = evaluarCandidato(c, ctx);
      if (motivo) {
        bloquear(motivo);
        continue;
      }
      if (c.control) {
        // Grupo de control: se registra (para medir) y NO recibe mensaje.
        if (await deps.repo.registrarEnvio({ organizationId, customerId: c.customerId, propertyId: c.propertyId, dia, estado: "control", plantilla: null, favorito: null, outboxId: null })) controles += 1;
        continue;
      }
      if (hoy >= ctx.topeDiario) {
        bloquear("tope_diario");
        continue;
      }
      if (await deps.suprimidos.estaSuprimido(c.telefono as string)) {
        bloquear("suprimido");
        continue;
      }
      const params = parametrosPlantilla(c.nombre, c.favorito as string);
      if (modo === "simulado") {
        if (await deps.repo.registrarEnvio({ organizationId, customerId: c.customerId, propertyId: c.propertyId, dia, estado: "simulado", plantilla: ctx.plantillaNombre, favorito: params[1], outboxId: null })) {
          simulados += 1;
          hoy += 1;
        } else bloquear("ya_registrado");
        continue;
      }
      const { outboxId } = await deps.enviador.enviar({
        organizationId,
        customerId: c.customerId,
        telefono: c.telefono as string,
        phoneNumberId: ctx.phoneNumberId as string,
        plantilla: ctx.plantillaNombre as string,
        idioma: ctx.plantillaIdioma,
        params,
        body: renderPlantilla(params),
        dedupeKey: claveEnvio(organizationId, c.customerId, dia),
      });
      if (await deps.repo.registrarEnvio({ organizationId, customerId: c.customerId, propertyId: c.propertyId, dia, estado: "encolado", plantilla: ctx.plantillaNombre, favorito: params[1], outboxId })) {
        enviados += 1;
        hoy += 1;
      } else bloquear("ya_registrado");
    } catch {
      bloquear("error");
    }
  }
  return cerrar({ evaluados: candidatos.length, enviados, simulados, controles, aviso });
}

export interface ResultadoBarridoReactivacion {
  readonly organizaciones: number;
  readonly enviados: number;
  readonly simulados: number;
  readonly errores: number;
}

/** Tick: recorre las organizaciones con reactivacion encendida. Una falla de una no frena a las demas. */
export async function barrerReactivacion(deps: DependenciasReactivacion, now: Date): Promise<ResultadoBarridoReactivacion> {
  const orgs = await deps.repo.organizaciones(now);
  let enviados = 0;
  let simulados = 0;
  let errores = 0;
  for (const org of orgs) {
    try {
      const r = await ejecutarReactivacionOrg(deps, org, now);
      enviados += r.enviados;
      simulados += r.simulados;
    } catch {
      errores += 1;
    }
  }
  return { organizaciones: orgs.length, enviados, simulados, errores };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Adaptadores
// ------------------------------------------------------------------------------------------------------------------------------
/** Adaptador de envio FALSO: no toca la red ni el outbox; solo recuerda lo que se le pidio. Idempotente por dedupeKey como el outbox real. */
export class EnviadorFalso implements EnviadorReactivacion {
  readonly enviados: MensajeReactivacion[] = [];
  async enviar(m: MensajeReactivacion): Promise<{ outboxId: string | null }> {
    if (!this.enviados.some((x) => x.dedupeKey === m.dedupeKey)) this.enviados.push(m);
    return { outboxId: null };
  }
}

/** Adaptador REAL (no se usa en tests ni en esta rama): encola en messaging_outbox con plantilla y `transaccional: false` (la supresion de plataforma lo frena). */
export function crearEnviadorOutbox(enqueue: (organizationId: string, channel: "whatsapp", eventType: string, dedupeKey: string, payload: unknown) => Promise<void>): EnviadorReactivacion {
  return {
    async enviar(m) {
      await enqueue(m.organizationId, "whatsapp", "marketing_reactivacion_automatica", m.dedupeKey, {
        to: m.telefono,
        phone_number_id: m.phoneNumberId,
        body: m.body,
        transaccional: false,
        template: { name: m.plantilla, language: m.idioma, params: [...m.params] },
      });
      return { outboxId: null };
    },
  };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/** Repositorio sobre la migracion 150. Cada llamada va en su SAVEPOINT; base sin migrar = vacio honesto. */
export function crearRepoReactivacionPostgres(session: TenantDbSession): RepoReactivacion {
  const pendiente = isMigrationPendingError;
  return {
    organizaciones: (now) =>
      runWithSavepointFallback<readonly string[]>({
        session,
        savepointName: "sp_react_orgs",
        primary: async () => (await session.query<{ organization_id: string }>(`select organization_id from restaurantes.reactivacion_organizaciones($1::timestamptz);`, [now.toISOString()])).rows.map((r) => String(r.organization_id)),
        isRecoverable: pendiente,
        fallback: async () => [],
      }),
    contexto: (org) =>
      runWithSavepointFallback<ContextoReactivacion | null>({
        session,
        savepointName: "sp_react_ctx",
        primary: async () => {
          const r = (await session.query<Record<string, unknown>>(`select * from restaurantes.reactivacion_contexto($1::uuid);`, [org])).rows[0];
          if (!r) return null;
          return {
            modo: r.modo as ModoReactivacion,
            diasMin: num(r.dias_min),
            diasMax: num(r.dias_max),
            minDiasEntreEnvios: num(r.min_dias_entre_envios),
            maxPorMes: num(r.max_por_mes),
            horaDesde: num(r.hora_desde),
            horaHasta: num(r.hora_hasta),
            topeDiario: num(r.tope_diario),
            plantillaNombre: str(r.plantilla_nombre),
            plantillaIdioma: String(r.plantilla_idioma),
            plantillaAprobada: r.plantilla_aprobada === true,
            phoneNumberId: str(r.phone_number_id),
            zonaHoraria: String(r.zona_horaria ?? "America/Merida"),
            enviadosHoy: num(r.enviados_hoy),
          };
        },
        isRecoverable: pendiente,
        fallback: async () => null,
      }),
    candidatos: (org, now) =>
      runWithSavepointFallback<readonly CandidatoReactivacion[]>({
        session,
        savepointName: "sp_react_cand",
        primary: async () =>
          (await session.query<Record<string, unknown>>(`select * from restaurantes.reactivacion_candidatos($1::uuid, $2::timestamptz);`, [org, now.toISOString()])).rows.map((r) => ({
            customerId: String(r.customer_id),
            telefono: str(r.telefono),
            nombre: str(r.nombre),
            propertyId: str(r.property_id),
            diasSinPedir: num(r.dias_sin_pedir),
            favorito: str(r.favorito),
            ultimoMensajeClienteAt: iso(r.ultimo_mensaje_cliente_at),
            optinEstado: String(r.optin_estado),
            enviosEnIntervalo: num(r.envios_en_intervalo),
            enviosEnMes: num(r.envios_en_mes),
            quejaReciente: r.queja_reciente === true,
            sucursalActiva: r.sucursal_activa === true,
            control: r.control === true,
          })),
        isRecoverable: pendiente,
        fallback: async () => [],
      }),
    registrarEnvio: (a) =>
      runWithSavepointFallback<boolean>({
        session,
        savepointName: "sp_react_envio",
        primary: async () =>
          (await session.query<{ nuevo: boolean }>(`select restaurantes.reactivacion_registrar_envio($1::uuid, $2::uuid, $3::uuid, $4::date, $5::text, $6::text, $7::text, $8::uuid) as nuevo;`, [a.organizationId, a.customerId, a.propertyId, a.dia, a.estado, a.plantilla, a.favorito, a.outboxId])).rows[0]?.nuevo === true,
        isRecoverable: pendiente,
        fallback: async () => false,
      }),
    registrarCorrida: (a) =>
      runWithSavepointFallback<void>({
        session,
        savepointName: "sp_react_corrida",
        primary: async () => {
          await session.query(`select restaurantes.reactivacion_registrar_corrida($1::uuid, $2::text, $3::int, $4::int, $5::int, $6::int, $7::jsonb, $8::text);`, [a.organizationId, a.modo, a.evaluados, a.enviados, a.simulados, a.controles, JSON.stringify(a.bloqueos), a.aviso]);
        },
        isRecoverable: pendiente,
        fallback: async () => undefined,
      }),
  };
}

/** Metricas (owner/admin) para medir si la reactivacion funciona. `disponible: false` = base sin la migracion 150. */
export async function leerMetricasReactivacion(session: TenantDbSession, organizationId: string, desde: Date, hasta: Date): Promise<{ readonly disponible: boolean; readonly valor: MetricasReactivacion | null }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly valor: MetricasReactivacion | null }>({
    session,
    savepointName: "sp_react_metricas",
    primary: async () => {
      const r = (await session.query<Record<string, unknown>>(`select * from restaurantes.reactivacion_metricas($1::uuid, $2::timestamptz, $3::timestamptz);`, [organizationId, desde.toISOString(), hasta.toISOString()])).rows[0];
      if (!r) return { disponible: true, valor: null };
      return {
        disponible: true,
        valor: { enviados: num(r.enviados), simulados: num(r.simulados), controles: num(r.controles), respondieron: num(r.respondieron), recompraron: num(r.recompraron), recompraronControl: num(r.recompraron_control), bajas: num(r.bajas), atribucionDias: num(r.atribucion_dias) },
      };
    },
    isRecoverable: isMigrationPendingError,
    fallback: async () => ({ disponible: false, valor: null }),
  });
}
