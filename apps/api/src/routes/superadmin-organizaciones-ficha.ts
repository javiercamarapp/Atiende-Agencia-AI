// Tabla de Organizaciones con metricas (SA-L-20), Ficha 360 (SA-07) y onboarding medido (SA-18) del back office.
//   GET /superadmin/organizaciones/resumen        -- una fila por organizacion: operaciones y costo de IA a 30 dias, plan y onboarding 'x/y'.
//                                                    Base sin la 0050: `disponible: false` y las columnas nuevas en null con su razon.
//   GET /superadmin/organizaciones/margen         -- margen del mes por organizacion. Es una ruta de la ZONA CFO (RUTAS_FINANCIERAS: step-up si hay
//                                                    MFA activo y bitacora de cada consulta en core.cfo_access_log); por eso va aparte y la pantalla la pide
//                                                    por separado: el rechazo de step-up solo deja en blanco la columna Margen.
//   GET /superadmin/organizaciones/:id/ficha      -- ficha 360 de una organizacion; inexistente -> 404 honesto.
//
// SOLO LECTURA: ninguna de las dos rutas escribe (el aviso 'organizacion lista' lo emite el cron de mantenimiento, nunca un GET).
// La autorizacion (superadmin real, auth.uid() = p_caller_id) vive en las funciones SQL de 0050; el gateo de `/superadmin/*`
// (owner, rate-limit, bitacora de denegaciones, step-up) ya corrio antes (routes/superadmin.ts).
//
// Compatibilidad con la base sin migrar: la lista de organizaciones, el staff y el plan salen de funciones que ya existen en
// produccion; metricas, onboarding y ficha salen de la 0050 y cada una falla POR SEPARADO (SAVEPOINT en el repositorio). Un campo
// no medible es `{ valor: null, razon }`, nunca 0.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { OrgFicha, OrgMetricaRow, OrgOnboardingPaso, OrgOnboardingResumenRow } from "@atiende/db";
import { UMBRAL_MARGEN_PCT_DEFAULT } from "@atiende/billing";
import { Errors } from "../errors.ts";
import { construirFilasCostoMargen, elegirTipoCambio } from "./superadmin-costos.ts";
import { hoyMexico } from "./superadmin-consola.ts";
import type { AppDeps } from "../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const RAZONES: Readonly<Record<string, string>> = {
  no_migrado: "No disponible aún: falta aplicar la migración 0050_superadmin_organizaciones_ficha_onboarding en este despliegue.",
  error: "No se pudo leer esta fuente; el resto de la pantalla sigue disponible.",
  fuente_no_migrada: "No disponible aún: la migración de esta vertical no está aplicada en este despliegue.",
  sin_fuente: "Sin fuente: despachos no guarda un registro de operaciones (la conciliación bancaria no se persiste).",
  sin_fuente_por_organizacion: "Sin fuente por organización: los crons se miden para toda la plataforma (ver Salud operativa).",
  sin_whatsapp: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp.",
  costos_no_migrado: "No disponible aún: falta aplicar la migración 0028_superadmin_costos_planes en este despliegue.",
  sin_plan: "Sin plan asignado: no hay ingreso esperado contra el cual calcular el margen.",
  precio_no_configurado: "El plan no tiene precio configurado: el margen no se calcula.",
  sin_tipo_cambio: "No hay tipo de cambio configurado: el margen no se calcula.",
  sin_eventos: "Sin eventos de costo en los últimos 30 días.",
};

export interface CampoOrg<T> {
  readonly valor: T | null;
  readonly razon: string | null;
}
const ok = <T>(valor: T): CampoOrg<T> => ({ valor, razon: null });
const nulo = <T>(codigo: string): CampoOrg<T> => ({ valor: null, razon: RAZONES[codigo] ?? codigo });
const campoDeRazon = <T>(valor: T | null, codigo: string | null): CampoOrg<T> => (valor !== null ? ok(valor) : nulo(codigo ?? "error"));

export interface MargenOrg {
  readonly mxn: number;
  readonly pct: number;
  readonly ingresoMxn: number;
}

const usd = (micro: number): number => Math.round(micro) / 1_000_000;

function campoMargen(fila: ReturnType<typeof construirFilasCostoMargen>[number], hayTipoCambio: boolean): CampoOrg<MargenOrg> {
  if (fila.margenMxn !== null && fila.margenPct !== null && fila.ingresoMxn !== null) return ok({ mxn: fila.margenMxn, pct: fila.margenPct, ingresoMxn: fila.ingresoMxn });
  if (fila.ingresoRazon !== null) return nulo(fila.ingresoRazon);
  return nulo(hayTipoCambio ? "error" : "sin_tipo_cambio");
}

