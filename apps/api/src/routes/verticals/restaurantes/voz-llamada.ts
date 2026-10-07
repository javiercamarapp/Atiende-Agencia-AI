// Rutas que usa el WORKER DE TELEFONIA de voz (apps/voice-worker, migración 067) y su KPI en el panel. Lado SISTEMA (secreto interno
// `x-atiende-internal-secret`, comparado en tiempo constante; el llamador es un servicio, no un staff):
//
//   POST /internal/restaurantes/voz/llamada/contexto                     lo que el worker necesita para abrir UNA llamada: ¿la sucursal tiene el agente
//        habilitado?, la instrucción armada con el perfil de PM, la memoria del cliente (por el teléfono del SIP From) y el gasto de voz del mes
//        (para el tope mensual). No devuelve secretos ni el historial en bruto: solo la instrucción.
//   POST /internal/restaurantes/voz/conversaciones/:id/costo             costo por escalón (Gemini Live / cascada) hacia core.usage_cost_event; los
//        eventos los arma el servidor desde los TRAMOS (duración por escalón). El worker informa el costo reportado (tope por tramo) y, con `costoReal: true`, ese importe
//        sale de los tokens `usageMetadata` del proveedor y se registra TAL CUAL aunque quede por debajo del piso por minuto (antes solo podía subirlo); la ruta exige el
//        secreto interno, así que ese importe viene de un servicio de confianza.
//   POST /internal/restaurantes/voz/conversaciones/:id/modo-entrada      desborde | total | prueba y la franja del día (migración 067).
//   POST /internal/restaurantes/voz/tope-mensual                         aviso in-app al owner/admin: el gasto de voz del mes llegó al 80 % del tope o lo alcanzó
//        (el tope vive en la configuración del worker, que es quien lo compara; aquí solo se emite el aviso, con dedupe por organización y mes).
//
// Lado PANEL (staff owner/admin con alcance de la sucursal):
//   GET  /v1/restaurantes/:propertyId/admin/voz/kpi-desborde             llamadas que el personal no contestó -> pedidos -> ventas recuperadas, y
//        la latencia de voz a voz p50/p95 contra el objetivo de 1.5 s.
//
// Base SIN migrar: el contexto sigue funcionando (gasto null = no bloquea); costo y modo de entrada responden 503 honesto; el KPI dice
// `disponible: false`. Cada lectura/escritura degrada con SAVEPOINT dentro de la transacción del request (PostgresVozLlamadaRepository).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  FRANJAS_VOZ,
  LATENCIA_VOZ_OBJETIVO_P95_MS,
  MODOS_ENTRADA_VOZ,
  STAFF_INVITE_ROLES,
  VOZ_POR_DEFECTO,
  armarInstruccionLlamada,
  canonicalizeMexicanPhone,
  diaLocalSucursal,
} from "@atiende/domain-restaurantes";
import type { FranjaVoz, ModoEntradaVoz, VozLlamadaRepository, VozModoEntradaKpiDia } from "@atiende/domain-restaurantes";
import { emitirNotificacion } from "@atiende/db";
import { ESCALERA_VOZ, eventosCostoLlamada } from "@atiende/voice-core";
import type { EscalonVoz, TramoLlamada } from "@atiende/voice-core";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { UUID_RE } from "./voz-admin.ts";

const CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Una llamada no dura mas que esto (la maquina corta a los 8 min): cualquier tramo mayor es un dato corrupto. */
const TRAMO_MAX_S = 6 * 60 * 60;
/** Tope de cordura por tramo (micro-USD): 100 USD. */
const TRAMO_COSTO_MAX_MICRO_USD = 100_000_000;
const SERIE_DIAS_POR_DEFECTO = 14;

function exigirSecreto(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();
}

function uuid(value: unknown, campo: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return value;
}

function parsearTramos(value: unknown): TramoLlamada[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw Errors.validation("tramos: se esperaba una lista de 1 a 8 tramos.");
  return value.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    if (typeof o.escalon !== "string" || !(ESCALERA_VOZ as readonly string[]).includes(o.escalon)) throw Errors.validation(`tramos[${i}].escalon: debe ser uno de ${ESCALERA_VOZ.join(", ")}.`);
    if (typeof o.duracionS !== "number" || !Number.isFinite(o.duracionS) || o.duracionS < 0 || o.duracionS > TRAMO_MAX_S) throw Errors.validation(`tramos[${i}].duracionS: se esperaba un número entre 0 y ${TRAMO_MAX_S}.`);
    if (typeof o.costoReportadoMicroUsd !== "number" || !Number.isFinite(o.costoReportadoMicroUsd) || o.costoReportadoMicroUsd < 0 || o.costoReportadoMicroUsd > TRAMO_COSTO_MAX_MICRO_USD) throw Errors.validation(`tramos[${i}].costoReportadoMicroUsd: se esperaba un número entre 0 y ${TRAMO_COSTO_MAX_MICRO_USD}.`);
    // `costoReal` (opcional: un worker anterior no lo manda): el costo sale de los tokens que informo el proveedor, no de una tarifa.
    return { escalon: o.escalon as EscalonVoz, duracionS: o.duracionS, costoReportadoMicroUsd: o.costoReportadoMicroUsd, ...(o.costoReal === true ? { costoReal: true } : {}) };
  });
}

