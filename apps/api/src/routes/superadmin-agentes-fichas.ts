// Fichas de agente (SA-L-09) y Model Ops (SA-L-10) de la consola de superadmin, de SOLO LECTURA:
//   GET /superadmin/agentes/:ficha   -- ficha de un agente: extractor | conciliacion | whatsapp.
//   GET /superadmin/model-ops        -- una ficha por rol del gateway: modelo y proveedores configurados, carril real,
//                                       llamadas y costo de 30 dias, tasa de fallback y estado del circuit breaker.
// Fuentes: packages/db/migrations/0049_superadmin_fichas_agente.sql (+ 0042 para llamadas por rol y conversaciones de
// WhatsApp). Va detras de la cadena de routes/superadmin.ts (autenticacion, gateo de superadmin, guard de impersonacion,
// zona CFO y step-up). Se monta DESPUES de superadmin-agentes.ts: `/superadmin/agentes/corridas` sigue siendo de ese archivo
// y `:ficha` solo acepta los tres nombres de FICHAS (cualquier otro -> 404).
//
// REGLA DE LA CASA: nunca inventar una cifra. Cada campo es `{ valor, codigo?, razon? }`: si su fuente falla o no existe,
// `valor` es null con su razon y los demas campos siguen. Base sin migrar: 200 con `disponible: false`.
// Nunca se devuelven secretos: de la ruta del gateway solo salen el id del modelo, el esfuerzo de razonamiento y los slugs
// de proveedor (la politica de privacidad es de lectura publica en el repo).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { FichaActividadDiariaRow, FichaConciliadosRow, FichaDocumentosExtraidosRow, FichaModeloRolRow, FichaVozVerticalRow, FuenteConsola } from "@atiende/db";
import { Errors } from "../errors.ts";
import { ALL_PRODUCTION_ROLES, DATA_CHAT_RETRY_ROLES, DESPACHOS_CONCILIACION_LLM_ROLE, LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE, RENTAS_MENSAJERIA_AGENT_ROLE } from "../production/llm-gateway.ts";
import { NEW_PLATFORM_LLM_ROLES, resolveRoleRoute, resolveRungHosts } from "../production/llm-models.ts";
import type { LlmRouteConfig } from "../production/llm-models.ts";
import type { AppDeps } from "../deps.ts";
import { hoyMexico, sumarDias } from "./superadmin-consola.ts";

export const FICHAS = ["extractor", "conciliacion", "whatsapp"] as const;
export type FichaId = (typeof FICHAS)[number];

const NOMBRES: Readonly<Record<FichaId, string>> = {
  extractor: "Agente extractor",
  conciliacion: "Agente de conciliación",
  whatsapp: "Agente de WhatsApp y voz",
};

const RAZONES: Readonly<Record<string, string>> = {
  no_migrado: "No disponible aún: falta aplicar la migración 0049_superadmin_fichas_agente en este despliegue.",
  error: "No se pudo leer esta fuente; el resto de la ficha sigue disponible.",
  fuente_no_migrada: "No disponible aún: la migración de esta vertical no está aplicada en este despliegue.",
  sin_consola: "No disponible aún: falta aplicar la migración 0042_superadmin_consola_resumen en este despliegue.",
  sin_verdad_de_terreno: "Sin verdad de terreno todavía: no hay un conjunto de documentos etiquetados a mano contra el cual medir la precisión del extractor.",
  breaker_no_legible: "No legible: el circuit breaker vive en memoria de cada instancia (o en Upstash) y este endpoint no lo consulta.",
  sin_llamadas: "Sin llamadas en el periodo: no hay base para calcular la tasa.",
  sin_eventos_de_voz: "Sin eventos de voz registrados.",
};

export interface Campo<T> {
  readonly valor: T | null;
  readonly codigo?: string;
  readonly razon?: string;
}
const ok = <T>(valor: T): Campo<T> => ({ valor });
const nulo = <T>(codigo: string): Campo<T> => ({ valor: null, codigo, razon: RAZONES[codigo] ?? codigo });

