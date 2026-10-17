// "Listo para produccion" de una organizacion: verificaciones puras en todos sus estados y la ruta GET /superadmin/organizaciones/:id/preflight
// de punta a punta contra repos en memoria. La autorizacion real y la lectura de datos en SQL se verifican en scripts/verify-superadmin-preflight/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCoreRepository, InMemoryOrgEquipoRepository, InMemoryOrgPreflightRepository, InMemorySaludRepository } from "@atiende/db";
import type { OrgEquipo, OrgPreflightHechos, PreflightSucursalHechos } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { CronConEstado } from "../src/salud/motor.ts";
import { cronsRelevantes, evaluarPreflight, snapshotDeOnboarding } from "../src/superadmin-preflight/verificaciones.ts";
import type { PreflightEntrada, Verificacion } from "../src/superadmin-preflight/verificaciones.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.unstubAllEnvs());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ORG = "11111111-1111-4111-8111-111111111111";
const SUC_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUC_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";
const SECRETO = "valor-secreto-que-jamas-debe-salir-1234567890";

const ENV_COMPLETO: Record<string, string> = {
  VERCEL_ENV: "production",
  APP_BASE_URL: "https://app.lostaquitos.mx",
  ALLOWED_ORIGINS: "https://app.lostaquitos.mx",
  RESEND_API_KEY: SECRETO,
  RESEND_FROM_EMAIL: "Taquitos <hola@lostaquitos.mx>",
  WHATSAPP_VERIFY_TOKEN: SECRETO,
  WHATSAPP_APP_SECRET: SECRETO,
  WHATSAPP_ACCESS_TOKEN: SECRETO,
  WHATSAPP_APPROVED_TEMPLATES: "pedido_confirmado,pedido_en_camino",
  OPENROUTER_API_KEY: SECRETO,
  SUPERADMIN_MFA_REQUIRED: "true",
  INTERNAL_SECRET: SECRETO,
  CRON_SECRET: SECRETO,
  ALERTAS_EMAIL_DESTINATARIOS: "alertas@lostaquitos.mx",
  GEMINI_API_KEY: SECRETO,
  VOICE_PREVIEW_TOKEN_SECRET: SECRETO,
};

const HORARIO_DOBLE = [
  { dias: [1, 2, 3], abre: "09:00", cierra: "15:00" },
  { dias: [1, 2, 3], abre: "15:00", cierra: "23:00" },
];

function sucursal(parche: Partial<PreflightSucursalHechos> & { id: string; nombre: string }): PreflightSucursalHechos {
  return {
    activa: true,
    conCoordenadas: true,
    productosDisponibles: 12,
    horario: HORARIO_DOBLE,
    conPedidoMinimoDomicilio: true,
    zonasDeEntrega: 3,
    conWhatsappPropio: true,
    voz: "habilitada",
    ...parche,
  };
}

const HECHOS_COMPLETOS: OrgPreflightHechos = {
  vertical: "restaurantes",
  restaurantes: {
    sucursales: [sucursal({ id: SUC_1, nombre: "García Lavín" }), sucursal({ id: SUC_2, nombre: "Pensiones" })],
    whatsappGeneral: true,
    agente: { configurada: true, conNombre: true },
    hayPedidos: true,
    privacidad: { configurada: true, conResponsable: true, conAviso: true, version: "v1", avisosPublicados: 1 },
  },
};

const EQUIPO_COMPLETO: OrgEquipo = {
  miembros: [{ userId: "u1", correo: "d***@lostaquitos.mx", rol: "owner", platformRole: "owner", propertyIds: null, altaEn: "2026-10-01T00:00:00.000Z" }],
  invitaciones: [],
  sucursales: [
    { id: SUC_1, nombre: "García Lavín", estado: "active" },
    { id: SUC_2, nombre: "Pensiones", estado: "active" },
  ],
};

function cron(nombre: string, estado: CronConEstado["estado"], fallos = 0): CronConEstado {
  return {
    cronName: nombre,
    estado,
    heartbeat: estado === "sin_latido" ? null : { cronName: nombre, lastStartedAt: "2026-10-04T10:00:00.000Z", lastFinishedAt: "2026-10-04T10:00:01.000Z", lastStatus: estado === "error" ? "error" : "ok", lastError: "TEXTO-DE-ERROR-INTERNO", lastDurationMs: 100, consecutiveFailures: fallos },
  };
}
const CRONS_OK: CronConEstado[] = [
  cron("/internal/whatsapp/dispatch", "ok"),
  cron("/internal/plataforma/privacidad-retencion", "ok"),
  cron("/internal/restaurantes/email-dispatch", "ok"),
  cron("/internal/restaurantes/promover-programados", "ok"),
  cron("/internal/hoteles/night-audit", "sin_latido"),
];

