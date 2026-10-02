// Consola de superadmin: GET /superadmin/consola/resumen (SA-L-05) y GET /superadmin/consola/agentes-actividad (SA-L-06).
// Ver packages/db/migrations/0042_superadmin_consola_resumen.sql y docs/SUPERADMIN_CONSOLA.md.
//
// Va detras de la cadena de routes/superadmin.ts (autenticacion, gateo de superadmin, guard de impersonacion, zona
// CFO y step-up): estas rutas son de solo lectura y no estan en RUTAS_FINANCIERAS, asi que el rol `finanzas` queda
// fuera (la zona CFO es lista blanca) y un superadmin completo las lee sin step-up.
//
// REGLA DE LA CASA: nunca inventar una cifra. Cada campo es `{ valor, codigo?, razon? }`: si su fuente falla o no
// existe, `valor` es null con su razon y los demas campos siguen. Base sin migrar: 200 con `disponible: false`.
//
// MRR: decision PENDIENTE de Javier. Se devuelve SOLO el total (sin desglose por cliente), sin step-up y con una fila
// 'resumen_mrr' en core.cfo_access_log por cada lectura. La politica vive en `POLITICA_MRR_RESUMEN`.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import { calcularIngresos } from "@atiende/billing";
import type {
  ConsolaAgenteActividadRow,
  ConsolaAlcanceRow,
  ConsolaConversacionesWaRow,
  ConsolaCostoDiarioRow,
  ConsolaCostoHistoricoRow,
  ConsolaOperacionRow,
  ConsolaOrganizacionRow,
  ConsolaResueltasSinHumanoRow,
  FuenteConsola,
} from "@atiende/db";
import { construirFilasCfo } from "../cfo/filas.ts";
import { AGENTES_CRON } from "../consola/agentes-cron.ts";
import { exigirStepUp } from "../superadmin-seguridad/step-up.ts";
import type { AppDeps } from "../deps.ts";

/** Politica del MRR en el Resumen. Unico lugar para cambiarla (decision pendiente de Javier). */
export interface PoliticaMrrResumen {
  /** true = el MRR del Resumen exige step-up como el dashboard CFO. */
  readonly requiereStepUp: boolean;
  /** `recurso` que queda en core.cfo_access_log en cada lectura del MRR. */
  readonly recursoBitacora: string;
}
export const POLITICA_MRR_RESUMEN: PoliticaMrrResumen = { requiereStepUp: false, recursoBitacora: "resumen_mrr" };

export const VERTICALES = ["restaurantes", "hoteles", "rentas", "citas", "despachos", "licitaciones"] as const;
const TZ = "America/Mexico_City";
const DIAS_SERIE = 14;

const RAZONES: Readonly<Record<string, string>> = {
  no_migrado: "No disponible aún: falta aplicar la migración 0042_superadmin_consola_resumen en este despliegue.",
  error: "No se pudo leer esta fuente; el resto del resumen sigue disponible.",
  fuente_no_migrada: "No disponible aún: la migración de esta vertical no está aplicada en este despliegue.",
  sin_fuente: "Sin fuente: despachos no guarda un registro de CFDI conciliados (la conciliación bancaria no se persiste).",
  sin_whatsapp: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp.",
  sin_operaciones_con_fuente: "Sin fuente: ninguna vertical tiene un registro de operaciones disponible.",
  sin_bitacora: "No se pudo registrar la lectura del MRR en la bitácora; por seguridad no se ejecuta.",
  requiere_step_up: "El MRR exige verificación MFA reciente (step-up) en esta configuración.",
  mrr_sin_repositorio: "No disponible aún: falta aplicar la migración 0030_superadmin_cfo_dashboard en este despliegue.",
  sin_base: "Sin base de comparación: los 7 días previos no tienen consumo.",
};

export interface Campo<T> {
  readonly valor: T | null;
  readonly codigo?: string;
  readonly razon?: string;
}
const ok = <T>(valor: T): Campo<T> => ({ valor });
const nulo = <T>(codigo: string): Campo<T> => ({ valor: null, codigo, razon: RAZONES[codigo] ?? codigo });

// ── Fechas en hora de Mexico ──
export function hoyMexico(ahora: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}
/** Instante ISO de la medianoche de Mexico de `fecha` (offset real de esa fecha, sin suponerlo). */
export function medianocheMexicoIso(fecha: string): string {
  const mediodia = new Date(`${fecha}T12:00:00Z`);
  const parte = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(mediodia).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parte);
  const offset = m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : "+00:00";
  return new Date(`${fecha}T00:00:00${offset}`).toISOString();
}