const usd = (micro: number): number => Math.round(micro) / 1_000_000;
const pct = (parte: number, total: number): number | null => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

/** Roles (llm_usage_daily.role) que atiende cada ficha. */
export function esRolDeFicha(ficha: FichaId, role: string): boolean {
  switch (ficha) {
    case "extractor":
      return role === LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE;
    case "conciliacion":
      return role === DESPACHOS_CONCILIACION_LLM_ROLE;
    case "whatsapp":
      return /:whatsapp_agent(_escalated)?$/.test(role) || role === RENTAS_MENSAJERIA_AGENT_ROLE;
  }
}
const esEscalado = (role: string): boolean => role.endsWith(":whatsapp_agent_escalated");

/** Roles configurados en el gateway (mismo universo que usa routes/superadmin-llm-usage.ts). */
export function rolesDelGateway(): readonly string[] {
  return [...new Set([...ALL_PRODUCTION_ROLES, ...DATA_CHAT_RETRY_ROLES, ...NEW_PLATFORM_LLM_ROLES])].sort();
}

function rellenarSerie(filas: readonly FichaActividadDiariaRow[], desde: string, hasta: string): Array<{ dia: string; llamadas: number; costoUsd: number }> {
  const out: Array<{ dia: string; llamadas: number; costoUsd: number }> = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
    const delDia = filas.filter((f) => f.dia === d);
    out.push({ dia: d, llamadas: delDia.reduce((s, f) => s + f.llamadas, 0), costoUsd: usd(delDia.reduce((s, f) => s + f.costoMicroUsd, 0)) });
  }
  return out;
}

function campoDe<T, R>(f: FuenteConsola<T>, mapa: (data: T) => R): Campo<R> {
  return f.ok ? ok(mapa(f.data)) : nulo<R>(f.razon);
}

