// SA-L-37 y SA-L-41 en el API: alta y edicion de prospectos con score determinista guardado junto con su version, base de
// licitud obligatoria con datos de contacto, personas de contacto con evidencia (nada deducido por patron), base sin migrar
// (el flujo anterior sigue funcionando) y sesion sana con AbortAwareFakeSession.
import { describe, expect, it, vi } from "vitest";
import { validarDatosProspecto, validarPersona } from "../src/cerebro/index.ts";
import { AHORA_FIJA, CALLER, PROSPECTO_ID, enviar, filaProspecto, filaTaxonomia, montarCerebro, pgError } from "./cerebro-fixtures.ts";

const TAXONOMIA = { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => [filaTaxonomia()] };
const SIN_PERSONAS = { match: /list_prospecto_personas_for_superadmin/, respond: () => [] };

function senalCruda(tipo: string, over: Record<string, unknown> = {}) {
  return { tipo, valor: "si", fuente: "Google Maps", url: `https://example.com/${tipo}`, observadoEn: "2026-09-20", ...over };
}

describe("validarDatosProspecto", () => {
  it("exige empresa y vertical en el alta", () => {
    expect(validarDatosProspecto({}, true, null).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X" }, true, null).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X", vertical: "gasolineras" }, true, null).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X", vertical: "citas" }, true, null)).toMatchObject({ ok: true });
  });

  it("la base de licitud es obligatoria al dar de alta con telefono, correo o nombre de contacto", () => {
    for (const contacto of [{ telefono: "5555550100" }, { correo: "a@example.com" }, { contactoNombre: "Ana" }]) {
      const r = validarDatosProspecto({ empresa: "X", vertical: "citas", ...contacto }, true, null);
      expect(r).toMatchObject({ ok: false, codigo: "base_licitud_requerida" });
    }
    expect(validarDatosProspecto({ empresa: "X", vertical: "citas", telefono: "5555550100", baseLicitud: "fuente_publica_b2b" }, true, null).ok).toBe(true);
  });

  it("interes declarado y referido con consentimiento exigen la fecha de consentimiento", () => {
    expect(validarDatosProspecto({ empresa: "X", vertical: "citas", baseLicitud: "interes_declarado" }, true, null).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X", vertical: "citas", baseLicitud: "interes_declarado", consentimientoEn: "2026-09-12" }, true, null).ok).toBe(true);
    expect(validarDatosProspecto({ empresa: "X", vertical: "citas", baseLicitud: "otra" }, true, null).ok).toBe(false);
  });

  it("subtipo y tamano deben existir en la taxonomia vigente", () => {
    const tax = { subtipos: ["taqueria"], rangos: ["s1"] };
    expect(validarDatosProspecto({ empresa: "X", vertical: "restaurantes", subtipo: "fantasma" }, true, tax).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X", vertical: "restaurantes", tamano: "s9" }, true, tax).ok).toBe(false);
    expect(validarDatosProspecto({ empresa: "X", vertical: "restaurantes", subtipo: "taqueria", tamano: "s1" }, true, tax).ok).toBe(true);
  });

  it("en edicion solo viajan las claves presentes (null limpia, ausente conserva)", () => {
    const r = validarDatosProspecto({ zona: "Centro", ciudad: null }, false, null);
    expect(r).toEqual({ ok: true, valor: { zona: "Centro", ciudad: null } });
  });

  it("valida señales (tipo, fuente, fecha, URL), coordenadas, sitio web y redes", () => {
    expect(validarDatosProspecto({ senales: [senalCruda("menu_en_linea")] }, false, null).ok).toBe(true);
    expect(validarDatosProspecto({ senales: [senalCruda("menu_en_linea", { fuente: "" })] }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ senales: [senalCruda("menu_en_linea", { observadoEn: "ayer" })] }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ senales: [senalCruda("menu_en_linea", { url: "ftp://x" })] }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ senales: [senalCruda("Menu En Linea")] }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ lat: 19.4 }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ lat: 95, lng: 10 }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ lat: 19.4, lng: -99.1 }, false, null).ok).toBe(true);
    expect(validarDatosProspecto({ sitioWeb: "example.com" }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ redes: { instagram: "https://instagram.com/x" } }, false, null).ok).toBe(true);
    expect(validarDatosProspecto({ redes: { Instagram: "no es url" } }, false, null).ok).toBe(false);
    expect(validarDatosProspecto({ duplicadoDe: "no-uuid" }, false, null).ok).toBe(false);
  });
});