export function superadminOrganizacionesFichaRoutes(deps: AppDeps, opciones: { readonly ahora?: () => Date } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = opciones.ahora ?? (() => new Date());

  app.get("/superadmin/organizaciones/resumen", async (c) => {
    const callerId = c.get("userId");
    const hoy = hoyMexico(ahora());

    const organizaciones = await deps.coreRepo.listAllOrganizationsForSuperadmin(callerId);
    const staff = await deps.coreRepo.countStaffByOrganizationForSuperadmin(callerId);

    // Metricas y onboarding (0050): UNA sesion, cada fuente con su SAVEPOINT (el repositorio).
    const repo = deps.orgFichaRepo;
    let metricas: ReadonlyMap<string, OrgMetricaRow> | null = null;
    let onboarding: ReadonlyMap<string, OrgOnboardingResumenRow> | null = null;
    let razonMetricas: "no_migrado" | "error" = "no_migrado";
    let razonOnboarding: "no_migrado" | "error" = "no_migrado";
    if (repo) {
      const { m, o } = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const r = repo(db);
        const m = await r.metricas(callerId, hoy);
        const o = await r.onboardingResumen(callerId);
        return { m, o };
      });
      if (m.ok) metricas = new Map(m.data.map((x) => [x.organizationId, x] as const));
      else razonMetricas = m.razon;
      if (o.ok) onboarding = new Map(o.data.map((x) => [x.organizationId, x] as const));
      else razonOnboarding = o.razon;
    }

    const filas = organizaciones.map((o) => {
      const met = metricas?.get(o.id) ?? null;
      const onb = onboarding?.get(o.id) ?? null;
      return {
        id: o.id,
        nombre: o.name,
        slug: o.slug,
        vertical: o.vertical,
        estado: o.status,
        creadaEn: o.createdAt,
        staff: staff.get(o.id) ?? 0,
        plan:
          metricas === null
            ? nulo<{ id: string; nombre: string }>(razonMetricas)
            : met === null
              ? nulo<{ id: string; nombre: string }>("error")
              : met.planId !== null
                ? ok({ id: met.planId, nombre: met.planNombre ?? met.planId })
                : nulo<{ id: string; nombre: string }>(met.planRazon ?? "sin_plan"),
        operaciones30d: metricas === null ? nulo<number>(razonMetricas) : met ? campoDeRazon(met.operaciones30d, met.operacionesRazon) : nulo<number>("error"),
        costoIa30dUsd: metricas === null ? nulo<number>(razonMetricas) : met && met.llm30dMicroUsd !== null ? ok(usd(met.llm30dMicroUsd)) : nulo<number>(met ? "fuente_no_migrada" : "error"),
        onboarding:
          onboarding === null
            ? nulo<{ hechos: number; total: number; noMedibles: number }>(razonOnboarding)
            : onb
              ? ok({ hechos: onb.hechos, total: onb.total, noMedibles: onb.noMedibles })
              : nulo<{ hechos: number; total: number; noMedibles: number }>("error"),
      };
    });

    return c.json({
      disponible: metricas !== null || onboarding !== null,
      mensaje: metricas === null && onboarding === null ? RAZONES[razonMetricas] : null,
      ventanaDias: 30,
      organizaciones: filas,
    });
  });

  // Margen del mes (0028 + packages/billing). Ruta de la zona CFO: el middleware ya exigio step-up (si hay MFA) y registro la consulta.
  app.get("/superadmin/organizaciones/margen", async (c) => {
    const callerId = c.get("userId");
    const hoy = hoyMexico(ahora());
    const mes = hoy.slice(0, 7);
    const sinDatos = (codigo: string) => c.json({ disponible: false, mes, mensaje: RAZONES[codigo] ?? codigo, margenes: {} as Record<string, CampoOrg<MargenOrg>> });
    const repo = deps.costosPlanesRepo;
    if (!repo) return sinDatos("costos_no_migrado");

    const leido = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = repo(db);
      const report = await r.getReport(callerId, `${mes}-01`);
      const rates = await r.listFxRates(callerId, 120);
      const plans = await r.listPlans(callerId);
      return { report, rates: rates.rates, plans: plans.plans };
    });
    if (leido.report.availability === "not_migrated") return sinDatos("costos_no_migrado");

    const fx = elegirTipoCambio(leido.rates, mes, hoy);
    const filas = construirFilasCostoMargen(leido.report.rows, leido.plans, fx, UMBRAL_MARGEN_PCT_DEFAULT);
    const margenes: Record<string, CampoOrg<MargenOrg>> = {};
    for (const f of filas) margenes[f.organizationId] = campoMargen(f, fx !== null);
    return c.json({ disponible: true, mes, mensaje: null, margenes });
  });

  app.get("/superadmin/organizaciones/:id/ficha", async (c) => {
    const callerId = c.get("userId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.notFound("Organización no encontrada.");
    const hoy = hoyMexico(ahora());

    const repo = deps.orgFichaRepo;
    let ficha: OrgFicha | null = null;
    let razon: "no_migrado" | "error" | null = repo ? null : "no_migrado";
    if (repo) {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).ficha(callerId, id, hoy));
      if (r.ok) ficha = r.data;
      else razon = r.razon;
    }

    if (razon === null) {
      if (ficha === null) throw Errors.notFound("Organización no encontrada.");
      return c.json(armarFicha(ficha, hoy));
    }

    // Base sin la 0050 (o la fuente fallo): la organizacion se busca igual en la lista que ya existe en produccion para no
    // confundir "no existe" con "no disponible aun".
    const todas = await deps.coreRepo.listAllOrganizationsForSuperadmin(callerId);
    const org = todas.find((o) => o.id === id);
    if (!org) throw Errors.notFound("Organización no encontrada.");
    return c.json({
      disponible: false,
      mensaje: RAZONES[razon],
      organizacion: { id: org.id, nombre: org.name, slug: org.slug, vertical: org.vertical, estado: org.status, creadaEn: org.createdAt },
    });
  });

  return app;
}

