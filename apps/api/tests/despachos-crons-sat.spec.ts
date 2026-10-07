// D-26/D-27/D-28 -- crons de despachos (estatus SAT de CFDI, descarga 69-B, barrido de vencimientos) y "Verificar en el SAT".
// SIN llamadas al SAT: el puerto y la fuente 69-B son dobles; el repositorio de sistema es el doble en memoria con la semantica de la
// migracion 022. Cubre: 401 sin secreto, kill switch, idempotencia (dos corridas no duplican ni notifican dos veces), timeout del SAT
// que deja 'pendiente', cancelacion notificada una sola vez, tope por corrida, fallo aislado por unidad y base sin migrar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { InMemoryCronSatRepository, validarFichaCliente } from "@atiende/domain-despachos";
import type { ConsultaCfdiSatInput, ConsultaCfdiSatPort, ConsultaCfdiSatResultado } from "@atiende/domain-despachos";
import { Efos69bDescargaError, FixtureEfos69bSource } from "@atiende/worker";
import type { Efos69bSource } from "@atiende/worker";
import { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";
import type { EmisionRegistrada } from "./support/emisiones.ts";

const VIGENTE: ConsultaCfdiSatResultado = { consultado: true, estado: "vigente", esCancelable: "Cancelable sin aceptación", estatusCancelacion: null, codigoEstatus: "S - Comprobante obtenido satisfactoriamente.", validacionEfos: "200" };
const CANCELADO: ConsultaCfdiSatResultado = { consultado: true, estado: "cancelado", esCancelable: "No cancelable", estatusCancelacion: "Cancelado sin aceptación", codigoEstatus: null, validacionEfos: null };
const TIMEOUT: ConsultaCfdiSatResultado = { consultado: false, estado: "pendiente", esCancelable: null, estatusCancelacion: null, codigoEstatus: null, validacionEfos: null, motivo: "timeout" };

class SatFalso implements ConsultaCfdiSatPort {
  readonly llamadas: ConsultaCfdiSatInput[] = [];
  constructor(public respuesta: (i: ConsultaCfdiSatInput) => ConsultaCfdiSatResultado | Promise<ConsultaCfdiSatResultado>) {}
  async consultar(i: ConsultaCfdiSatInput): Promise<ConsultaCfdiSatResultado> {
    this.llamadas.push(i);
    return this.respuesta(i);
  }
}

const SECRETO = (ctx: DespachosTestContext) => ({ method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
const CRON_SAT = "/internal/despachos/cfdi-estatus-sat";
const CRON_EFOS = "/internal/despachos/efos-69b/descarga";
const CRON_VENC = "/internal/despachos/vencimientos-barrido";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});
afterEach(() => {
  vi.useRealTimers();
});

function armar(extra: Partial<AppDeps> = {}) {
  const cron = new InMemoryCronSatRepository();
  const sat = new SatFalso(() => VIGENTE);
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, cronSatRepo: () => cron, consultaCfdiSat: sat, ...extra });
  return { cron, sat, emisiones, app: buildApp(deps), deps };
}
function sembrarCfdi(cron: InMemoryCronSatRepository, n: number, extra: Partial<Parameters<InMemoryCronSatRepository["sembrarCfdi"]>[0]> = {}) {
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  cron.sembrarCfdi({ invoiceId: id, organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`, rfcEmisor: "OTR010101OT1", rfcReceptor: "CLI010101CL1", total: 1160, ...extra });
  return id;
}
const cancelados = (e: readonly EmisionRegistrada[]) => e.filter((x) => x.evento === "despachos.cfdi.cancelado");

describe("los 3 crons: secreto y kill switch", () => {
  it.each([CRON_SAT, CRON_EFOS, CRON_VENC])("%s responde 401 sin secreto (GET y POST) y con secreto incorrecto", async (ruta) => {
    const { app } = armar();
    expect((await app.request(ruta, { method: "POST" })).status).toBe(401);
    expect((await app.request(ruta, { method: "GET" })).status).toBe(401);
    expect((await app.request(ruta, { method: "POST", headers: { "x-atiende-internal-secret": "incorrecto" } })).status).toBe(401);
  });

  it.each([CRON_SAT, CRON_EFOS, CRON_VENC])("%s con el kill switch responde {skipped:'kill_switch'} y no toca nada", async (ruta) => {
    const { deps, cron, sat } = armar();
    sembrarCfdi(cron, 1);
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: ruta }]);
    const app = buildApp({ ...deps, platformSwitchGuard: guard });
    const res = await app.request(ruta, SECRETO(ctx));
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect(sat.llamadas).toHaveLength(0);
    expect(cron.estadoCfdi("00000000-0000-0000-0000-000000000001").estadoSat).toBe("pendiente");
  });
});

describe(`POST ${CRON_SAT}`, () => {
  it("consulta los CFDI, guarda el estado y es idempotente: una segunda corrida no reconsulta ni notifica", async () => {
    const { app, cron, sat, emisiones } = armar();
    const a = sembrarCfdi(cron, 1);
    const b = sembrarCfdi(cron, 2);
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "ok", revisados: 2, vigentes: 2, cancelados: 0, nuevos_cancelados: 0 });
    expect(cron.estadoCfdi(a).estadoSat).toBe("vigente");
    expect(cron.estadoCfdi(b).verificadoEn).not.toBeNull();
    expect(sat.llamadas).toHaveLength(2);
    expect(sat.llamadas[0]).toMatchObject({ rfcEmisor: "OTR010101OT1", rfcReceptor: "CLI010101CL1", total: 1160 });

    const segunda = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(segunda).toMatchObject({ revisados: 0 });
    expect(sat.llamadas).toHaveLength(2);
    expect(emisiones).toHaveLength(0);
  });

  it("un timeout del SAT deja el CFDI en 'pendiente' (jamas 'vigente'), anota el intento y no lo reconsulta de inmediato", async () => {
    const { app, cron, sat } = armar();
    const id = sembrarCfdi(cron, 1);
    sat.respuesta = () => TIMEOUT;
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, revisados: 1, vigentes: 0, sin_concluir: 1 });
    expect(cron.estadoCfdi(id)).toMatchObject({ estadoSat: "pendiente", verificadoEn: null });
    expect(cron.estadoCfdi(id).intentadoEn).not.toBeNull();
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(sat.llamadas).toHaveLength(1);
  });

  it("un timeout NO pisa un estado ya verificado", async () => {
    const { app, cron, sat } = armar();
    const id = sembrarCfdi(cron, 1, { estadoSat: "vigente" });
    sat.respuesta = () => TIMEOUT;
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(cron.estadoCfdi(id).estadoSat).toBe("vigente");
  });

  it("una cancelacion notifica UNA sola vez (critica, enlace al detalle del CFDI) y el CFDI cancelado ya no se reconsulta", async () => {
    const { app, cron, sat, emisiones } = armar();
    const id = sembrarCfdi(cron, 1, { estadoSat: "vigente" });
    sat.respuesta = () => CANCELADO;
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ cancelados: 1, nuevos_cancelados: 1 });
    expect(cancelados(emisiones)).toHaveLength(1);
    expect(cancelados(emisiones)[0]).toMatchObject({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      severidad: "critica",
      categoria: "fiscal",
      enlace: `/despachos/{orgSlug}/cfdi/${id}`,
      dedupeKey: `despachos.cfdi.cancelado:${id}`,
      roles: ["contador"],
    });
    expect(cancelados(emisiones)[0]!.titulo + (cancelados(emisiones)[0]!.cuerpo ?? "")).not.toMatch(/@|\d{7,}|OTR010101/);

    await app.request(CRON_SAT, SECRETO(ctx));
    expect(sat.llamadas).toHaveLength(1);
    expect(cancelados(emisiones)).toHaveLength(1);
  });

  it("un CFDI que ya estaba cancelado nunca vuelve a notificar aunque el SAT lo reporte otra vez", async () => {
    const { app, cron, emisiones } = armar();
    sembrarCfdi(cron, 1, { estadoSat: "cancelado" });
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(emisiones).toHaveLength(0);
  });

  it("respeta el tope por corrida (60) y atiende primero los mas antiguos; el resto queda para la siguiente", async () => {
    const { app, cron, sat } = armar();
    // 5 clientes con 13 CFDI cada uno: ninguno rebasa el tope por cliente (15), asi que manda el tope global.
    for (let i = 1; i <= 65; i++) sembrarCfdi(cron, i, { propertyId: `cliente-${i % 5}` });
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ revisados: 60 });
    expect(sat.llamadas).toHaveLength(60);
    const folios = new Set(sat.llamadas.map((l) => l.folioFiscal));
    expect(folios.has("11111111-2222-3333-4444-000000000001")).toBe(true);
    expect(folios.has("11111111-2222-3333-4444-000000000065")).toBe(false);
    const segunda = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(segunda).toMatchObject({ revisados: 5 });
  });

  it("tope por cliente: un cliente con muchos CFDI no acapara la cuota de la plataforma (15 por cliente)", async () => {
    const { app, cron, sat } = armar();
    for (let i = 1; i <= 40; i++) sembrarCfdi(cron, i, { propertyId: "cliente-grande" });
    for (let i = 41; i <= 43; i++) sembrarCfdi(cron, i, { propertyId: "cliente-chico" });
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ revisados: 18 });
    expect(sat.llamadas.filter((l) => l.folioFiscal.endsWith("0041") || l.folioFiscal.endsWith("0042") || l.folioFiscal.endsWith("0043"))).toHaveLength(3);
  });

  it("persiste el detalle de cancelacion del SAT (es_cancelable, estatus, codigo_estatus y validacion_efos)", async () => {
    const { app, cron, sat } = armar();
    const id = sembrarCfdi(cron, 1);
    sat.respuesta = () => VIGENTE;
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(cron.estadoCfdi(id).detalle).toEqual({ esCancelable: "Cancelable sin aceptación", estatusCancelacion: null, codigoEstatus: "S - Comprobante obtenido satisfactoriamente.", validacionEfos: "200" });
  });

  it("cancelacion «En proceso»: avisa UNA vez, se reconsulta pasadas 20 h hasta resolverse y no re-avisa", async () => {
    const { app, cron, sat, emisiones } = armar();
    let ahora = Date.now();
    cron.ahora = () => ahora;
    const id = sembrarCfdi(cron, 1);
    sat.respuesta = () => ({ ...VIGENTE, esCancelable: "Cancelable con aceptación", estatusCancelacion: "En proceso" });
    const primera = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(primera).toMatchObject({ revisados: 1, cancelaciones_en_proceso: 1 });
    const enProceso = (e: readonly EmisionRegistrada[]) => e.filter((x) => x.evento === "despachos.cfdi.cancelacion_en_proceso");
    expect(enProceso(emisiones)).toHaveLength(1);
    expect(enProceso(emisiones)[0]).toMatchObject({ dedupeKey: `despachos.cfdi.cancelacion_en_proceso:${id}`, enlace: `/despachos/{orgSlug}/cfdi/${id}`, severidad: "atencion" });
    expect((enProceso(emisiones)[0]!.titulo + (enProceso(emisiones)[0]!.cuerpo ?? ""))).not.toMatch(/@|\d{7,}|OTR010101|CLI010101/);

    // Antes de 20 h no se reconsulta; despues si, y como sigue «En proceso» no vuelve a avisar.
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(sat.llamadas).toHaveLength(1);
    ahora += 21 * 3_600_000;
    const tercera = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(tercera).toMatchObject({ revisados: 1, cancelaciones_en_proceso: 0 });
    expect(sat.llamadas).toHaveLength(2);
    expect(enProceso(emisiones)).toHaveLength(1);

    // El receptor acepta: el SAT reporta cancelado -> aviso de cancelado (otra clave de catalogo) y ya no se consulta.
    sat.respuesta = () => CANCELADO;
    ahora += 21 * 3_600_000;
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(cancelados(emisiones)).toHaveLength(1);
    ahora += 400 * 86_400_000;
    await app.request(CRON_SAT, SECRETO(ctx));
    expect(sat.llamadas).toHaveLength(3);
  });

  it("fuera de la ventana de ejercicios un CFDI ya consultado no se reconsulta; uno que nunca se consulto si", async () => {
    const { app, cron, sat } = armar();
    const ahora = Date.now();
    cron.ahora = () => ahora;
    const viejoConsultado = sembrarCfdi(cron, 1, { fecha: "2019-03-10", intentadoEn: ahora - 30 * 86_400_000, estadoSat: "vigente" });
    const viejoNunca = sembrarCfdi(cron, 2, { fecha: "2019-03-11" });
    const reciente = sembrarCfdi(cron, 3, { fecha: new Date(ahora - 10 * 86_400_000).toISOString().slice(0, 10), intentadoEn: ahora - 10 * 86_400_000, estadoSat: "vigente" });
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ revisados: 2 });
    const folios = sat.llamadas.map((l) => l.folioFiscal);
    expect(folios).toContain(`11111111-2222-3333-4444-${viejoNunca.slice(-12)}`);
    expect(folios).toContain(`11111111-2222-3333-4444-${reciente.slice(-12)}`);
    expect(folios).not.toContain(`11111111-2222-3333-4444-${viejoConsultado.slice(-12)}`);
  });

  it("prioridad: primero los nunca consultados, luego la cancelacion en proceso y al final los vigentes de la ventana", async () => {
    const { app, cron, sat, deps } = armar();
    const ahora = Date.now();
    cron.ahora = () => ahora;
    const hoyIso = (dias: number) => new Date(ahora - dias * 86_400_000).toISOString().slice(0, 10);
    const vigenteViejo = sembrarCfdi(cron, 1, { fecha: hoyIso(200), intentadoEn: ahora - 20 * 86_400_000, estadoSat: "vigente", propertyId: "p-a" });
    const enProceso = sembrarCfdi(cron, 2, { fecha: hoyIso(10), intentadoEn: ahora - 30 * 3_600_000, estadoSat: "vigente", estatusCancelacion: "En proceso", propertyId: "p-b" });
    const nunca = sembrarCfdi(cron, 3, { fecha: hoyIso(5), propertyId: "p-c" });
    const lista = await cron.listarCfdiPendientesEstatusSat(10, 6, 2, 15);
    expect(lista!.map((c) => c.invoiceId)).toEqual([nunca, enProceso, vigenteViejo]);
    expect(lista!.map((c) => c.prioridad)).toEqual([0, 1, 3]);
    void app; void sat; void deps;
  });

  it("base con la migracion 022 pero SIN la 027: el barrido sigue (orden anterior, sin detalle) y no falla", async () => {
    const { app, cron, sat } = armar();
    cron.migracion027 = false;
    const id = sembrarCfdi(cron, 1);
    sat.respuesta = () => ({ ...VIGENTE, estatusCancelacion: "En proceso" });
    const body = (await (await app.request(CRON_SAT, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "ok", revisados: 1, cancelaciones_en_proceso: 0 });
    expect(cron.estadoCfdi(id)).toMatchObject({ estadoSat: "vigente" });
    expect(cron.estadoCfdi(id).detalle.estatusCancelacion).toBeNull();
  });

  it("un CFDI que falla al registrarse no frena a los demas: 200 con ok:false y el latido queda en error", async () => {
    const { app, cron, deps } = armar();
    const malo = sembrarCfdi(cron, 1);
    const bueno = sembrarCfdi(cron, 2);
    const original = cron.registrarEstatusSatSistema.bind(cron);
    cron.registrarEstatusSatSistema = async (id, estado) => {
      if (id === malo) throw Object.assign(new Error("falla simulada"), { code: "XX000" });
      return original(id, estado);
    };
    const salud = deps.saludRepo as InMemorySaludRepository;
    salud.addPlatformSuperadmin("admin-1");
    const res = await app.request(CRON_SAT, SECRETO(ctx));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { invoice_id: string }[] };
    expect(body.ok).toBe(false);
    expect(body.failures.map((f) => f.invoice_id)).toEqual([malo]);
    expect(cron.estadoCfdi(bueno).estadoSat).toBe("vigente");
    expect((await salud.listCronHeartbeatsForSuperadmin("admin-1")).find((l) => l.cronName === CRON_SAT)).toMatchObject({ lastStatus: "error" });
  });

  it("REGLA DURA: base sin la migracion 022 -> status no_disponible (200), sin consultar al SAT", async () => {
    const { app, cron, sat } = armar();
    sembrarCfdi(cron, 1);
    cron.disponible = false;
    const res = await app.request(CRON_SAT, SECRETO(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "no_disponible", revisados: 0 });
    expect(sat.llamadas).toHaveLength(0);
  });
});

describe(`POST ${CRON_EFOS}`, () => {
  const CSV = `Listado completo\nNo,RFC,Nombre del Contribuyente,Situación del contribuyente\n1,OTR010101OT1,"EMISOR FANTASMA SA",Definitivo\n`;
  const periodo = () => hoyFechaNegocio().slice(0, 7);

  it("descarga, ingiere y alerta cada CFDI afectado (clave = id del CFDI); la misma edicion otra vez es 'sin_cambios' y no alerta de nuevo", async () => {
    const source = new FixtureEfos69bSource({ [periodo()]: CSV });
    const { app, cron, emisiones } = armar({ efos69bSource: source });
    cron.sembrarEfosAfectado({ invoiceId: "00000000-0000-0000-0000-0000000000a1", organizationId: ctx.organizationId, propertyId: ctx.propertyId, situacion: "definitivo" });
    cron.sembrarEfosAfectado({ invoiceId: "00000000-0000-0000-0000-0000000000a2", organizationId: ctx.organizationId, propertyId: ctx.propertyId, situacion: "definitivo" });

    const primera = (await (await app.request(CRON_EFOS, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(primera).toMatchObject({ ok: true, status: "ok", resultado: "insertada", filas: 1, alertas_emitidas: 2 });
    expect(emisiones.map((e) => e.dedupeKey)).toEqual(["despachos.efos.alerta:00000000-0000-0000-0000-0000000000a1", "despachos.efos.alerta:00000000-0000-0000-0000-0000000000a2"]);
    expect(emisiones[0]).toMatchObject({ severidad: "critica", enlace: "/despachos/{orgSlug}/cfdi", roles: ["contador", "auditor"] });

    const segunda = (await (await app.request(CRON_EFOS, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(segunda).toMatchObject({ resultado: "sin_cambios", alertas_emitidas: 0 });
    expect(emisiones).toHaveLength(2);
  });

  it("una edicion corregida del mismo periodo reemplaza a la anterior ('reemplazada')", async () => {
    const mismoPeriodo = periodo();
    const { app } = armar({ efos69bSource: new FixtureEfos69bSource({ [mismoPeriodo]: CSV }) });
    await app.request(CRON_EFOS, SECRETO(ctx));
    const { app: app2 } = armar({ efos69bSource: new FixtureEfos69bSource({ [mismoPeriodo]: CSV.replace("Definitivo", "Presunto") }) });
    const body = (await (await app2.request(CRON_EFOS, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, resultado: "reemplazada" });
  });

  it("si la descarga falla (red/timeout/archivo gigante) responde 200 con ok:false y el motivo, y no alerta nada", async () => {
    const fuente: Efos69bSource = {
      obtenerListado: async () => {
        throw new Efos69bDescargaError("demasiado_grande", "El archivo supera el tope.");
      },
    };
    const { app, emisiones } = armar({ efos69bSource: fuente });
    const res = await app.request(CRON_EFOS, SECRETO(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "fallo", resultado: null, alertas_emitidas: 0, detalle: "El archivo supera el tope." });
    // Solo el aviso de plataforma del cron que fallo (superadmin.cron.fallo, de withHeartbeat); ninguna alerta de CFDI.
    expect(emisiones.filter((e) => e.evento.startsWith("despachos."))).toHaveLength(0);
  });

  it("un archivo que no es la lista 69-B (formato invalido) se rechaza entero: nada se ingiere ni se alerta", async () => {
    const { app, cron, emisiones } = armar({ efos69bSource: new FixtureEfos69bSource({ [periodo()]: "<html>pagina de error del SAT</html>" }) });
    cron.sembrarEfosAfectado({ invoiceId: "00000000-0000-0000-0000-0000000000a1", organizationId: ctx.organizationId, propertyId: ctx.propertyId, situacion: "definitivo" });
    const body = (await (await app.request(CRON_EFOS, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, status: "fallo", resultado: null });
    expect(String(body.detalle)).toMatch(/archivo invalido/);
    expect(emisiones.filter((e) => e.evento.startsWith("despachos."))).toHaveLength(0);
  });

  it("REGLA DURA: sin la migracion 022 la ingesta corre pero las alertas quedan 'no_disponible' (200, sin emitir)", async () => {
    const { app, cron, emisiones } = armar({ efos69bSource: new FixtureEfos69bSource({ [periodo()]: CSV }) });
    cron.disponible = false;
    const body = (await (await app.request(CRON_EFOS, SECRETO(ctx))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "no_disponible", alertas_emitidas: 0 });
    expect(emisiones).toHaveLength(0);
  });
});

describe(`POST ${CRON_VENC}`, () => {
  function conCliente() {
    const armado = armar();
    armado.cron.sembrarCliente({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, regimenes: ["601"], zonaHoraria: "America/Mexico_City" });
    return armado;
  }

  it("genera las obligaciones del periodo en curso por cliente con ficha, sin duplicar en una segunda corrida", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    const { app, cron } = conCliente();
    const a = (await (await app.request(CRON_VENC, SECRETO(ctx))).json()) as { creados: number; clientes: number; ok: boolean };
    expect(a).toMatchObject({ ok: true, clientes: 1 });
    expect(a.creados).toBeGreaterThan(0);
    const total = cron.vencimientosDe(ctx.propertyId).length;
    expect(cron.vencimientosDe(ctx.propertyId).every((v) => v.periodo === "2026-10")).toBe(true);
    const b = (await (await app.request(CRON_VENC, SECRETO(ctx))).json()) as { creados: number };
    expect(b.creados).toBe(0);
    expect(cron.vencimientosDe(ctx.propertyId)).toHaveLength(total);
  });

  it("escala lo que vence hoy y avisa UNA vez por property y dia; la segunda corrida no escala ni notifica; al dia siguiente avisa 'vencido'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, cron, emisiones } = conCliente();
    const { id } = await cron.upsertVencimientoSistema(ctx.propertyId, { tipo: "ISR", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "critica" });

    vi.setSystemTime(new Date("2026-11-17T18:00:00Z"));
    const a = (await (await app.request(CRON_VENC, SECRETO(ctx))).json()) as { escalados: number };
    expect(a.escalados).toBe(1);
    expect(cron.escalamientos.filter((e) => e.deadlineId === id)).toHaveLength(1);
    const proximos = emisiones.filter((e) => e.evento === "despachos.fiscal.vencimiento_proximo");
    expect(proximos).toHaveLength(1);
    expect(proximos[0]).toMatchObject({ propertyId: ctx.propertyId, cuerpo: "Por vencer hoy o mañana: 1.", dedupeKey: `despachos.fiscal.vencimiento_proximo:${ctx.propertyId}:2026-11-17`, roles: ["contador"], enlace: "/despachos/{orgSlug}/vencimientos" });

    const b = (await (await app.request(CRON_VENC, SECRETO(ctx))).json()) as { escalados: number; ya_escalados: number };
    expect(b.escalados).toBe(0);
    expect(emisiones.filter((e) => e.evento === "despachos.fiscal.vencimiento_proximo")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-11-18T18:00:00Z"));
    await app.request(CRON_VENC, SECRETO(ctx));
    const vencidos = emisiones.filter((e) => e.evento === "despachos.fiscal.vencimiento_vencido");
    expect(vencidos).toHaveLength(1);
    expect(vencidos[0]).toMatchObject({ severidad: "critica", dedupeKey: `despachos.fiscal.vencimiento_vencido:${ctx.propertyId}:2026-11-18` });
  });

  it("un vencimiento completado no se escala ni notifica", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, cron, emisiones } = conCliente();
    const { id } = await cron.upsertVencimientoSistema(ctx.propertyId, { tipo: "ISR", periodo: "2026-10", fechaLimite: "2026-11-17", prioridad: "critica" });
    cron.completarVencimiento(id);
    vi.setSystemTime(new Date("2026-11-17T18:00:00Z"));
    await app.request(CRON_VENC, SECRETO(ctx));
    expect(emisiones.filter((e) => e.evento.startsWith("despachos.fiscal.vencimiento_"))).toHaveLength(0);
  });

  it("un cliente que falla no frena a los demas: 200 con ok:false", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    const { app, cron } = conCliente();
    cron.sembrarCliente({ organizationId: ctx.organizationId, propertyId: "00000000-0000-0000-0000-0000000000f2", regimenes: ["601"], zonaHoraria: null });
    const original = cron.upsertVencimientoSistema.bind(cron);
    cron.upsertVencimientoSistema = async (propertyId, nuevo) => {
      if (propertyId === ctx.propertyId) throw Object.assign(new Error("falla simulada"), { code: "XX000" });
      return original(propertyId, nuevo);
    };
    const res = await app.request(CRON_VENC, SECRETO(ctx));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failures: { property_id: string }[]; creados: number };
    expect(body.ok).toBe(false);
    expect(body.failures.map((f) => f.property_id)).toEqual([ctx.propertyId]);
    expect(body.creados).toBeGreaterThan(0);
  });

  it("REGLA DURA: base sin la migracion 022 -> status no_disponible (200)", async () => {
    const { app, cron } = conCliente();
    cron.disponible = false;
    const res = await app.request(CRON_VENC, SECRETO(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "no_disponible", clientes: 0 });
  });
});

describe("POST /despachos/:propertyId/cfdi/:invoiceId/verificar-estatus-sat", () => {
  const CLIENTE_RFC = "CLI010101CL1";
  const OTRO_RFC = "OTR010101OT1";
  const UUID = "11111111-2222-3333-4444-555555555555";
  const XML = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-07-01T10:00:00" Sello="AbCdEf1234==" FormaPago="03" NoCertificado="00001000000504465028" Certificado="MIIF" SubTotal="1000.00" Moneda="MXN" Total="1160.00" TipoDeComprobante="I" Exportacion="01" MetodoPago="PPD" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="${OTRO_RFC}" Nombre="Emisor de Prueba SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${CLIENTE_RFC}" Nombre="Receptor de Prueba" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${UUID}" FechaTimbrado="2026-07-01T10:05:00" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/></cfdi:Complemento>
</cfdi:Comprobante>`;

  async function crearCfdi(deps: AppDeps): Promise<string> {
    const f = validarFichaCliente({ rfc: CLIENTE_RFC, razonSocial: "Cliente SA", regimenesFiscales: ["601"], cpFiscal: "06600" });
    if (!f.ok) throw new Error("ficha invalida");
    await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
    const res = await buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/xml", "content-length": String(new TextEncoder().encode(XML).byteLength) }, body: XML });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  const verificar = (app: ReturnType<typeof buildApp>, id: string, token: string | null, propertyId = ctx.propertyId) =>
    app.request(`/despachos/${propertyId}/cfdi/${id}/verificar-estatus-sat`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("sin token 401; auditor y solo lectura 403; una property ajena 403", async () => {
    const { app, deps } = armar();
    const id = await crearCfdi(deps);
    expect((await verificar(app, id, null)).status).toBe(401);
    expect((await verificar(app, id, ctx.staff.auditor.token)).status).toBe(403);
    expect((await verificar(app, id, ctx.staff.readonly.token)).status).toBe(403);
    expect((await verificar(app, id, ctx.staff.contador.token, "00000000-0000-0000-0000-0000000000ee")).status).toBe(403);
  });

  it("vigente: consulta con los datos del CFDI, guarda el estado y la fecha de verificacion", async () => {
    const { app, deps, sat } = armar();
    const id = await crearCfdi(deps);
    const res = await verificar(app, id, ctx.staff.contador.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consultado: boolean; estadoSat: string; estadoSatVerificadoEn: string | null; esCancelable: string };
    expect(body).toMatchObject({ consultado: true, estadoSat: "vigente", esCancelable: "Cancelable sin aceptación" });
    expect(body.estadoSatVerificadoEn).not.toBeNull();
    expect(sat.llamadas).toEqual([{ rfcEmisor: OTRO_RFC, rfcReceptor: CLIENTE_RFC, total: 1160, folioFiscal: UUID }]);
  });

  it("cancelacion «En proceso»: guarda el detalle (visible en el detalle del CFDI), avisa una sola vez y no re-avisa al repetir", async () => {
    const { app, deps, sat, emisiones } = armar();
    const id = await crearCfdi(deps);
    sat.respuesta = () => ({ ...VIGENTE, esCancelable: "Cancelable con aceptación", estatusCancelacion: "En proceso" });
    const body = (await (await verificar(app, id, ctx.staff.contador.token)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ consultado: true, estadoSat: "vigente", estatusCancelacion: "En proceso", codigoEstatus: "S - Comprobante obtenido satisfactoriamente.", validacionEfos: "200" });
    const detalle = (await (await app.request(`/despachos/${ctx.propertyId}/cfdi/${id}`, authedJson(ctx.staff.admin.token))).json()) as Record<string, unknown>;
    expect(detalle).toMatchObject({ estatusCancelacion: "En proceso", esCancelable: "Cancelable con aceptación", validacionEfos: "200" });
    const avisos = () => emisiones.filter((e) => e.evento === "despachos.cfdi.cancelacion_en_proceso");
    expect(avisos()).toHaveLength(1);
    await verificar(app, id, ctx.staff.contador.token);
    expect(avisos()).toHaveLength(1);
  });

  it("timeout del SAT: 200 con consultado:false, el CFDI sigue 'pendiente' y NO se marca vigente", async () => {
    const { app, deps, sat } = armar();
    const id = await crearCfdi(deps);
    sat.respuesta = () => TIMEOUT;
    const body = (await (await verificar(app, id, ctx.staff.contador.token)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ consultado: false, motivo: "timeout", estadoSat: "pendiente", estadoSatVerificadoEn: null });
    const detalle = (await (await app.request(`/despachos/${ctx.propertyId}/cfdi/${id}`, authedJson(ctx.staff.admin.token))).json()) as { estadoSat: string };
    expect(detalle.estadoSat).toBe("pendiente");
  });

  it("cancelacion: notifica UNA vez (enlace al detalle) y un CFDI ya cancelado ya no se consulta ni notifica de nuevo", async () => {
    const { app, deps, sat, emisiones } = armar();
    const id = await crearCfdi(deps);
    sat.respuesta = () => CANCELADO;
    const body = (await (await verificar(app, id, ctx.staff.contador.token)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ consultado: true, estadoSat: "cancelado", estatusCancelacion: "Cancelado sin aceptación" });
    expect(cancelados(emisiones)).toHaveLength(1);
    expect(cancelados(emisiones)[0]).toMatchObject({ enlace: `/despachos/{orgSlug}/cfdi/${id}`, dedupeKey: `despachos.cfdi.cancelado:${id}` });

    const otra = (await (await verificar(app, id, ctx.staff.contador.token)).json()) as Record<string, unknown>;
    expect(otra).toMatchObject({ consultado: false, motivo: "ya_cancelado", estadoSat: "cancelado" });
    expect(sat.llamadas).toHaveLength(1);
    expect(cancelados(emisiones)).toHaveLength(1);
  });

  it("CFDI inexistente 404; limite de frecuencia 429 tras 20 verificaciones", async () => {
    const { app, deps } = armar();
    const id = await crearCfdi(deps);
    expect((await verificar(app, "00000000-0000-0000-0000-0000000000dd", ctx.staff.contador.token)).status).toBe(404);
    for (let i = 0; i < 20; i++) expect((await verificar(app, id, ctx.staff.admin.token)).status).toBe(200);
    expect((await verificar(app, id, ctx.staff.admin.token)).status).toBe(429);
  });
});