describe("validarPersona: sin evidencia se rechaza", () => {
  const ok = { nombre: "Ana Ficticia", cargo: "Gerente", canal: "correo", dato: "ana@example.com", origen: "sitio_web_oficial", confianza: "alta", evidenciaUrl: "https://example.com/equipo" };

  it("acepta una persona con evidencia y origen verificable", () => {
    expect(validarPersona(ok).ok).toBe(true);
  });

  it("rechaza sin evidencia o con evidencia que no es una URL", () => {
    expect(validarPersona({ ...ok, evidenciaUrl: "" })).toMatchObject({ ok: false, codigo: "evidencia_requerida" });
    expect(validarPersona({ ...ok, evidenciaUrl: "lo vi por ahí" })).toMatchObject({ ok: false, codigo: "evidencia_requerida" });
    const { evidenciaUrl: _omitida, ...sinCampo } = ok;
    expect(validarPersona(sinCampo)).toMatchObject({ ok: false, codigo: "evidencia_requerida" });
  });

  it("un correo deducido por patron no tiene origen valido", () => {
    expect(validarPersona({ ...ok, origen: "patron" })).toMatchObject({ ok: false, codigo: "origen_invalido" });
    expect(validarPersona({ ...ok, origen: "deducido" })).toMatchObject({ ok: false, codigo: "origen_invalido" });
  });

  it("valida nombre, canal, confianza y forma del correo", () => {
    expect(validarPersona({ ...ok, nombre: "A" }).ok).toBe(false);
    expect(validarPersona({ ...ok, canal: "paloma" }).ok).toBe(false);
    expect(validarPersona({ ...ok, confianza: "total" }).ok).toBe(false);
    expect(validarPersona({ ...ok, dato: "ana-sin-arroba" }).ok).toBe(false);
  });
});

