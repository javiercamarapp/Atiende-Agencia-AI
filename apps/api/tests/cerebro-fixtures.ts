// Doble de prueba del Cerebro de ventas: filas con la forma de las funciones SQL de la migracion 0051 y una app Hono minima con
// una sesion AbortAwareFakeSession (reproduce el estado abortado de Postgres: una sesion falsa plana NO sirve para el fallback).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import type { ProspectoRow } from "@atiende/db";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { superadminCerebroRoutes } from "../src/routes/superadmin-cerebro.ts";
import type { AppDeps } from "../src/deps.ts";

export const CALLER = "00000000-0000-4000-8000-0000000000aa";
export const PROSPECTO_ID = "00000000-0000-4000-8000-0000000000b1";
export const AHORA_FIJA = new Date("2026-10-03T12:00:00.000Z");

export function pgError(code: string, message = "error de postgres"): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** Fila de core.prospecto (snake_case) con valores por omision y los del caso. */
export function filaProspecto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROSPECTO_ID,
    empresa: "Taquería Ficticia",
    vertical: "restaurantes",
    ciudad: "Mérida",
    contacto_nombre: null,
    telefono: null,
    correo: null,
    estado: "nuevo",
    fuente: null,
    notas: null,
    creado_por: CALLER,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    necesita_seguimiento_desde: null,
    subtipo: "taqueria",
    tamano: "s1",
    entidad: null,
    municipio: null,
    zona: null,
    lat: null,
    lng: null,
    sitio_web: null,
    sitio_verificado: false,
    redes: {},
    senales: [],
    base_licitud: null,
    consentimiento_en: null,
    score_ajuste: null,
    score_urgencia: null,
    score_cierre: null,
    score_completitud: null,
    score_explicacion: null,
    score_version: null,
    duplicado_de: null,
    vendedor_id: null,
    organization_id: null,
    org_demo_id: null,
    ultimo_toque_en: null,
    siguiente_paso: null,
    siguiente_paso_en: null,
    contacto_legado: false,
    ...over,
  };
}

/** Fila de core.list_cerebro_taxonomia_for_superadmin (restaurantes, version 1, vigente). */
export function filaTaxonomia(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    vertical: "restaurantes",
    version: 1,
    vigente: true,
    subtipos: [{ clave: "taqueria", nombre: "Taquería" }, { clave: "cafeteria", nombre: "Cafetería" }],
    rangos_tamano: { unidad: "sucursales", rangos: [{ clave: "s1", etiqueta: "1" }, { clave: "s2_3", etiqueta: "2-3" }] },
    senales: [
      { tipo: "whatsapp_publicado", nombre: "WhatsApp publicado", dimension: "ajuste", puntos: 15, como_conseguirla: "Busca el WhatsApp en Google Maps." },
      { tipo: "menu_en_linea", nombre: "Menú en línea", dimension: "ajuste", puntos: 10, como_conseguirla: "Revisa su sitio." },
      { tipo: "resenas_no_contestan", nombre: "Reseñas: no contestan", dimension: "urgencia", puntos: 35, como_conseguirla: "Lee las reseñas." },
      { tipo: "respuesta_previa", nombre: "Respondió", dimension: "cierre", puntos: 35, como_conseguirla: "Revisa el formulario." },
    ],
    icp: { descripcion: "ICP de prueba", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s1"] },
    objeciones: [{ objecion: "Es caro", respuesta: "El precio es por agente." }],
    mensajes_base: [{ canal: "whatsapp", variante: "A", texto: "Hola {nombre}, te muestro en 15 minutos cómo quedaría. Responde BAJA si no te interesa." }],
    contexto: {},
    plan_id: "restaurantes-estandar",
    plan_nombre: "Restaurantes - por agente de voz",
    plan_precio_base_mxn_centavos: "0",
    plan_precio_asiento_mxn_centavos: "79900",
    plan_asientos_incluidos: 1,
    estado_validacion: "propuesta_validar_con_javier",
    nota_cambio: null,
    vigente_desde: "2026-10-01T00:00:00.000Z",
    creado_en: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const PROSPECTO_LEGADO: ProspectoRow = {
  id: PROSPECTO_ID,
  empresa: "Taquería Ficticia",
  vertical: "restaurantes",
  ciudad: "Mérida",
  contactoNombre: null,
  telefono: null,
  correo: null,
  estado: "nuevo",
  fuente: null,
  notas: null,
  creadoPor: CALLER,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  necesitaSeguimientoDesde: null,
};

export function montarCerebro(handlers: readonly FakeSessionHandler[]) {
  const session = new AbortAwareFakeSession(handlers);
  const deps = {
    engine: { withAppSession: async (_c: unknown, fn: (db: AbortAwareFakeSession) => Promise<unknown>) => fn(session) },
    coreRepo: { listProspectosForSuperadmin: async () => [PROSPECTO_LEGADO] },
  } as unknown as AppDeps;
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", CALLER);
    await next();
  });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ code: err.code, error: err.message }, err.status as 400) : c.json({ error: "interno" }, 500)));
  app.route("/", superadminCerebroRoutes(deps, { ahora: () => AHORA_FIJA }));
  return { app, session };
}

export const enviar = (app: Hono<CoreAuthHonoEnv>, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