function armarFicha(ficha: OrgFicha, hoy: string) {
  const { eventos30dMicroUsd, eventos30dTotal } = ficha.costo;
  const razonCosto = ficha.costo.razon ?? "error";
  const costoPorEvento =
    eventos30dMicroUsd === null || eventos30dTotal === null ? nulo<number>(razonCosto) : eventos30dTotal === 0 ? nulo<number>("sin_eventos") : ok(usd(eventos30dMicroUsd / eventos30dTotal));
  return {
    disponible: true,
    mensaje: null,
    mes: hoy.slice(0, 7),
    ventanaDias: 30,
    organizacion: ficha.organizacion,
    uso: {
      operaciones30d: campoDeRazon(ficha.uso.operaciones30d.valor, ficha.uso.operaciones30d.razon),
      conversaciones30d: campoDeRazon(ficha.uso.conversaciones30d.valor, ficha.uso.conversaciones30d.razon),
      minutosVoz30d: campoDeRazon(ficha.uso.minutosVoz30d.valor, ficha.uso.minutosVoz30d.razon),
    },
    costo: {
      llm30dUsd: ficha.costo.llm30dMicroUsd === null ? nulo<number>(razonCosto) : ok(usd(ficha.costo.llm30dMicroUsd)),
      eventos30dUsd: eventos30dMicroUsd === null ? nulo<number>(razonCosto) : ok(usd(eventos30dMicroUsd)),
      costoPorEventoUsd: costoPorEvento,
    },
    membresias: {
      porRol: ficha.membresias.porRol,
      ultimosAccesos: ficha.membresias.ultimosAccesos === null ? nulo<NonNullable<OrgFicha["membresias"]["ultimosAccesos"]>>(ficha.membresias.ultimosAccesosRazon ?? "error") : ok(ficha.membresias.ultimosAccesos),
    },
    errores: {
      outboxMuerto: campoDeRazon(ficha.errores.outboxMuerto.valor, ficha.errores.outboxMuerto.razon),
      denegaciones30d: { ...campoDeRazon(ficha.errores.denegaciones30d.valor, ficha.errores.denegaciones30d.razon), ultimas: ficha.errores.denegaciones30d.ultimas ?? [] },
      crons: nulo<number>(ficha.errores.crons.razon ?? "sin_fuente_por_organizacion"),
    },
    facturacion: ficha.facturacion,
    onboarding: ficha.onboarding.map((p: OrgOnboardingPaso) => ({ ...p, razonTexto: p.razon === null ? null : (RAZONES[p.razon] ?? p.razon) })),
  };
}