function serializarDia(d: VozModoEntradaKpiDia) {
  return {
    fecha: d.fecha,
    llamadasDesborde: d.llamadasDesborde,
    pedidosDesborde: d.pedidosDesborde,
    ventasRecuperadas: d.ventasRecuperadas,
    llamadasConModo: d.llamadasConModo,
    llamadasConLatencia: d.llamadasConLatencia,
    latenciaP50Ms: d.latenciaP50Ms,
    latenciaP95Ms: d.latenciaP95Ms,
  };
}

export function restaurantesVozLlamadaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/internal/restaurantes/voz";

  function llamadaRepo(db: Parameters<NonNullable<AppDeps["vozLlamadaRepo"]>>[0]): VozLlamadaRepository {
    if (!deps.vozLlamadaRepo) throw Errors.serviceUnavailable("El worker de voz no está disponible en este despliegue.");
    return deps.vozLlamadaRepo(db);
  }

  app.post(`${base}/llamada/contexto`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const propertyId = uuid(body.propertyId, "propertyId");
    let telefono: string | null = null;
    if (body.callerPhone !== undefined && body.callerPhone !== null) {
      telefono = typeof body.callerPhone === "string" ? canonicalizeMexicanPhone(body.callerPhone) : null;
      if (!telefono) throw Errors.validation("callerPhone: se esperaban 10 dígitos (con o sin +52/521).");
    }
    if (!deps.vozRepo) throw Errors.serviceUnavailable("La voz no está disponible en este despliegue.");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const restaurantes = deps.restaurantesRepo(db);
      const sucursal = await restaurantes.findBranchById(organizationId, propertyId);
      if (!sucursal) throw Errors.notFound("La sucursal no existe para esa organización.");
      const lectura = await deps.vozRepo!(db).getConfig(propertyId);
      const ahora = new Date();
      const { instruccion, horaLocal } = await armarInstruccionLlamada(restaurantes, { organizationId, propertyId, telefono, config: lectura.valor, ahora });
      // Base sin la tabla de configuración (025): `getConfig` devuelve el valor inicial (habilitado: false) y el worker no abre sesión: honesto.
      const gasto = deps.vozLlamadaRepo ? await deps.vozLlamadaRepo(db).gastoMesMicroUsd(organizationId, ahora) : null;
      return c.json({
        habilitado: lectura.disponible && lectura.valor.habilitado,
        configurada: lectura.valor.configurada,
        voiceId: lectura.valor.voiceId || VOZ_POR_DEFECTO,
        instruccion,
        gastoMesMicroUsd: gasto,
        horaLocal,
      });
    });
  });

  app.post(`${base}/conversaciones/:conversationId/costo`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const conversationId = uuid(c.req.param("conversationId"), "conversationId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const propertyId = uuid(body.propertyId, "propertyId");
    if (typeof body.llamadaId !== "string" || !CALL_ID_RE.test(body.llamadaId)) throw Errors.validation("llamadaId: 1-128 caracteres (letras, números, . _ : -).");
    const tramos = parsearTramos(body.tramos);
    // La hora del evento la propone el worker pero se acota: un reloj roto no manda el costo a otro mes.
    const propuesta = typeof body.ocurridoEn === "string" ? Date.parse(body.ocurridoEn) : Number.NaN;
    const ahora = Date.now();
    const ocurridoEn = new Date(Number.isFinite(propuesta) && Math.abs(propuesta - ahora) <= 2 * 24 * 60 * 60 * 1000 ? propuesta : ahora).toISOString();
    const eventos = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: body.llamadaId, organizationId, propertyId, ocurridoEn, tramos });

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      // La sucursal debe ser de la organizacion declarada ANTES de escribir nada (404 uniforme, igual que el contexto); core.record_usage_cost_event
      // lo vuelve a exigir en la base como defensa en profundidad. El costo se registra por `llamadaId` (idempotencia), el id de la ruta solo se devuelve.
      if (!(await deps.restaurantesRepo(db).findBranchById(organizationId, propertyId))) throw Errors.notFound("La sucursal no existe para esa organización.");
      const resultado = await llamadaRepo(db).registrarCostoLlamada(eventos);
      if (!resultado.disponible) throw Errors.serviceUnavailable("El registro de costos todavía no está disponible en esta base (falta aplicar la migración 0028 de core).");
      return c.json({ conversationId, registrados: resultado.registrados, repetidos: resultado.repetidos });
    });
  });

  app.post(`${base}/conversaciones/:conversationId/modo-entrada`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const conversationId = uuid(c.req.param("conversationId"), "conversationId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    if (typeof body.modo !== "string" || !(MODOS_ENTRADA_VOZ as readonly string[]).includes(body.modo)) throw Errors.validation(`modo: debe ser uno de ${MODOS_ENTRADA_VOZ.join(", ")}.`);
    if (typeof body.franja !== "string" || !(FRANJAS_VOZ as readonly string[]).includes(body.franja)) throw Errors.validation(`franja: debe ser una de ${FRANJAS_VOZ.join(", ")}.`);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const marcada = await llamadaRepo(db).marcarModoEntrada({ organizationId, conversationId, modo: body.modo as ModoEntradaVoz, franja: body.franja as FranjaVoz });
      if (marcada === null) throw Errors.serviceUnavailable("El modo de entrada todavía no está disponible en esta base (falta aplicar la migración 067).");
      if (!marcada) throw Errors.notFound("La conversación no existe para esa organización.");
      return c.json({ marcada: true });
    });
  });

  app.post(`${base}/tope-mensual`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const propertyId = uuid(body.propertyId, "propertyId");
    if (body.nivel !== "80" && body.nivel !== "alcanzado") throw Errors.validation('nivel: debe ser "80" o "alcanzado".');
    const enteroMicroUsd = (valor: unknown, campo: string): number => {
      if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0 || valor > 1_000_000_000_000) throw Errors.validation(`${campo}: se esperaba un entero de micro-USD entre 0 y 1000000000000.`);
      return valor;
    };
    const usado = enteroMicroUsd(body.usadoMicroUsd, "usadoMicroUsd");
    const limite = enteroMicroUsd(body.limiteMicroUsd, "limiteMicroUsd");
    if (limite === 0) throw Errors.validation("limiteMicroUsd: el tope debe ser mayor que 0.");
    // Un nivel que los numeros no respaldan no emite nada (el aviso lo decide el servidor con las cifras, no el llamador): 80 % o mas.
    if (usado * 100 < limite * 80) throw Errors.validation("usadoMicroUsd: todavía no llega al 80 % del tope.");
    if (body.nivel === "alcanzado" && usado < limite) throw Errors.validation("usadoMicroUsd: todavía no alcanza el tope.");
    const periodo = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Merida", year: "numeric", month: "2-digit" }).format(new Date()).replace(/\D/g, "").slice(0, 6);
    const usd = (micro: number): number => Math.round((micro / 1_000_000) * 100) / 100;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const sucursal = await deps.restaurantesRepo(db).findBranchById(organizationId, propertyId);
      if (!sucursal) throw Errors.notFound("La sucursal no existe para esa organización.");
      // Ids del catalogo, literales (la prueba del catalogo verifica que este archivo los emite).
      const evento = body.nivel === "alcanzado" ? "restaurantes.voz.tope_mensual_alcanzado" : "restaurantes.voz.tope_mensual_80";
      const resultado = await emitirNotificacion(db, { evento, organizationId, clave: `${organizationId}:${periodo}`, parametros: { usado: usd(usado), limite: usd(limite) }, entidadTipo: "voz_tope_mensual" });
      return c.json({ emitida: resultado.estado === "emitida", estado: resultado.estado });
    });
  });

  // ---- panel ----
  const kpiPath = "/v1/restaurantes/:propertyId/admin/voz/kpi-desborde";
  app.use(kpiPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function restarDias(fecha: string, dias: number): string {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  }

  app.get(kpiPath, async (c: Context<CoreAuthHonoEnv>) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    if (!deps.vozLlamadaRepo) throw Errors.serviceUnavailable("El KPI de desborde no está disponible en este despliegue.");
    const crudo = c.req.query("dias");
    const dias = crudo === undefined ? SERIE_DIAS_POR_DEFECTO : Number(crudo);
    if (!Number.isInteger(dias) || dias < 1 || dias > 62) throw Errors.validation("dias: se esperaba un entero entre 1 y 62.");
    const { fecha: hoy, zonaHoraria } = diaLocalSucursal(new Date(), (await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId)).zonaHoraria);
    const desde = restarDias(hoy, dias - 1);
    const lectura = await deps.vozLlamadaRepo(c.get("db")).getModoEntradaKpi(organizationId, propertyId, desde, hoy);
    const serie = lectura.valor.map(serializarDia);
    const conLatencia = [...serie].reverse().find((d) => d.latenciaP95Ms !== null) ?? null;
    return c.json({
      disponible: lectura.disponible,
      zonaHoraria,
      desde,
      hasta: hoy,
      objetivoLatenciaP95Ms: LATENCIA_VOZ_OBJETIVO_P95_MS,
      totales: {
        llamadasDesborde: serie.reduce((s, d) => s + d.llamadasDesborde, 0),
        pedidosDesborde: serie.reduce((s, d) => s + d.pedidosDesborde, 0),
        ventasRecuperadas: Math.round(serie.reduce((s, d) => s + d.ventasRecuperadas, 0) * 100) / 100,
      },
      /** Último día con muestras de latencia (los percentiles no se suman entre días). */
      ultimaLatencia: conLatencia ? { fecha: conLatencia.fecha, p50Ms: conLatencia.latenciaP50Ms, p95Ms: conLatencia.latenciaP95Ms, llamadas: conLatencia.llamadasConLatencia } : null,
      serie,
    });
  });

  return app;
}
