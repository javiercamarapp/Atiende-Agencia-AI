// Alertas de WhatsApp al gerente (PM PR-3) con adaptadores FALSOS: nada sale a Meta; se afirma lo que SE HABRIA encolado y por que se degrada.
import { describe, expect, it } from "vitest";
import { InMemoryAlertasOutbox, InMemoryAlertasPanel, InMemoryAlertasRepositorio, barrerAlertas, decidirAlerta, dentroDeHorario, payloadAlerta } from "../src/index.ts";
import type { AlertaCandidata, AlertaSucursalConfig } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PROP = "00000000-0000-4000-8000-0000000000b1";
const OTRA = "00000000-0000-4000-8000-0000000000b2";
// Martes 2026-10-27 18:00 UTC = 12:00 en Merida (UTC-6).
const AHORA = new Date("2026-10-27T18:00:00Z");

function config(extra: Partial<AlertaSucursalConfig> = {}): AlertaSucursalConfig {
  return {
    organizationId: ORG,
    propertyId: PROP,
    sucursalNombre: "Tizon Centro",
    activa: true,
    phoneNumberIdAviso: "100200300400",
    plantillaNombre: "aviso_gerente",
    plantillaIdioma: "es_MX",
    plantillaAprobada: true,
    zonaHoraria: "America/Merida",
    horario: null,
    minutosSinRespuesta: 10,
    destinatarios: [{ telefono: "+52 999 123 4567", nombre: "Gerente" }],
    ...extra,
  };
}

function cand(extra: Partial<AlertaCandidata> = {}): AlertaCandidata {
  return { tipo: "escalada", clave: "h1", entidadId: "00000000-0000-4000-8000-0000000000c1", organizationId: ORG, propertyId: PROP, desde: new Date("2026-10-27T17:58:00Z"), minutos: 2, ...extra };
}

function setup(c: AlertaSucursalConfig | null = config()) {
  const repo = new InMemoryAlertasRepositorio();
  if (c) repo.configs.set(c.propertyId, c);
  const outbox = new InMemoryAlertasOutbox();
  const panel = new InMemoryAlertasPanel();
  return { repo, outbox, panel, correr: (ahora = AHORA) => barrerAlertas({ repo, outbox, panel }, ahora) };
}

describe("decidirAlerta (pura)", () => {
  it("con todo configurado envia a los destinatarios normalizados y sin repetir", () => {
    const d = decidirAlerta(config({ destinatarios: [{ telefono: "9991234567" }, { telefono: "+52 999 123 4567" }, { telefono: "+5219995550000" }] }), AHORA);
    expect(d.accion).toBe("enviar");
    if (d.accion === "enviar") expect(d.destinatarios.length).toBe(2);
  });
  it.each([
    [{ activa: false }, "alertas_apagadas"],
    [{ destinatarios: [] }, "sin_destinatarios"],
    [{ destinatarios: [{ telefono: "abc" }] }, "destinatarios_invalidos"],
    [{ phoneNumberIdAviso: null }, "sin_numero_aviso"],
    [{ plantillaNombre: null }, "sin_plantilla"],
    [{ plantillaAprobada: false }, "plantilla_no_aprobada"],
  ] as const)("degrada al panel con el motivo %j", (extra, motivo) => {
    expect(decidirAlerta(config(extra), AHORA)).toEqual({ accion: "panel", motivo });
  });
  it("fuera de horario degrada con fuera_de_horario; dentro de horario envia", () => {
    const horario = [{ dias: [1, 2, 3, 4, 5], desde: "13:00", hasta: "23:00" }];
    expect(decidirAlerta(config({ horario }), AHORA)).toEqual({ accion: "panel", motivo: "fuera_de_horario" }); // 12:00 local
    expect(decidirAlerta(config({ horario }), new Date("2026-10-27T20:00:00Z")).accion).toBe("enviar"); // 14:00 local
  });
});

describe("dentroDeHorario", () => {
  it("ventana que cruza la medianoche pertenece al dia en que empieza", () => {
    const h = [{ dias: [5], desde: "20:00", hasta: "02:00" }]; // viernes 20:00 a sabado 02:00
    expect(dentroDeHorario(h, "America/Merida", new Date("2026-10-31T04:00:00Z"))).toBe(true); // vie 22:00 local
    expect(dentroDeHorario(h, "America/Merida", new Date("2026-10-31T07:00:00Z"))).toBe(true); // sab 01:00 local
    expect(dentroDeHorario(h, "America/Merida", new Date("2026-10-31T09:00:00Z"))).toBe(false); // sab 03:00 local
    expect(dentroDeHorario(h, "America/Merida", new Date("2026-10-27T04:00:00Z"))).toBe(false); // martes
  });
  it("zona u horario ilegible: ante la duda SE AVISA", () => {
    expect(dentroDeHorario([{ dias: [0], desde: "09:00", hasta: "10:00" }], "No/Existe", AHORA)).toBe(true);
    expect(dentroDeHorario([{ dias: [0], desde: "9", hasta: "x" }], "America/Merida", AHORA)).toBe(true);
    expect(dentroDeHorario(null, "America/Merida", AHORA)).toBe(true);
  });
});