function entrada(parche: Partial<PreflightEntrada> = {}): PreflightEntrada {
  return {
    organizacion: { id: ORG, nombre: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes", estado: "trial" },
    env: ENV_COMPLETO,
    crons: CRONS_OK,
    equipo: { estado: "ok", dato: EQUIPO_COMPLETO },
    hechos: { estado: "ok", dato: HECHOS_COMPLETOS },
    mfaDelConsultante: true,
    ...parche,
  };
}

const porId = (vs: readonly Verificacion[], id: string): Verificacion => {
  const v = vs.find((x) => x.id === id);
  if (!v) throw new Error(`verificacion ausente: ${id} (hay: ${vs.map((x) => x.id).join(", ")})`);
  return v;
};
const evaluar = (parche: Partial<PreflightEntrada> = {}) => evaluarPreflight(entrada(parche)).verificaciones;
const sinVoz = (h: OrgPreflightHechos): OrgPreflightHechos => ({ ...h, restaurantes: { ...h.restaurantes!, sucursales: h.restaurantes!.sucursales!.map((s) => ({ ...s, voz: "deshabilitada" as const })) } });

describe("preflight: organizacion lista", () => {
  it("una fuente sin leer (0053/0057 sin aplicar o lectura fallida) nunca da 'listo' aunque no haya 'falta'", () => {
    for (const parche of [
      { hechos: { estado: "no_migrado" } },
      { hechos: { estado: "error" } },
      { equipo: { estado: "no_migrado" } },
      { crons: null },
    ] as Partial<PreflightEntrada>[]) {
      const r = evaluarPreflight(entrada(parche));
      expect(r.resumen.falta).toBe(0);
      expect(r.resumen.listo).toBe(false);
    }
  });

  it("entorno.contexto nombra la variable que decidio produccion", () => {
    const sinVercel = evaluar({ env: { ...ENV_COMPLETO, VERCEL_ENV: "", NODE_ENV: "production" } as PreflightEntrada["env"] });
    expect(porId(sinVercel, "entorno.contexto").detalle).toBe("NODE_ENV=production (sin VERCEL_ENV).");
    expect(porId(evaluar(), "entorno.contexto").detalle).toBe("VERCEL_ENV=production.");
  });

  it("con todo en orden no hay ningun 'falta' y la lista dice listo", () => {
    const r = evaluarPreflight(entrada());
    expect(r.resumen.falta).toBe(0);
    expect(r.resumen.listo).toBe(true);
    expect(r.resumen.pendientes).toBe(0);
    expect(r.resumen.total).toBe(r.verificaciones.length);
    expect(r.resumen.ok + r.resumen.falta + r.resumen.aviso + r.resumen.no_aplica).toBe(r.resumen.total);
    // El checklist del dueño se consume, no se duplica: un renglon por cada punto suyo.
    expect(r.verificaciones.filter((v) => v.area === "datos").map((v) => v.id)).toContain("datos.sucursales");
    expect(r.verificaciones.every((v) => v.id.length > 0 && v.detalle.length > 0 && v.como_resolver.texto.length > 0)).toBe(true);
  });

  it("los ids son unicos y todas las areas pedidas tienen al menos una verificacion", () => {
    const vs = evaluar();
    expect(new Set(vs.map((v) => v.id)).size).toBe(vs.length);
    for (const area of ["entorno", "crons", "equipo", "canal", "privacidad", "voz", "datos", "monitoreo"]) expect(vs.some((v) => v.area === area), area).toBe(true);
  });
});

describe("preflight: entorno", () => {
  it("Meta sin sus tres variables: falta con los NOMBRES que faltan, nunca valores", () => {
    const { WHATSAPP_ACCESS_TOKEN: _omit, ...resto } = ENV_COMPLETO;
    void _omit;
    const v = porId(evaluar({ env: resto }), "entorno.meta");
    expect(v.estado).toBe("falta");
    expect(v.detalle).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(v.detalle).not.toContain(SECRETO);
  });

  it("produccion sin APP_BASE_URL o con http://: falta; fuera de produccion: aviso", () => {
    const { APP_BASE_URL: _omit, ...sinBase } = ENV_COMPLETO;
    void _omit;
    expect(porId(evaluar({ env: sinBase }), "entorno.app_base_url").estado).toBe("falta");
    expect(porId(evaluar({ env: { ...ENV_COMPLETO, APP_BASE_URL: "http://app.lostaquitos.mx" } }), "entorno.app_base_url").estado).toBe("falta");
    expect(porId(evaluar({ env: { ...sinBase, VERCEL_ENV: "preview" } }), "entorno.app_base_url").estado).toBe("aviso");
    expect(porId(evaluar(), "entorno.app_base_url").estado).toBe("ok");
  });

  it("produccion sin RESEND_FROM_EMAIL: el correo queda en falta (remitente no inventado)", () => {
    const { RESEND_FROM_EMAIL: _omit, ...resto } = ENV_COMPLETO;
    void _omit;
    const v = porId(evaluar({ env: resto }), "entorno.correo");
    expect(v.estado).toBe("falta");
    expect(v.detalle).toContain("RESEND_FROM_EMAIL");
  });

  it("ALLOWED_ORIGINS solo con localhost: falta en produccion", () => {
    expect(porId(evaluar({ env: { ...ENV_COMPLETO, ALLOWED_ORIGINS: "http://localhost:5173" } }), "entorno.allowed_origins").estado).toBe("falta");
    expect(porId(evaluar(), "entorno.allowed_origins").estado).toBe("ok");
  });

  it("OpenRouter, MFA requerida y contexto de entorno", () => {
    const { OPENROUTER_API_KEY: _a, SUPERADMIN_MFA_REQUIRED: _b, ...resto } = ENV_COMPLETO;
    void _a;
    void _b;
    const vs = evaluar({ env: { ...resto, VERCEL_ENV: "preview" } });
    expect(porId(vs, "entorno.openrouter").estado).toBe("falta");
    expect(porId(vs, "entorno.mfa_requerida").estado).toBe("aviso");
    expect(porId(vs, "entorno.contexto").estado).toBe("aviso");
    expect(porId(evaluar(), "entorno.contexto").estado).toBe("ok");
  });
});

describe("preflight: crons", () => {
  it("CRON_SECRET ausente o distinto de INTERNAL_SECRET: falta; igual: ok (sin imprimir ningun valor)", () => {
    const { CRON_SECRET: _omit, ...sinCron } = ENV_COMPLETO;
    void _omit;
    const ausente = porId(evaluar({ env: sinCron }), "crons.secreto");
    const distinto = porId(evaluar({ env: { ...ENV_COMPLETO, CRON_SECRET: "otro-valor-distinto" } }), "crons.secreto");
    expect(ausente.estado).toBe("falta");
    expect(distinto.estado).toBe("falta");
    expect(porId(evaluar(), "crons.secreto").estado).toBe("ok");
    for (const v of [ausente, distinto]) expect(JSON.stringify(v)).not.toMatch(/otro-valor-distinto|valor-secreto/);
  });

  it("solo juzga los crons de la vertical: whatsapp, privacidad y /internal/restaurantes/*; no los de hoteles", () => {
    const ids = evaluar().filter((v) => v.area === "crons").map((v) => v.id);
    expect(ids).toContain("crons.whatsapp.dispatch");
    expect(ids).toContain("crons.plataforma.privacidad-retencion");
    expect(ids).toContain("crons.restaurantes.email-dispatch");
    expect(ids).not.toContain("crons.hoteles.night-audit");
    expect(cronsRelevantes("citas", ["/internal/restaurantes/x", "/internal/whatsapp/dispatch"])).toEqual(["/internal/plataforma/privacidad-retencion", "/internal/whatsapp/dispatch"]);
  });

  it("sin latido, vencido y con error son 'falta'; el texto interno del error no sale", () => {
    const crons = [cron("/internal/whatsapp/dispatch", "sin_latido"), cron("/internal/plataforma/privacidad-retencion", "vencido"), cron("/internal/restaurantes/email-dispatch", "error", 4), cron("/internal/restaurantes/promover-programados", "ok")];
    const vs = evaluar({ crons });
    expect(porId(vs, "crons.whatsapp.dispatch").estado).toBe("falta");
    expect(porId(vs, "crons.plataforma.privacidad-retencion").estado).toBe("falta");
    const err = porId(vs, "crons.restaurantes.email-dispatch");
    expect(err.estado).toBe("falta");
    expect(err.detalle).toContain("4 fallo");
    expect(JSON.stringify(vs)).not.toContain("TEXTO-DE-ERROR-INTERNO");
    expect(porId(vs, "crons.restaurantes.promover-programados").estado).toBe("ok");
  });

  it("el despacho a SoftRestaurant depende del POS: sin latido es aviso (no bloquea); la limpieza de voz solo importa con voz habilitada", () => {
    const crons = [...CRONS_OK, cron("/internal/restaurantes/softrestaurant-dispatch", "sin_latido"), cron("/internal/restaurantes/voz-huerfanas", "sin_latido")];
    const conVoz = evaluar({ crons });
    expect(porId(conVoz, "crons.restaurantes.softrestaurant-dispatch").estado).toBe("aviso");
    expect(porId(conVoz, "crons.restaurantes.softrestaurant-dispatch").detalle).toContain("No bloquea");
    expect(porId(conVoz, "crons.restaurantes.voz-huerfanas").estado).toBe("falta");
    const sinVozHabilitada = evaluar({ crons, hechos: { estado: "ok", dato: sinVoz(HECHOS_COMPLETOS) } });
    expect(porId(sinVozHabilitada, "crons.restaurantes.voz-huerfanas").estado).toBe("no_aplica");
  });

  it("latidos ilegibles: un solo aviso 'no se pudo medir', nunca 'ok'", () => {
    const vs = evaluar({ crons: null });
    expect(porId(vs, "crons.latidos").estado).toBe("aviso");
    expect(vs.filter((v) => v.area === "crons" && v.estado === "ok").map((v) => v.id)).toEqual(["crons.secreto"]);
  });
});

describe("preflight: equipo", () => {
  it("organizacion sin miembros: equipo falta (owner y cobertura)", () => {
    const vs = evaluar({ equipo: { estado: "ok", dato: { ...EQUIPO_COMPLETO, miembros: [] } } });
    expect(porId(vs, "equipo.owner").estado).toBe("falta");
    expect(porId(vs, "equipo.cobertura").estado).toBe("falta");
    expect(porId(vs, "equipo.owner").como_resolver.enlace).toBe(`/superadmin/organizaciones/${ORG}`);
  });

  it("owner con invitacion pendiente: sigue 'falta' pero lo dice", () => {
    const vs = evaluar({
      equipo: { estado: "ok", dato: { ...EQUIPO_COMPLETO, miembros: [], invitaciones: [{ id: "i1", correo: "d***@x.mx", rol: "owner", platformRole: "owner", propertyIds: null, creadaEn: "2026-10-01T00:00:00.000Z", venceEn: "2026-10-08T00:00:00.000Z", vencida: false }] } },
    });
    expect(porId(vs, "equipo.owner").estado).toBe("falta");
    expect(porId(vs, "equipo.owner").detalle).toContain("invitación");
  });

  it("una sucursal activa sin nadie con alcance: falta y nombra la sucursal; la inactiva no cuenta; el repartidor no cuenta", () => {
    const dato: OrgEquipo = {
      miembros: [
        { userId: "u1", correo: "a***@x.mx", rol: "owner", platformRole: "owner", propertyIds: [SUC_1], altaEn: "2026-10-01T00:00:00.000Z" },
        { userId: "u2", correo: "b***@x.mx", rol: "repartidor", platformRole: "member", propertyIds: null, altaEn: "2026-10-01T00:00:00.000Z" },
      ],
      invitaciones: [],
      sucursales: [...EQUIPO_COMPLETO.sucursales, { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", nombre: "Galerías", estado: "inactive" }],
    };
    const v = porId(evaluar({ equipo: { estado: "ok", dato } }), "equipo.cobertura");
    expect(v.estado).toBe("falta");
    expect(v.detalle).toContain("Pensiones");
    expect(v.detalle).not.toContain("Galerías");
    expect(v.detalle).not.toContain("García Lavín");
  });

  it("staff con alcance total cubre todas las sucursales activas: ok", () => {
    expect(porId(evaluar(), "equipo.cobertura").estado).toBe("ok");
    expect(porId(evaluar(), "equipo.owner").estado).toBe("ok");
  });

  it("base sin la 0053: aviso con su razon (no falta, no ok)", () => {
    const vs = evaluar({ equipo: { estado: "no_migrado" } });
    expect(porId(vs, "equipo.owner").estado).toBe("aviso");
    expect(porId(vs, "equipo.owner").detalle).toContain("0053");
  });

  it("MFA del consultante: activa ok, sin factor falta, sin migrar aviso", () => {
    expect(porId(evaluar({ mfaDelConsultante: true }), "equipo.mfa_superadmin").estado).toBe("ok");
    expect(porId(evaluar({ mfaDelConsultante: false }), "equipo.mfa_superadmin").estado).toBe("falta");
    expect(porId(evaluar({ mfaDelConsultante: null }), "equipo.mfa_superadmin").estado).toBe("aviso");
  });
});

describe("preflight: canal, privacidad y voz", () => {
  const conRest = (parche: Partial<NonNullable<OrgPreflightHechos["restaurantes"]>>): OrgPreflightHechos => ({ vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, ...parche } });

  it("sin canal de WhatsApp (ni general ni por sucursal): falta, con enlace a la configuracion del panel", () => {
    const h = conRest({ whatsappGeneral: false, sucursales: HECHOS_COMPLETOS.restaurantes!.sucursales!.map((s) => ({ ...s, conWhatsappPropio: false })) });
    const vs = evaluar({ hechos: { estado: "ok", dato: h } });
    expect(porId(vs, "canal.general").estado).toBe("falta");
    const suc = porId(vs, "canal.sucursales");
    expect(suc.estado).toBe("falta");
    expect(suc.detalle).toContain("García Lavín");
    expect(suc.como_resolver.enlace).toBe("/restaurantes/los-taquitos-de-pm/configuracion");
  });

  it("solo numero general: aviso; con numero propio en todas: ok", () => {
    const soloGeneral = conRest({ sucursales: HECHOS_COMPLETOS.restaurantes!.sucursales!.map((s) => ({ ...s, conWhatsappPropio: false })) });
    expect(porId(evaluar({ hechos: { estado: "ok", dato: soloGeneral } }), "canal.sucursales").estado).toBe("aviso");
    expect(porId(evaluar(), "canal.sucursales").estado).toBe("ok");
  });

  it("plantillas declaradas: ok; vacias: aviso (texto libre solo dentro de 24 h)", () => {
    const { WHATSAPP_APPROVED_TEMPLATES: _omit, ...resto } = ENV_COMPLETO;
    void _omit;
    expect(porId(evaluar(), "canal.plantillas").estado).toBe("ok");
    const v = porId(evaluar({ env: resto }), "canal.plantillas");
    expect(v.estado).toBe("aviso");
    expect(v.detalle).toContain("24");
  });

  it("privacidad: sin configurar, incompleta, completa y sin migrar", () => {
    const base = HECHOS_COMPLETOS.restaurantes!.privacidad!;
    const p = (parche: Partial<typeof base>) => porId(evaluar({ hechos: { estado: "ok", dato: conRest({ privacidad: { ...base, ...parche } }) } }), "privacidad.config");
    expect(p({ configurada: false, conResponsable: false, conAviso: false }).estado).toBe("falta");
    const inc = p({ conAviso: false });
    expect(inc.estado).toBe("falta");
    expect(inc.detalle).toContain("URL del aviso integral");
    expect(p({}).estado).toBe("ok");
    expect(porId(evaluar({ hechos: { estado: "ok", dato: conRest({ privacidad: null }) } }), "privacidad.config").estado).toBe("aviso");
    expect(porId(evaluar({ hechos: { estado: "ok", dato: conRest({ privacidad: { ...base, avisosPublicados: 0 } }) } }), "privacidad.version").estado).toBe("aviso");
    expect(porId(evaluar(), "privacidad.version").estado).toBe("ok");
  });

  it("voz deshabilitada en todas: las credenciales de voz son 'no_aplica'; habilitada sin credenciales: falta", () => {
    const { GEMINI_API_KEY: _omit, ...sinGemini } = ENV_COMPLETO;
    void _omit;
    expect(porId(evaluar({ hechos: { estado: "ok", dato: sinVoz(HECHOS_COMPLETOS) }, env: sinGemini }), "voz.credenciales").estado).toBe("no_aplica");
    const falta = porId(evaluar({ env: sinGemini }), "voz.credenciales");
    expect(falta.estado).toBe("falta");
    expect(falta.detalle).toContain("GEMINI_API_KEY");
    expect(porId(evaluar(), "voz.credenciales").estado).toBe("ok");
  });

  it("voz sin decision por sucursal: aviso con los nombres", () => {
    const h = conRest({ sucursales: [sucursal({ id: SUC_1, nombre: "García Lavín", voz: "sin_configurar" }), sucursal({ id: SUC_2, nombre: "Pensiones" })] });
    const v = porId(evaluar({ hechos: { estado: "ok", dato: h } }), "voz.decision");
    expect(v.estado).toBe("aviso");
    expect(v.detalle).toContain("García Lavín");
  });
});

describe("preflight: datos del dueño (checklist consumido, no duplicado)", () => {
  it("un menu vacio en una sucursal activa es 'falta' (obligatorio) y apunta a la pantalla de productos", () => {
    const h: OrgPreflightHechos = { vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, sucursales: [sucursal({ id: SUC_1, nombre: "García Lavín", productosDisponibles: 0 }), sucursal({ id: SUC_2, nombre: "Pensiones" })] } };
    const v = porId(evaluar({ hechos: { estado: "ok", dato: h } }), "datos.menu");
    expect(v.estado).toBe("falta");
    expect(v.detalle).toContain("García Lavín");
    // El detalle del dueño ya nombra la sucursal: no se repite al final.
    expect(v.detalle.split("García Lavín").length - 1).toBe(1);
    expect(v.como_resolver.enlace).toBe("/restaurantes/los-taquitos-de-pm/productos");
  });

  it("un punto opcional pendiente es 'aviso' y uno externo tambien; uno hecho no trae enlace", () => {
    const h: OrgPreflightHechos = { vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, sucursales: [sucursal({ id: SUC_1, nombre: "García Lavín", conCoordenadas: false })] } };
    const vs = evaluar({ hechos: { estado: "ok", dato: h } });
    expect(porId(vs, "datos.coordenadas").estado).toBe("aviso");
    expect(porId(vs, "datos.catalogo_pos").estado).toBe("aviso");
    expect(porId(vs, "datos.sucursales").estado).toBe("ok");
    expect(porId(vs, "datos.sucursales").como_resolver.enlace).toBeNull();
  });

  it("el calculo es el del dueño: horario con dos turnos el mismo dia se ve como cambio de turno hecho", () => {
    expect(porId(evaluar(), "datos.cambio_de_turno").estado).toBe("ok");
    const h: OrgPreflightHechos = { vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, sucursales: [sucursal({ id: SUC_1, nombre: "García Lavín", horario: [{ dias: [1], abre: "09:00", cierra: "22:00" }] })] } };
    expect(porId(evaluar({ hechos: { estado: "ok", dato: h } }), "datos.cambio_de_turno").estado).toBe("aviso");
    expect(snapshotDeOnboarding(h.restaurantes!, ENV_COMPLETO)?.sucursales[0]?.dobleTurno).toBe(false);
  });

  it("sin agente configurado ni pedidos ni privacidad: los obligatorios salen 'falta'", () => {
    const h: OrgPreflightHechos = { vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, agente: { configurada: false, conNombre: false }, hayPedidos: false, privacidad: { configurada: false, conResponsable: false, conAviso: false, version: null, avisosPublicados: 0 } } };
    const vs = evaluar({ hechos: { estado: "ok", dato: h } });
    expect(porId(vs, "datos.agente_whatsapp").estado).toBe("falta");
    expect(porId(vs, "datos.aviso_privacidad").estado).toBe("falta");
    expect(porId(vs, "datos.pedido_de_prueba").estado).toBe("aviso");
  });

  it("sucursales ilegibles o base sin migrar: aviso 'no se pudo medir', nunca ok ni falta inventada", () => {
    const ilegible: OrgPreflightHechos = { vertical: "restaurantes", restaurantes: { ...HECHOS_COMPLETOS.restaurantes!, sucursales: null } };
    expect(porId(evaluar({ hechos: { estado: "ok", dato: ilegible } }), "datos.checklist").estado).toBe("aviso");
    const sinMigrar = evaluar({ hechos: { estado: "no_migrado" } });
    for (const id of ["datos.checklist", "canal.general", "canal.sucursales", "privacidad.config", "voz.credenciales"]) {
      expect(porId(sinMigrar, id).estado, id).toBe("aviso");
      expect(porId(sinMigrar, id).detalle, id).toContain("0057");
    }
  });
});