describe("POST /superadmin/cerebro/prospectos", () => {
  function conGuardado() {
    return montarCerebro([
      TAXONOMIA,
      SIN_PERSONAS,
      { match: /save_prospecto_cerebro_for_superadmin/, respond: () => [filaProspecto({ senales: [{ tipo: "whatsapp_publicado", valor: "si", fuente: "Google Maps", url: "https://example.com/w", observado_en: "2026-09-20" }, { tipo: "menu_en_linea", valor: "si", fuente: "Sitio", url: null, observado_en: "2026-09-21" }, { tipo: "resenas_no_contestan", valor: null, fuente: "Google Maps", url: null, observado_en: "2026-09-22" }] })] },
    ]);
  }

  it("guarda el prospecto y despues su score con version y explicacion que suma exacto", async () => {
    const { app, session } = conGuardado();
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "Taquería Ficticia", vertical: "restaurantes", subtipo: "taqueria", tamano: "s1", ciudad: "Mérida" });
    expect(res.status).toBe(201);
    const guardados = spy.mock.calls.filter(([sql]) => /save_prospecto_cerebro_for_superadmin/.test(sql));
    expect(guardados).toHaveLength(2);
    // 1) datos sin score, 2) solo score (datos vacios).
    expect(guardados[0]![1]).toEqual([CALLER, null, JSON.stringify({ empresa: "Taquería Ficticia", vertical: "restaurantes", ciudad: "Mérida", subtipo: "taqueria", tamano: "s1" }), ]);
    expect(guardados[1]![0]).toContain("'{}'::jsonb");
    const score = JSON.parse(guardados[1]![1]![2] as string) as { ajuste: number; urgencia: number; cierre: number; completitud: number; version: string; explicacion: { calculadoEn: string; dimensiones: Record<string, { puntaje: number; items: Array<{ puntos: number }> }>; insuficiente: unknown } };
    expect(score.version).toBe("reglas-v1/tax-1");
    // ajuste: subtipo 25 + tamano 25 + whatsapp 15 + menu 10 = 75; urgencia 35; cierre 0 (sin base ni persona ni senal de cierre).
    expect([score.ajuste, score.urgencia, score.cierre]).toEqual([75, 35, 0]);
    // completitud: subtipo 15 + tamano 15 + ciudad 10 = 40
    expect(score.completitud).toBe(40);
    for (const dim of ["ajuste", "urgencia", "cierre", "completitud"]) {
      const d = score.explicacion.dimensiones[dim]!;
      expect(d.items.reduce((s, i) => s + i.puntos, 0)).toBe(d.puntaje);
    }
    expect(score.explicacion.insuficiente).toBeNull();
    expect(score.explicacion.calculadoEn).toBe(AHORA_FIJA.toISOString());
  });

  it("con telefono y sin base de licitud responde 422 y NO escribe nada", async () => {
    const { app, session } = conGuardado();
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "X", vertical: "restaurantes", telefono: "5555550100" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "base_licitud_requerida" });
    expect(spy.mock.calls.some(([sql]) => /save_prospecto_cerebro/.test(sql))).toBe(false);
  });

  it("un subtipo fuera de la taxonomia vigente es 400 y no escribe", async () => {
    const { app, session } = conGuardado();
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "X", vertical: "restaurantes", subtipo: "fantasma" });
    expect(res.status).toBe(400);
    expect(spy.mock.calls.some(([sql]) => /save_prospecto_cerebro/.test(sql))).toBe(false);
  });

  it("menos de 3 senales: guarda scores nulos con SENAL INSUFICIENTE y la completitud calculada", async () => {
    const { app, session } = montarCerebro([TAXONOMIA, SIN_PERSONAS, { match: /save_prospecto_cerebro_for_superadmin/, respond: () => [filaProspecto()] }]);
    const spy = vi.spyOn(session, "query");
    expect((await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "X", vertical: "restaurantes", subtipo: "taqueria" })).status).toBe(201);
    const guardados = spy.mock.calls.filter(([sql]) => /save_prospecto_cerebro_for_superadmin/.test(sql));
    const score = JSON.parse(guardados[1]![1]![2] as string) as { ajuste: unknown; urgencia: unknown; cierre: unknown; completitud: number; explicacion: { insuficiente: { mensaje: string } } };
    expect([score.ajuste, score.urgencia, score.cierre]).toEqual([null, null, null]);
    expect(score.explicacion.insuficiente.mensaje).toContain("SENAL INSUFICIENTE");
    expect(score.completitud).toBeGreaterThan(0);
  });

  it("la regla de la base (23514) se traduce a 422", async () => {
    const { app } = montarCerebro([TAXONOMIA, { match: /save_prospecto_cerebro_for_superadmin/, respond: () => pgError("23514", "base_licitud_requerida: indica la base") }]);
    const res = await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "X", vertical: "restaurantes" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "regla_de_datos" });
  });

  it("base sin migrar: 503 honesto y la sesion sigue sana", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, session } = montarCerebro([
      { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => pgError("42883") },
      { match: /save_prospecto_cerebro_for_superadmin/, respond: () => pgError("42883") },
      { match: /select 1/, respond: () => [] },
    ]);
    expect((await enviar(app, "POST", "/superadmin/cerebro/prospectos", { empresa: "X", vertical: "restaurantes" })).status).toBe(503);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