const usd = (micro: number): number => Math.round(micro) / 1_000_000;

function razonDe<T>(f: FuenteConsola<T>): string {
  return f.ok ? "error" : f.razon;
}

export function superadminConsolaRoutes(deps: AppDeps, opciones: { readonly politicaMrr?: PoliticaMrrResumen; readonly ahora?: () => Date } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const politica = opciones.politicaMrr ?? POLITICA_MRR_RESUMEN;
  const ahora = opciones.ahora ?? (() => new Date());

  async function leerMrr(c: Parameters<typeof exigirStepUp>[1], callerId: string): Promise<Campo<{ totalMxn: number; organizacionesConPrecio: number; organizacionesSinPrecio: number }>> {
    if (!deps.cfoRepo) return nulo("mrr_sin_repositorio");
    if (politica.requiereStepUp) {
      try {
        await exigirStepUp(deps, c, { obligatorio: false });
      } catch (err) {
        if (err instanceof ApiError) return nulo("requiere_step_up");
        throw err;
      }
    }
    // Bitacora ANTES de leer, en una transaccion propia ya confirmada: sin huella no hay lectura del MRR.
    if (deps.cfoZoneRepo) {
      const zona = deps.cfoZoneRepo;
      try {
        await deps.engine.withAppSession({ userId: callerId }, (db) => zona(db).logAccess(callerId, "consulta", politica.recursoBitacora, { _ruta: c.req.path.slice(0, 160) }));
      } catch {
        return nulo("sin_bitacora");
      }
    }
    const cfo = deps.cfoRepo;
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => cfo(db).getDashboardRows(callerId, null));
    if (r.availability === "not_migrated") return nulo("mrr_sin_repositorio");
    const ing = calcularIngresos(construirFilasCfo(r.rows, { umbralMargenPct: 0, mxnPorUsd: null }));
    return ok({ totalMxn: ing.mrrMxn, organizacionesConPrecio: ing.clientesConIngreso, organizacionesSinPrecio: ing.clientesSinPrecio });
  }

  app.get("/superadmin/consola/resumen", async (c) => {
    const callerId = c.get("userId");
    const now = ahora();
    const hoy = hoyMexico(now);
    const desde = sumarDias(hoy, -(DIAS_SERIE - 1));

    const fuentes = deps.consolaRepo
      ? await deps.engine.withAppSession({ userId: callerId }, async (db) => {
          const repo = deps.consolaRepo!(db);
          return {
            organizaciones: await repo.organizaciones(callerId),
            costoDiario: await repo.costoDiario(callerId, desde, hoy),
            costoHistorico: await repo.costoHistorico(callerId),
            operaciones: await repo.operaciones(callerId, desde, hoy),
            alcance: await repo.alcance(callerId),
            conversacionesWa: await repo.conversacionesWa(callerId),
            resueltas: await repo.resueltasSinHumano(callerId, medianocheMexicoIso(hoy), medianocheMexicoIso(sumarDias(hoy, 1))),
          };
        })
      : null;
    const noMigrado = { ok: false, razon: "no_migrado" } as const;
    const f = fuentes ?? {
      organizaciones: noMigrado,
      costoDiario: noMigrado,
      costoHistorico: noMigrado,
      operaciones: noMigrado,
      alcance: noMigrado,
      conversacionesWa: noMigrado,
      resueltas: noMigrado,
    };

    const mrr = await leerMrr(c, callerId);
    const disponible = Object.values(f).some((x) => x.ok) || mrr.valor !== null;

    return c.json({
      disponible,
      ...(disponible ? {} : { mensaje: RAZONES.no_migrado }),
      generadoEn: now.toISOString(),
      hoy,
      organizaciones: organizaciones(f.organizaciones),
      gastoIa: gastoIa(f.costoHistorico, f.costoDiario, hoy),
      tokens: tokens(f.costoHistorico),
      operaciones: operaciones(f.operaciones, desde, hoy),
      vozMinutos: vozMinutos(f.costoHistorico),
      sucursales: f.alcance.ok ? ok(f.alcance.data.sucursalesActivas) : nulo<number>(f.alcance.razon),
      usuarios: usuarios(f.alcance),
      conversacionesWa: conversacionesWa(f.conversacionesWa),
      resueltasSinHumano: resueltas(f.resueltas, hoy),
      mrr,
      politicaMrr: { requiereStepUp: politica.requiereStepUp, recursoBitacora: politica.recursoBitacora, desglosePorCliente: false },
    });
  });

  app.get("/superadmin/consola/agentes-actividad", async (c) => {
    const callerId = c.get("userId");
    const now = ahora();
    const hoy = hoyMexico(now);

    const actividad: FuenteConsola<readonly ConsolaAgenteActividadRow[]> = deps.consolaRepo
      ? await deps.engine.withAppSession({ userId: callerId }, (db) => deps.consolaRepo!(db).agentesActividad(callerId, hoy))
      : { ok: false, razon: "no_migrado" };

    let latidos: Awaited<ReturnType<AppDeps["saludRepo"]["listCronHeartbeatsForSuperadmin"]>> | null = null;
    try {
      latidos = await deps.saludRepo.listCronHeartbeatsForSuperadmin(callerId);
    } catch {
      latidos = null;
    }

    return c.json({
      disponible: actividad.ok || latidos !== null,
      hoy,
      agentes: actividad.ok
        ? ok(
            actividad.data.map((a) => ({
              vertical: a.vertical,
              role: a.role,
              historico: { llamadas: a.llamadasHist, costoUsd: usd(a.costoHistMicroUsd), fallbacks: a.fallbackHist },
              ultimos30Dias: { llamadas: a.llamadas30d, costoUsd: usd(a.costo30dMicroUsd), fallbacks: a.fallback30d },
            })),
          )
        : nulo(actividad.razon),
      ultimaCorrida:
        latidos === null
          ? nulo("error")
          : ok(
              latidos
                .map((h) => {
                  const mapa = AGENTES_CRON[h.cronName];
                  return {
                    cron: h.cronName,
                    vertical: mapa?.vertical ?? "plataforma",
                    nombre: mapa?.nombre ?? h.cronName,
                    estado: h.lastStatus,
                    terminoEn: h.lastFinishedAt,
                    duracionMs: h.lastDurationMs,
                    fallosConsecutivos: h.consecutiveFailures,
                    tareas: "no medido" as const,
                  };
                })
                .sort((a, b) => a.vertical.localeCompare(b.vertical) || a.nombre.localeCompare(b.nombre)),
            ),
      notas: ["«tareas x/y» no se mide: el latido de cron no registra tareas; la bitácora de corridas real es SA-L-07."],
    });
  });

  return app;
}