export function superadminAgentesFichasRoutes(deps: AppDeps, opciones: { readonly ahora?: () => Date } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = opciones.ahora ?? (() => new Date());
  const noMigrado = { ok: false, razon: "no_migrado" } as const;

  function rutaDe(role: string): LlmRouteConfig {
    return deps.rutaLlmDeRol?.(role) ?? resolveRoleRoute(role, undefined);
  }

  app.get("/superadmin/agentes/:ficha", async (c) => {
    const ficha = c.req.param("ficha");
    if (!(FICHAS as readonly string[]).includes(ficha)) throw Errors.notFound("Ficha de agente no encontrada.");
    const id = ficha as FichaId;
    const callerId = c.get("userId");
    const now = ahora();
    const hoy = hoyMexico(now);
    const desde7 = sumarDias(hoy, -6);
    const desde30 = sumarDias(hoy, -29);

    const f = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const repo = deps.fichasAgenteRepo?.(db);
      const consola = deps.consolaRepo?.(db);
      return {
        actividad: consola ? await consola.agentesActividad(callerId, hoy) : noMigrado,
        modelos: repo ? await repo.modelosPorRol(callerId, desde30, hoy) : noMigrado,
        serie: repo ? await repo.actividadDiaria(callerId, desde7, hoy) : noMigrado,
        documentos: id === "extractor" && repo ? await repo.documentosExtraidos(callerId) : noMigrado,
        conciliados: id === "conciliacion" && repo ? await repo.conciliados(callerId) : noMigrado,
        voz: id === "whatsapp" && repo ? await repo.vozPorVertical(callerId) : noMigrado,
        conversaciones: id === "whatsapp" && consola ? await consola.conversacionesWa(callerId) : noMigrado,
      };
    });

    const disponible = f.actividad.ok || f.modelos.ok || f.serie.ok;
    const roles = f.actividad.ok ? f.actividad.data.filter((a) => esRolDeFicha(id, a.role)) : [];
    const llamadasHist = roles.reduce((s, a) => s + a.llamadasHist, 0);
    const costoLlmHistMicro = roles.reduce((s, a) => s + a.costoHistMicroUsd, 0);
    const fallbacksHist = roles.reduce((s, a) => s + a.fallbackHist, 0);

    const llamadas = f.actividad.ok ? ok(llamadasHist) : nulo<number>(f.actividad.razon === "error" ? "error" : "sin_consola");
    const voz: FuenteConsola<readonly FichaVozVerticalRow[]> = f.voz;
    const vozMicro = voz.ok ? voz.data.reduce((s, v) => s + v.costoMicroUsd, 0) : null;

    // `gastado`: LLM historico (+ voz historica en la ficha de WhatsApp y voz). Si la voz no se pudo leer, el total NO se
    // inventa: queda null con la razon de la voz.
    let gastado: Campo<{ totalUsd: number; llmUsd: number; vozUsd: number | null }>;
    if (!f.actividad.ok) gastado = nulo(f.actividad.razon === "error" ? "error" : "sin_consola");
    else if (id === "whatsapp") {
      gastado = vozMicro === null ? nulo(voz.ok ? "error" : voz.razon) : ok({ totalUsd: usd(costoLlmHistMicro + vozMicro), llmUsd: usd(costoLlmHistMicro), vozUsd: usd(vozMicro) });
    } else gastado = ok({ totalUsd: usd(costoLlmHistMicro), llmUsd: usd(costoLlmHistMicro), vozUsd: null });

    const modelosDeFicha = f.modelos.ok ? f.modelos.data.filter((m) => esRolDeFicha(id, m.role)) : [];
    const costoPorModelo = campoDe(f.modelos, () => {
      const por = new Map<string, { providerId: string; model: string; llamadas: number; fallbacks: number; costoMicroUsd: number; tokensIn: number; tokensOut: number }>();
      for (const m of modelosDeFicha) {
        const k = `${m.providerId}\u0000${m.model}`;
        const x = por.get(k) ?? { providerId: m.providerId, model: m.model, llamadas: 0, fallbacks: 0, costoMicroUsd: 0, tokensIn: 0, tokensOut: 0 };
        x.llamadas += m.llamadas;
        x.fallbacks += m.fallbacks;
        x.costoMicroUsd += m.costoMicroUsd;
        x.tokensIn += m.tokensIn;
        x.tokensOut += m.tokensOut;
        por.set(k, x);
      }
      return [...por.values()]
        .sort((a, b) => b.costoMicroUsd - a.costoMicroUsd || a.model.localeCompare(b.model))
        .map((x) => ({ proveedor: x.providerId, modelo: x.model, llamadas: x.llamadas, fallbacks: x.fallbacks, costoUsd: usd(x.costoMicroUsd), tokensEntrada: x.tokensIn, tokensSalida: x.tokensOut }));
    });

    const serie7d = campoDe(f.serie, (filas) => rellenarSerie(filas.filter((s) => esRolDeFicha(id, s.role)), desde7, hoy));

    const base = {
      disponible,
      ...(disponible ? {} : { mensaje: RAZONES.no_migrado }),
      ficha: id,
      nombre: NOMBRES[id],
      nombreConfirmado: false,
      generadoEn: now.toISOString(),
      hoy,
      roles: [...new Set(roles.map((r) => r.role))].sort(),
      gastado,
      llamadas,
      fallbacks: f.actividad.ok ? ok({ total: fallbacksHist, tasaPct: pct(fallbacksHist, llamadasHist) }) : nulo<unknown>("sin_consola"),
      costoPorModelo,
      serie7d,
    };

    if (id === "extractor") {
      return c.json({
        ...base,
        documentosExtraidos: documentosExtraidos(f.documentos),
        precision: nulo<number>("sin_verdad_de_terreno"),
        notas: ["La precisión del extractor no está medida: no existe un conjunto de documentos con verdad de terreno."],
      });
    }
    if (id === "conciliacion") {
      return c.json({ ...base, movimientosConciliados: movimientosConciliados(f.conciliados) });
    }
    // whatsapp
    const escaladas = roles.filter((a) => esEscalado(a.role)).reduce((s, a) => s + a.llamadasHist, 0);
    const verticalesVoz = voz.ok ? voz.data : [];
    const verticales = new Set<string>([...roles.map((r) => r.vertical), ...verticalesVoz.map((v) => v.vertical), ...(f.conversaciones.ok ? f.conversaciones.data.map((v) => v.vertical) : [])]);
    const porVertical = [...verticales].sort().map((vertical) => {
      const delV = roles.filter((r) => r.vertical === vertical);
      const conv = f.conversaciones.ok ? f.conversaciones.data.find((v) => v.vertical === vertical) : undefined;
      const vz = verticalesVoz.find((v) => v.vertical === vertical);
      return {
        vertical,
        llamadas: delV.reduce((s, a) => s + a.llamadasHist, 0),
        costoLlmUsd: usd(delV.reduce((s, a) => s + a.costoHistMicroUsd, 0)),
        escaladas: delV.filter((a) => esEscalado(a.role)).reduce((s, a) => s + a.llamadasHist, 0),
        conversaciones: conv && conv.total !== null ? ok(conv.total) : f.conversaciones.ok ? nulo<number>(conv?.razon ?? "sin_whatsapp") : nulo<number>(f.conversaciones.razon === "error" ? "error" : "sin_consola"),
        minutosVoz: voz.ok ? ok(vz?.minutosVoz ?? 0) : nulo<number>(voz.razon),
        costoVozUsd: voz.ok ? ok(usd(vz?.costoMicroUsd ?? 0)) : nulo<number>(voz.razon),
      };
    });
    const convConDato = f.conversaciones.ok ? f.conversaciones.data.filter((v) => v.total !== null) : [];
    return c.json({
      ...base,
      conversaciones: f.conversaciones.ok
        ? convConDato.length > 0
          ? ok(convConDato.reduce((s, v) => s + (v.total as number), 0))
          : nulo<number>("fuente_no_migrada")
        : nulo<number>(f.conversaciones.razon === "error" ? "error" : "sin_consola"),
      minutosVoz: voz.ok ? ok(Math.round(voz.data.reduce((s, v) => s + v.minutosVoz, 0) * 100) / 100) : nulo<number>(voz.razon),
      escalamiento: f.actividad.ok ? ok({ escaladas, total: llamadasHist, tasaPct: pct(escaladas, llamadasHist) }) : nulo<unknown>("sin_consola"),
      porVertical: f.actividad.ok ? ok(porVertical) : nulo<unknown>("sin_consola"),
    });
  });

  app.get("/superadmin/model-ops", async (c) => {
    const callerId = c.get("userId");
    const now = ahora();
    const hoy = hoyMexico(now);
    const desde30 = sumarDias(hoy, -29);

    const modelos: FuenteConsola<readonly FichaModeloRolRow[]> = deps.fichasAgenteRepo
      ? await deps.engine.withAppSession({ userId: callerId }, (db) => deps.fichasAgenteRepo!(db).modelosPorRol(callerId, desde30, hoy))
      : noMigrado;
    const filas = modelos.ok ? modelos.data : [];

    // Universo: los roles configurados en el gateway + cualquier rol con consumo (se resuelve con la misma ruta vigente).
    const roles = [...new Set([...rolesDelGateway(), ...filas.map((m) => m.role)])].sort();
    const fichas = roles.map((role) => {
      const ruta = rutaDe(role);
      const escalera = ruta.models.map((m, i) => {
        const hosts = resolveRungHosts(m.model, ruta.routing?.only);
        return { orden: i + 1, modelo: m.model, razonamiento: m.reasoningEffort ?? null, proveedores: "hosts" in hosts ? [...hosts.hosts] : [] };
      });
      const delRol = filas.filter((m) => m.role === role);
      const llamadas = delRol.reduce((s, m) => s + m.llamadas, 0);
      const fallbacks = delRol.reduce((s, m) => s + m.fallbacks, 0);
      const costoMicro = delRol.reduce((s, m) => s + m.costoMicroUsd, 0);
      const carriles = [...new Set(delRol.map((m) => m.lane))].sort();
      return {
        role,
        vertical: role.includes(":") ? role.slice(0, role.indexOf(":")) : role,
        modelo: escalera[0]?.modelo ?? null,
        proveedores: escalera[0]?.proveedores ?? [],
        escalera,
        carril: modelos.ok ? ok(carriles.length > 0 ? carriles : null) : nulo<string[]>(modelos.razon),
        llamadas30d: modelos.ok ? ok(llamadas) : nulo<number>(modelos.razon),
        costo30dUsd: modelos.ok ? ok(usd(costoMicro)) : nulo<number>(modelos.razon),
        tasaFallbackPct: modelos.ok ? (llamadas > 0 ? ok(pct(fallbacks, llamadas)) : nulo<number>("sin_llamadas")) : nulo<number>(modelos.razon),
        circuitBreaker: nulo<string>("breaker_no_legible"),
      };
    });

    const porModeloMap = new Map<string, number>();
    for (const m of filas) porModeloMap.set(m.model, (porModeloMap.get(m.model) ?? 0) + m.costoMicroUsd);
    const porAgenteMap = new Map<string, number>();
    for (const m of filas) porAgenteMap.set(m.role, (porAgenteMap.get(m.role) ?? 0) + m.costoMicroUsd);
    const ordenar = (m: Map<string, number>, clave: "modelo" | "role") =>
      [...m.entries()]
        .filter(([, micro]) => micro > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, micro]) => ({ [clave]: k, costoUsd: usd(micro) }));

    return c.json({
      disponible: modelos.ok,
      ...(modelos.ok ? {} : { mensaje: RAZONES[modelos.razon] }),
      generadoEn: now.toISOString(),
      hoy,
      desde: desde30,
      fichas,
      porAgente: modelos.ok ? ok(ordenar(porAgenteMap, "role")) : nulo<unknown>(modelos.razon),
      porModelo: modelos.ok ? ok(ordenar(porModeloMap, "modelo")) : nulo<unknown>(modelos.razon),
      notas: ["Esta pantalla no versiona prompts ni cambia modelos: el modelo de cada rol se cambia con LLM_MODELS_JSON (ver docs/LLM-GATEWAY.md) y se despliega como configuración."],
    });
  });

  return app;
}