describe("PUT /superadmin/cerebro/prospectos/:id", () => {
  it("editar recalcula y guarda el score (mismas senales, misma version de reglas: mismo score)", async () => {
    const calls: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const { app, session } = montarCerebro([TAXONOMIA, SIN_PERSONAS, { match: /save_prospecto_cerebro_for_superadmin/, respond: () => [filaProspecto({ subtipo: "taqueria", tamano: "s1" })] }]);
      const spy = vi.spyOn(session, "query");
      expect((await enviar(app, "PUT", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}`, { zona: "Centro" })).status).toBe(200);
      const guardados = spy.mock.calls.filter(([sql]) => /save_prospecto_cerebro_for_superadmin/.test(sql));
      expect(guardados[0]![1]).toEqual([CALLER, PROSPECTO_ID, JSON.stringify({ zona: "Centro" })]);
      calls.push([guardados[1]![1]![2] as string]);
    }
    expect(calls[1]).toEqual(calls[0]);
  });

  it("un id que no es uuid es 404 sin tocar la base; un prospecto inexistente (P0002) es 404 con sesion sana", async () => {
    const { app, session } = montarCerebro([TAXONOMIA, { match: /save_prospecto_cerebro_for_superadmin/, respond: () => pgError("P0002", "prospecto not found") }, { match: /select 1/, respond: () => [] }]);
    expect((await enviar(app, "PUT", "/superadmin/cerebro/prospectos/no-es-uuid", { zona: "x" })).status).toBe(404);
    expect((await enviar(app, "PUT", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}`, { zona: "x" })).status).toBe(404);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

describe("GET /superadmin/cerebro/prospectos", () => {
  it("devuelve los prospectos con sus scores y la taxonomia vigente", async () => {
    const { app } = montarCerebro([
      { match: /list_prospectos_cerebro_for_superadmin/, respond: () => [filaProspecto({ score_ajuste: 75, score_explicacion: { version: "reglas-v1/tax-1" }, score_version: "reglas-v1/tax-1", lat: "19.420000", lng: "-99.130000" })] },
      TAXONOMIA,
    ]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/prospectos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; prospectos: Array<Record<string, unknown>>; taxonomias: Array<{ vertical: string; precio: { texto: string } }> };
    expect(body.disponible).toBe(true);
    expect(body.prospectos[0]).toMatchObject({ scoreAjuste: 75, scoreVersion: "reglas-v1/tax-1", lat: 19.42, lng: -99.13, contactoLegado: false });
    expect(body.taxonomias[0]).toMatchObject({ vertical: "restaurantes", precio: { texto: "$799 MXN al mes por asiento (1 incluidos)" } });
  });

  it("base sin migrar: 200 con disponible=false y la lista de siempre (el flujo de hoy no se rompe), sesion sana", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, session } = montarCerebro([{ match: /list_prospectos_cerebro_for_superadmin/, respond: () => pgError("42883") }, { match: /select 1/, respond: () => [] }]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/prospectos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; mensaje: string; prospectos: Array<Record<string, unknown>>; taxonomias: unknown[] };
    expect(body.disponible).toBe(false);
    expect(body.mensaje).toContain("migración 0051");
    expect(body.prospectos[0]).toMatchObject({ id: PROSPECTO_ID, empresa: "Taquería Ficticia", scoreAjuste: null, baseLicitud: null });
    expect(body.taxonomias).toEqual([]);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("otro error de lectura no se disfraza de vacio: 500", async () => {
    const { app } = montarCerebro([{ match: /list_prospectos_cerebro_for_superadmin/, respond: () => pgError("42501") }]);
    expect((await enviar(app, "GET", "/superadmin/cerebro/prospectos")).status).toBe(500);
  });
});

describe("detalle y personas de contacto", () => {
  it("el detalle trae personas y linea de tiempo", async () => {
    const { app } = montarCerebro([
      { match: /list_prospecto_personas_for_superadmin/, respond: () => [{ id: "p1", nombre: "Ana Ficticia", cargo: "Gerente", canal: "correo", dato: "ana@example.com", origen: "sitio_web_oficial", confianza: "alta", evidencia_url: "https://example.com/equipo", creado_en: "2026-10-02T10:00:00.000Z" }] },
      { match: /list_prospecto_eventos_for_superadmin/, respond: () => [{ id: "e1", tipo: "cambio_etapa", actor_id: CALLER, detalle: { de: "nuevo", a: "contactado" }, costo_micro_usd: null, creado_en: "2026-10-02T11:00:00.000Z" }] },
    ]);
    const res = await enviar(app, "GET", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/detalle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: Array<{ evidenciaUrl: string }>; eventos: Array<{ tipo: string; detalle: unknown }> };
    expect(body.personas[0]!.evidenciaUrl).toBe("https://example.com/equipo");
    expect(body.eventos[0]).toMatchObject({ tipo: "cambio_etapa", detalle: { de: "nuevo", a: "contactado" } });
  });

  it("base sin migrar: el detalle responde 200 disponible=false", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montarCerebro([{ match: /list_prospecto_personas_for_superadmin/, respond: () => pgError("42883") }]);
    expect(await (await enviar(app, "GET", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/detalle`)).json()).toMatchObject({ disponible: false, personas: [], eventos: [] });
  });

  const persona = { nombre: "Ana Ficticia", cargo: "Gerente", canal: "correo", dato: "ana@example.com", origen: "sitio_web_oficial", confianza: "alta", evidenciaUrl: "https://example.com/equipo" };

  it("una persona SIN evidencia o con origen por patron se rechaza con 422 y no toca la base", async () => {
    const { app, session } = montarCerebro([]);
    const r1 = await enviar(app, "POST", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/personas`, { ...persona, evidenciaUrl: "" });
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({ code: "evidencia_requerida" });
    const r2 = await enviar(app, "POST", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/personas`, { ...persona, origen: "patron" });
    expect(r2.status).toBe(422);
    expect(session.calls).toEqual([]);
  });

  it("agrega la persona y recalcula el score del prospecto (suma a completitud y a cierre)", async () => {
    const { app, session } = montarCerebro([
      { match: /add_prospecto_persona_for_superadmin/, respond: () => [{ id: "p1", nombre: "Ana Ficticia", cargo: "Gerente", canal: "correo", dato: "ana@example.com", origen: "sitio_web_oficial", confianza: "alta", evidencia_url: "https://example.com/equipo", creado_en: "2026-10-02T10:00:00.000Z" }] },
      { match: /list_prospectos_cerebro_for_superadmin/, respond: () => [filaProspecto({ base_licitud: "fuente_publica_b2b" })] },
      { match: /list_prospecto_personas_for_superadmin/, respond: () => [{ id: "p1" }] },
      TAXONOMIA,
      { match: /save_prospecto_cerebro_for_superadmin/, respond: () => [filaProspecto({ base_licitud: "fuente_publica_b2b", score_completitud: 70 })] },
    ]);
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "POST", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/personas`, persona);
    expect(res.status).toBe(201);
    const guardado = spy.mock.calls.find(([sql]) => /save_prospecto_cerebro_for_superadmin/.test(sql))!;
    const score = JSON.parse(guardado[1]![2] as string) as { completitud: number };
    // subtipo 15 + tamano 15 + ciudad 10 + persona con evidencia 15 = 55
    expect(score.completitud).toBe(55);
  });

  it("el prospecto inexistente (P0002) es 404; la regla de la base (23514) es 422", async () => {
    const a = montarCerebro([{ match: /add_prospecto_persona_for_superadmin/, respond: () => pgError("P0002", "prospecto not found") }]);
    expect((await enviar(a.app, "POST", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/personas`, persona)).status).toBe(404);
    const b = montarCerebro([{ match: /add_prospecto_persona_for_superadmin/, respond: () => pgError("23514", "base_licitud_requerida: registra la base") }]);
    expect((await enviar(b.app, "POST", `/superadmin/cerebro/prospectos/${PROSPECTO_ID}/personas`, persona)).status).toBe(422);
  });
});