// ── Campos del resumen (funciones puras sobre las fuentes) ──

function organizaciones(f: FuenteConsola<readonly ConsolaOrganizacionRow[]>) {
  if (!f.ok) return nulo<unknown>(f.razon);
  const por = VERTICALES.map((v) => {
    const r = f.data.find((x) => x.vertical === v);
    return { vertical: v, total: r?.total ?? 0, demo: r?.demo ?? 0 };
  });
  return ok({ total: por.reduce((s, x) => s + x.total, 0), demo: por.reduce((s, x) => s + x.demo, 0), porVertical: por });
}

function gastoIa(hist: FuenteConsola<readonly ConsolaCostoHistoricoRow[]>, diario: FuenteConsola<readonly ConsolaCostoDiarioRow[]>, hoy: string) {
  if (!hist.ok) return nulo<unknown>(hist.razon);
  const llm = hist.data.find((r) => r.fuente === "llm")?.costoMicroUsd ?? 0;
  const categorias = hist.data.filter((r) => r.fuente !== "llm").map((r) => ({ categoria: r.fuente, usd: usd(r.costoMicroUsd) }));
  const eventos = hist.data.filter((r) => r.fuente !== "llm").reduce((s, r) => s + r.costoMicroUsd, 0);
  return ok({
    totalUsd: usd(llm + eventos),
    llmUsd: usd(llm),
    otrosUsd: usd(eventos),
    porCategoria: categorias,
    serie14d: diario.ok ? ok(diario.data.map((d) => ({ dia: d.dia, usd: usd(d.llmMicroUsd + d.eventosMicroUsd) }))) : nulo<unknown>(diario.razon),
    delta7d: diario.ok ? delta7d(diario.data, hoy) : nulo<unknown>(diario.razon),
  });
}