function documentosExtraidos(f: FuenteConsola<FichaDocumentosExtraidosRow>): Campo<{ documentos: number; requisitos: number; licitaciones: number }> {
  if (!f.ok) return nulo(f.razon);
  if (f.data.razon !== null || f.data.documentos === null || f.data.requisitos === null || f.data.licitaciones === null) return nulo(f.data.razon ?? "error");
  return ok({ documentos: f.data.documentos, requisitos: f.data.requisitos, licitaciones: f.data.licitaciones });
}

function movimientosConciliados(f: FuenteConsola<FichaConciliadosRow>): Campo<{ total: number; porMotor: number; porLlmAprobado: number; porManual: number; sugerenciasPendientes: number; sugerenciasTotal: number }> {
  if (!f.ok) return nulo(f.razon);
  const d = f.data;
  if (d.razon !== null || d.movimientosConciliados === null || d.porMotor === null || d.porLlmAprobado === null || d.porManual === null || d.sugerenciasPendientes === null || d.sugerenciasTotal === null) {
    return nulo(d.razon ?? "error");
  }
  return ok({ total: d.movimientosConciliados, porMotor: d.porMotor, porLlmAprobado: d.porLlmAprobado, porManual: d.porManual, sugerenciasPendientes: d.sugerenciasPendientes, sugerenciasTotal: d.sugerenciasTotal });
}