describe("preflight: otras verticales y monitoreo", () => {
  it("una organizacion que no es de restaurantes: canal/privacidad/voz/datos son 'no_aplica' y sus crons no incluyen los de restaurantes", () => {
    const vs = evaluar({
      organizacion: { id: ORG, nombre: "Hotel X", slug: "hotel-x", vertical: "hoteles", estado: "active" },
      hechos: { estado: "ok", dato: { vertical: "hoteles", restaurantes: null } },
    });
    for (const id of ["canal.general", "canal.sucursales", "privacidad.config", "voz.credenciales", "datos.checklist"]) expect(porId(vs, id).estado, id).toBe("no_aplica");
    expect(vs.some((v) => v.id.startsWith("crons.restaurantes"))).toBe(false);
  });

  it("alertas salientes: sin ningun canal es aviso", () => {
    const { ALERTAS_EMAIL_DESTINATARIOS: _omit, ...resto } = ENV_COMPLETO;
    void _omit;
    expect(porId(evaluar({ env: resto }), "monitoreo.alertas").estado).toBe("aviso");
    expect(porId(evaluar(), "monitoreo.alertas").estado).toBe("ok");
    expect(porId(evaluar({ env: { ...resto, SENTRY_DSN: "https://k@o.ingest.sentry.io/1" } }), "monitoreo.alertas").estado).toBe("ok");
  });

  it("ninguna verificacion filtra un secreto del entorno ni un correo completo", () => {
    const texto = JSON.stringify(evaluarPreflight(entrada()));
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain("hola@lostaquitos.mx");
    expect(texto).not.toContain("alertas@lostaquitos.mx");
  });
});