/** 7 dias que terminan hoy contra los 7 anteriores. `hoy` es el dia de Mexico (no el de UTC). */
export function delta7d(filas: readonly ConsolaCostoDiarioRow[], hoy: string): Campo<{ actualUsd: number; previoUsd: number; deltaUsd: number; pct: number | null }> {
  const inicioActual = sumarDias(hoy, -6);
  const inicioPrevio = sumarDias(hoy, -13);
  let actual = 0;
  let previo = 0;
  for (const r of filas) {
    const micro = r.llmMicroUsd + r.eventosMicroUsd;
    if (r.dia >= inicioActual && r.dia <= hoy) actual += micro;
    else if (r.dia >= inicioPrevio && r.dia < inicioActual) previo += micro;
  }
  const base = { actualUsd: usd(actual), previoUsd: usd(previo), deltaUsd: usd(actual - previo) };
  return ok({ ...base, pct: previo > 0 ? Math.round(((actual - previo) / previo) * 10_000) / 100 : null });
}

function tokens(f: FuenteConsola<readonly ConsolaCostoHistoricoRow[]>) {
  if (!f.ok) return nulo<unknown>(f.razon);
  const llm = f.data.find((r) => r.fuente === "llm");
  const entrada = llm?.tokensIn ?? 0;
  const salida = llm?.tokensOut ?? 0;
  return ok({ total: entrada + salida, entrada, salida });
}

function vozMinutos(f: FuenteConsola<readonly ConsolaCostoHistoricoRow[]>) {
  if (!f.ok) return nulo<number>(f.razon);
  return ok(f.data.find((r) => r.fuente === "voz")?.minutosVoz ?? 0);
}

function operaciones(f: FuenteConsola<readonly ConsolaOperacionRow[]>, desde: string, hoy: string) {
  if (!f.ok) return nulo<unknown>(f.razon);
  const dias: string[] = [];
  for (let d = desde; d <= hoy; d = sumarDias(d, 1)) dias.push(d);
  const porVertical = VERTICALES.map((v) => {
    const filas = f.data.filter((r) => r.vertical === v);
    const total = filas.find((r) => r.dia === null);
    if (!total || total.cantidad === null) {
      const codigo = total?.razon ?? "fuente_no_migrada";
      return { vertical: v, total: null, codigo, razon: RAZONES[codigo] ?? codigo, serie14d: null };
    }
    return { vertical: v, total: total.cantidad, serie14d: dias.map((dia) => ({ dia, cantidad: filas.find((r) => r.dia === dia)?.cantidad ?? 0 })) };
  });
  const conFuente = porVertical.filter((v) => v.total !== null);
  if (conFuente.length === 0) return { valor: null, codigo: "sin_operaciones_con_fuente", razon: RAZONES.sin_operaciones_con_fuente, porVertical };
  return ok({
    total: conFuente.reduce((s, v) => s + (v.total as number), 0),
    porVertical,
    serie14d: dias.map((dia, i) => ({ dia, cantidad: conFuente.reduce((s, v) => s + (v.serie14d?.[i]?.cantidad ?? 0), 0) })),
    verticalesSinFuente: porVertical.filter((v) => v.total === null).map((v) => v.vertical),
  });
}

function usuarios(f: FuenteConsola<ConsolaAlcanceRow>) {
  if (!f.ok) return nulo<unknown>(f.razon);
  return ok({ total: f.data.usuariosConAcceso, staff: f.data.staffConMembresia, superadmins: f.data.superadmins });
}

function conversacionesWa(f: FuenteConsola<readonly ConsolaConversacionesWaRow[]>) {
  if (!f.ok) return nulo<unknown>(f.razon);
  const porVertical = VERTICALES.map((v) => {
    const r = f.data.find((x) => x.vertical === v);
    if (!r || r.total === null) {
      const codigo = r?.razon ?? "fuente_no_migrada";
      return { vertical: v, total: null, codigo, razon: RAZONES[codigo] ?? codigo };
    }
    return { vertical: v, total: r.total };
  });
  const con = porVertical.filter((v) => v.total !== null);
  if (con.length === 0) return nulo<unknown>("fuente_no_migrada");
  return ok({ total: con.reduce((s, v) => s + (v.total as number), 0), porVertical });
}

function resueltas(f: FuenteConsola<ConsolaResueltasSinHumanoRow>, hoy: string) {
  if (!f.ok) return nulo<unknown>(f.razon);
  if (f.data.razon !== null || f.data.total === null || f.data.resueltasSinHumano === null) return nulo<unknown>(f.data.razon ?? "error");
  const { total, resueltasSinHumano } = f.data;
  return ok({
    dia: hoy,
    resueltas: resueltasSinHumano,
    total,
    porcentaje: total > 0 ? Math.round((resueltasSinHumano / total) * 1000) / 10 : null,
    nota: "medido solo en restaurantes",
  });
}