describe("barrerAlertas", () => {
  it("encola UNA plantilla por destinatario, solo-plantilla, con el numero de aviso de la sucursal", async () => {
    const t = setup();
    t.repo.lista.push(cand());
    const r = await t.correr();
    expect(r).toMatchObject({ disponible: true, encoladas: 1, degradadas: 0, errores: 0 });
    const [item] = [...t.outbox.enviados.values()];
    expect(item?.organizationId).toBe(ORG);
    expect(item?.payload).toMatchObject({ phone_number_id: "100200300400", solo_plantilla: true, critico: true, template: { name: "aviso_gerente", language: "es_MX" } });
    expect((item?.payload.template as { params: string[] }).params[1]).toBe("Tizon Centro");
    expect(item?.payload.to).toBe("5219991234567");
  });

  it("es idempotente: dos barridos de la misma escalacion no avisan dos veces", async () => {
    const t = setup();
    t.repo.lista.push(cand());
    await t.correr();
    const r2 = await t.correr();
    expect(t.outbox.enviados.size).toBe(1);
    expect(r2.encoladas).toBe(0);
  });

  it("sin numero de aviso o sin plantilla: NO encola, degrada al panel UNA vez y registra el motivo", async () => {
    const t = setup(config({ phoneNumberIdAviso: null }));
    t.repo.lista.push(cand());
    const r = await t.correr();
    await t.correr();
    expect(t.outbox.enviados.size).toBe(0);
    expect(r.degradadas).toBe(1);
    expect(t.panel.degradadas).toHaveLength(1);
    expect(t.panel.degradadas[0]?.motivo).toBe("sin_numero_aviso");
    expect(t.repo.registros).toEqual([expect.objectContaining({ estado: "degradada_panel", motivo: "sin_numero_aviso", destinoHash: "" })]);
  });

  it("sucursal con alertas apagadas o sin fila: no hay candidatas y no pasa nada", async () => {
    const t = setup(config({ activa: false }));
    t.repo.lista.push(cand());
    expect(await t.correr()).toMatchObject({ encoladas: 0, degradadas: 0 });
    const u = setup(null);
    u.repo.lista.push(cand());
    expect(await u.correr()).toMatchObject({ encoladas: 0, degradadas: 0, sinConfig: 0 });
  });

  it("cada sucursal usa SU numero y SUS destinatarios (no se cruzan)", async () => {
    const t = setup();
    t.repo.configs.set(OTRA, config({ propertyId: OTRA, sucursalNombre: "Tizon Norte", phoneNumberIdAviso: "999888777666", destinatarios: [{ telefono: "9990000001" }] }));
    t.repo.lista.push(cand({ clave: "h1" }), cand({ clave: "h2", propertyId: OTRA }));
    await t.correr();
    const pagos = [...t.outbox.enviados.values()].map((e) => [e.payload.phone_number_id, e.payload.to]);
    expect(pagos).toContainEqual(["100200300400", "5219991234567"]);
    expect(pagos).toContainEqual(["999888777666", "529990000001"]);
    expect(t.outbox.enviados.size).toBe(2);
  });

  it("cliente sin respuesta en una conversacion: la campana siempre se entera, con o sin WhatsApp", async () => {
    const t = setup(config({ plantillaNombre: null }));
    t.repo.lista.push(cand({ tipo: "sin_respuesta", clave: "c:conv1:20261027" }));
    await t.correr();
    expect(t.panel.sinRespuestaAvisos).toHaveLength(1);
    expect(t.panel.degradadas[0]?.motivo).toBe("sin_plantilla");
    expect(t.outbox.enviados.size).toBe(0);
  });

  it("base sin la migracion: disponible false y no rompe", async () => {
    const t = setup();
    t.repo.noDisponible = true;
    expect(await t.correr()).toEqual({ disponible: false, encoladas: 0, degradadas: 0, sinConfig: 0, errores: 0 });
  });

  it("una alerta que falla no detiene las demas", async () => {
    const t = setup();
    t.repo.lista.push(cand({ clave: "h1" }), cand({ clave: "h2" }));
    let n = 0;
    const original = t.outbox.encolar.bind(t.outbox);
    t.outbox.encolar = async (...a) => {
      if (n++ === 0) throw new Error("boom");
      return original(...a);
    };
    const r = await barrerAlertas({ repo: t.repo, outbox: t.outbox, panel: t.panel }, AHORA);
    expect(r.errores).toBe(1);
    expect(r.encoladas).toBe(1);
  });

  it("payloadAlerta nunca lleva saltos de linea en los parametros", () => {
    const p = payloadAlerta(config({ sucursalNombre: "Tizon\nCentro" }), cand(), "5219991234567");
    for (const v of (p.template as { params: string[] }).params) expect(v).not.toMatch(/[\r\n\t]/);
  });
});