// ───────────────────────── la ruta ─────────────────────────

async function setupRuta(opciones: { equipo?: InMemoryOrgEquipoRepository | null; preflight?: InMemoryOrgPreflightRepository | null } = {}) {
  const s = await seguridadSetup();
  const core = s.base.deps.coreRepo as InMemoryCoreRepository;
  core.addOrganization({ id: ORG, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes", status: "trial", createdAt: "2026-09-01T00:00:00.000Z" });
  const equipo = opciones.equipo === undefined ? new InMemoryOrgEquipoRepository() : opciones.equipo;
  equipo?.seedOrganizacion(ORG, "restaurantes", [{ id: SUC_1, nombre: "García Lavín" }, { id: SUC_2, nombre: "Pensiones" }]);
  const preflight = opciones.preflight === undefined ? new InMemoryOrgPreflightRepository() : opciones.preflight;
  preflight?.seedOrganizacion(ORG, HECHOS_COMPLETOS);
  const deps = { ...s.deps, ...(equipo ? { orgEquipoRepo: () => equipo } : {}), ...(preflight ? { orgPreflightRepo: () => preflight } : {}) };
  const app = buildApp(deps);
  return {
    s, app, equipo, preflight, deps,
    async superadmin() {
      const sa = await s.superadmin();
      equipo?.seedSuperadmin(sa.id);
      preflight?.seedSuperadmin(sa.id);
      (s.base.deps.saludRepo as InMemorySaludRepository).addPlatformSuperadmin(sa.id);
      return sa;
    },
  };
}
const preflight = (app: ReturnType<typeof buildApp>, org: string, token: string) => app.request(`/superadmin/organizaciones/${org}/preflight`, { headers: bearer(token) });

function envDeProduccion(): void {
  for (const [k, v] of Object.entries(ENV_COMPLETO)) vi.stubEnv(k, v);
}

describe("GET /superadmin/organizaciones/:id/preflight", () => {
  it("sin token 401; un owner/staff de la organizacion 403 (solo superadmin)", async () => {
    const c = await setupRuta();
    const st = await c.s.staff();
    expect((await c.app.request(`/superadmin/organizaciones/${ORG}/preflight`)).status).toBe(401);
    expect((await preflight(c.app, ORG, st.token)).status).toBe(403);
    expect(c.preflight?.llamadas).toHaveLength(0);
  });

  it("id invalido u organizacion inexistente: 404", async () => {
    const c = await setupRuta();
    const sa = await c.superadmin();
    expect((await preflight(c.app, "no-es-uuid", sa.token)).status).toBe(404);
    expect((await preflight(c.app, INEXISTENTE, sa.token)).status).toBe(404);
  });

  it("organizacion sin miembros: equipo falta; con datos completos el resto de los datos esta en orden", async () => {
    envDeProduccion();
    const c = await setupRuta();
    const sa = await c.superadmin();
    const res = await preflight(c.app, ORG, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.organizacion).toMatchObject({ id: ORG, slug: "los-taquitos-de-pm", vertical: "restaurantes" });
    expect(body.areas.map((a: Json) => a.area)).toEqual(["entorno", "crons", "equipo", "canal", "privacidad", "voz", "datos", "monitoreo"]);
    const todas: Json[] = body.areas.flatMap((a: Json) => a.verificaciones);
    const v = (id: string) => todas.find((x) => x.id === id);
    expect(v("equipo.owner").estado).toBe("falta");
    expect(v("equipo.cobertura").estado).toBe("falta");
    expect(v("datos.menu").estado).toBe("ok");
    expect(v("canal.general").estado).toBe("ok");
    expect(v("equipo.mfa_superadmin").estado).toBe("falta"); // el superadmin de prueba no enrolo MFA
    // Los crons de la vertical aparecen declarados pero sin latido (el estado real del go-live): falta.
    expect(v("crons.whatsapp.dispatch").estado).toBe("falta");
    expect(body.resumen.listo).toBe(false);
    expect(body.resumen.pendientes).toBe(body.resumen.falta);
    expect(body.fuentes).toMatchObject({ equipo: "ok", datos: "ok", crons: "ok" });
  });

  it("con un owner con acceso y latidos recientes el equipo y los crons pasan", async () => {
    envDeProduccion();
    const c = await setupRuta();
    const sa = await c.superadmin();
    c.equipo!.seedMiembro(ORG, { userId: "00000000-0000-4000-8000-000000000001", email: "dueno@lostaquitos.mx", rol: "owner" });
    const ahora = new Date().toISOString();
    const salud = c.s.base.deps.saludRepo as InMemorySaludRepository;
    for (const cronName of ["/internal/whatsapp/dispatch", "/internal/plataforma/privacidad-retencion"]) {
      await salud.recordCronHeartbeat({ cronName, status: "ok", error: null, startedAt: ahora, finishedAt: ahora, durationMs: 50 });
    }
    const body = (await (await preflight(c.app, ORG, sa.token)).json()) as Json;
    const todas: Json[] = body.areas.flatMap((a: Json) => a.verificaciones);
    const v = (id: string) => todas.find((x) => x.id === id);
    expect(v("equipo.owner").estado).toBe("ok");
    expect(v("equipo.cobertura").estado).toBe("ok");
    expect(v("crons.whatsapp.dispatch").estado).toBe("ok");
    expect(v("crons.plataforma.privacidad-retencion").estado).toBe("ok");
  });

  it("la respuesta no contiene valores de secretos ni correos completos", async () => {
    envDeProduccion();
    const c = await setupRuta();
    const sa = await c.superadmin();
    c.equipo!.seedMiembro(ORG, { userId: "00000000-0000-4000-8000-000000000001", email: "dueno@lostaquitos.mx", rol: "owner" });
    const texto = await (await preflight(c.app, ORG, sa.token)).text();
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain("dueno@lostaquitos.mx");
    expect(texto).not.toContain("hola@lostaquitos.mx");
  });

  it("base sin migrar (0053 y 0057): 200 con avisos honestos, nunca 500", async () => {
    envDeProduccion();
    const equipo = new InMemoryOrgEquipoRepository();
    equipo.seedNoMigrado();
    const pre = new InMemoryOrgPreflightRepository();
    pre.fallar("no_migrado");
    const c = await setupRuta({ equipo, preflight: pre });
    const sa = await c.superadmin();
    const res = await preflight(c.app, ORG, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.fuentes).toMatchObject({ equipo: "no_migrado", datos: "no_migrado" });
    const todas: Json[] = body.areas.flatMap((a: Json) => a.verificaciones);
    const v = (id: string) => todas.find((x) => x.id === id);
    expect(v("equipo.owner").estado).toBe("aviso");
    expect(v("datos.checklist").estado).toBe("aviso");
    expect(v("datos.checklist").detalle).toContain("0057");
  });

  it("sin los repositorios inyectados: 200 y 'no_disponible'", async () => {
    const c = await setupRuta({ equipo: null, preflight: null });
    const sa = await c.superadmin();
    const res = await preflight(c.app, ORG, sa.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).fuentes).toMatchObject({ equipo: "no_disponible", datos: "no_disponible" });
  });

  it("fallo de la lectura de datos: 200 con aviso 'la lectura fallo'", async () => {
    const pre = new InMemoryOrgPreflightRepository();
    pre.fallar("error");
    const c = await setupRuta({ preflight: pre });
    const sa = await c.superadmin();
    const res = await preflight(c.app, ORG, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.fuentes.datos).toBe("error");
  });
});
