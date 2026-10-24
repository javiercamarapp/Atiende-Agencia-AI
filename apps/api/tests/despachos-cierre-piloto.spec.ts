// paridad3 D-P3-15 + D-P3-21 -- cierre mensual en piloto automatico: el estado de los modulos lo calcula el SERVIDOR, el cierre se bloquea con la lista de
// validaciones que fallan (un admin puede forzar con motivo), al cerrar se pre-generan el papel de pagos provisionales y el paquete de contabilidad
// electronica, y la entrega de reportes al cliente es opt-in, idempotente y sin PII en la bitacora.
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryPortalClienteRepository, construirCatalogoBase, getTemplate, validarFichaCliente } from "@atiende/domain-despachos";
import type { EstadoModulosCierre } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";
import type { EmisionRegistrada } from "./support/emisiones.ts";

let ctx: DespachosTestContext;
let deps: AppDeps;
let emisiones: EmisionRegistrada[];
let portal: InMemoryPortalClienteRepository;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
  portal = new InMemoryPortalClienteRepository();
  const c = conEmisiones({ ...ctx.deps, portalClienteRepo: () => portal });
  deps = c.deps;
  emisiones = c.emisiones;
});

const SANO: EstadoModulosCierre = {
  debeCentavos: 0, haberCentavos: 0, polizas: 0, polizasDescuadradas: 0, cfdiTotal: 0, cfdiSinPoliza: 0, cfdiInvalidos: 0, conciliacionSesiones: 0, conciliacionAbiertas: 0,
  movimientos: 0, movimientosConciliados: 0, pagosProvisionales: 1, solicitudEstado: null, solicitudPendientes: 0, periodicidad: "mensual",
};
const estado = (p: Partial<EstadoModulosCierre>): EstadoModulosCierre => ({ ...SANO, ...p });
const BASE = () => `/despachos/${ctx.propertyId}/cierre-mensual/periodos`;
const sink = () => ctx.deps.despachosAuditSink as InstanceType<typeof InMemoryAuditSink>;

async function abrirPeriodo(anio = 2026, mes = 3) {
  const { periodo, tareas } = await ctx.despachosRepo.insertPeriodoCierre({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio, mes, template: getTemplate() });
  ctx.pilotoRepo.sembrarPeriodo({ periodoId: periodo.id, organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio, mes });
  return { periodo, tareas };
}
async function dejarTareasListas(periodoId: string, tareas: readonly { id: string }[]) {
  const completas = (await ctx.despachosRepo.listTareasCierre(periodoId)).map((t) => ({ ...t, status: "done" as const, completedAt: new Date().toISOString(), completedBy: "seed-test" }));
  await ctx.despachosRepo.replaceTareasCierre(periodoId, completas);
  expect(completas).toHaveLength(tareas.length);
}
const cerrar = (app: ReturnType<typeof buildApp>, periodoId: string, cuerpo: Record<string, unknown>, mes = "2026-03") => app.request(`${BASE()}/${periodoId}/cerrar`, authedJson(ctx.staff.admin.token, { confirmacion: mes, ...cuerpo }));

describe("auto-check: el estado de los modulos lo calcula el servidor", () => {
  it("un moduleState del body se IGNORA: 5 CFDI sin poliza en el servidor impiden completar la tarea aunque el navegador diga 0", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ cfdiSinPoliza: 5 }));
    const res = await app.request(`${BASE()}/${periodo.id}/auto-check`, authedJson(ctx.staff.contador.token, { moduleState: { cfdi_pending_count: 0, cfdi_validacion: true, bank_feeds_sync_status: "ok" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completadas: { title: string }[]; validaciones: { disponible: boolean; puedeCerrar: boolean } };
    expect(body.completadas.map((t) => t.title)).not.toContain("Verificar CFDIs del mes procesados");
    expect(body.validaciones).toMatchObject({ disponible: true, puedeCerrar: false });
  });

  it("con el estado sano completa en cascada las tareas con senal y atribuye al actor de la sesion", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    const res = await app.request(`${BASE()}/${periodo.id}/auto-check`, authedJson(ctx.staff.contador.token, {}));
    const body = (await res.json()) as { tareas: { title: string; status: string; completedBy: string | null }[]; completadas: unknown[] };
    const porTitulo = (t: string) => body.tareas.find((x) => x.title === t)!;
    expect(porTitulo("Verificar CFDIs del mes procesados")).toMatchObject({ status: "done", completedBy: ctx.staff.contador.id });
    expect(porTitulo("Validar folios fiscales y sellos")).toMatchObject({ status: "done" });
    expect(porTitulo("Conciliación bancaria completada")).toMatchObject({ status: "done" });
    expect(body.completadas.length).toBeGreaterThanOrEqual(3);
  });

  it("un periodo ya cerrado responde 409 (nada que auto-completar)", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    expect((await cerrar(app, periodo.id, {})).status).toBe(200);
    expect((await app.request(`${BASE()}/${periodo.id}/auto-check`, authedJson(ctx.staff.contador.token, {}))).status).toBe(409);
  });

  it("al abrir el detalle quien gestiona auto-completa (atribuido a «sistema») y deja UNA entrada de bitacora; un segundo GET no escribe nada", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    const get = () => app.request(`${BASE()}/${periodo.id}`, authedJson(ctx.staff.contador.token));
    const antes = sink().entries.length;
    const primero = (await (await get()).json()) as { tareas: { title: string; status: string; completedBy: string | null }[]; validaciones: { disponible: boolean; items: unknown[]; puedeCerrar: boolean } };
    expect(primero.tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")).toMatchObject({ status: "done", completedBy: "sistema" });
    expect(primero.validaciones).toMatchObject({ disponible: true, puedeCerrar: true });
    expect(primero.validaciones.items).toHaveLength(6);
    expect(sink().entries.slice(antes).filter((e) => e.action === "despachos.cierre-mensual:auto-check")).toHaveLength(1);
    await get();
    expect(sink().entries.slice(antes).filter((e) => e.action === "despachos.cierre-mensual:auto-check")).toHaveLength(1);
  });

  it("un auditor (solo lectura) puede ver el detalle pero NO dispara el auto-check", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    const res = await app.request(`${BASE()}/${periodo.id}`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: { status: string }[] };
    expect(body.tareas.every((t) => t.status !== "done")).toBe(true);
  });

  it("base sin la migracion 027: el detalle responde, las validaciones quedan «no disponibles» y no se auto-completa nada", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    ctx.pilotoRepo.disponible = false;
    const res = await app.request(`${BASE()}/${periodo.id}`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: { status: string }[]; validaciones: { disponible: boolean; items: unknown[]; puedeCerrar: boolean } };
    expect(body.validaciones).toEqual({ disponible: false, items: [], puedeCerrar: true });
    expect(body.tareas.every((t) => t.status !== "done")).toBe(true);
    expect((await app.request(`${BASE()}/${periodo.id}/auto-check`, authedJson(ctx.staff.contador.token, {}))).status).toBe(200);
  });
});

describe("GET .../validaciones", () => {
  it("lista las 6 validaciones con su resultado y dice si se puede cerrar", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ haberCentavos: 50_000, cfdiSinPoliza: 2 }));
    const res = await app.request(`${BASE()}/${periodo.id}/validaciones`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; puedeCerrar: boolean; items: { clave: string; ok: boolean; mensaje: string }[] };
    expect(body.puedeCerrar).toBe(false);
    expect(body.items.filter((i) => !i.ok).map((i) => i.clave)).toEqual(["balanza", "cfdi_sin_poliza"]);
    expect(body.items.find((i) => i.clave === "balanza")!.mensaje).toMatch(/no cuadra/);
  });

  it("sin token 401 y un periodo inexistente 404", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    expect((await app.request(`${BASE()}/${periodo.id}/validaciones`)).status).toBe(401);
    expect((await app.request(`${BASE()}/00000000-0000-0000-0000-0000000000ee/validaciones`, authedJson(ctx.staff.admin.token))).status).toBe(404);
  });
});

describe("POST .../cerrar con validaciones derivadas", () => {
  it("409 con la LISTA de validaciones que fallan; el periodo sigue abierto", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ polizasDescuadradas: 1, polizas: 4, solicitudEstado: "abierta", solicitudPendientes: 2 }));
    const res = await cerrar(app, periodo.id, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string; validaciones: { clave: string; ok: boolean }[] };
    expect(body.code).toBe("cierre_bloqueado");
    expect(body.validaciones.map((v) => v.clave)).toEqual(["polizas", "solicitud_documentos"]);
    expect(body.validaciones.every((v) => !v.ok)).toBe(true);
    expect((await ctx.despachosRepo.findPeriodoCierre(ctx.propertyId, periodo.id))!.status).not.toBe("closed");
    expect(sink().entries.some((e) => e.action.startsWith("despachos.cierre-mensual:cerrar-periodo"))).toBe(false);
  });

  it("forzar sin motivo (o con motivo corto) -> 400 y el periodo sigue abierto", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ cfdiSinPoliza: 1 }));
    expect((await cerrar(app, periodo.id, { forzar: true })).status).toBe(400);
    expect((await cerrar(app, periodo.id, { forzar: true, motivo: "urgente" })).status).toBe(400);
    expect((await ctx.despachosRepo.findPeriodoCierre(ctx.propertyId, periodo.id))!.status).not.toBe("closed");
    expect(ctx.pilotoRepo.forzados).toHaveLength(0);
  });

  it("un admin fuerza con motivo: cierra, guarda el motivo en el periodo y la bitacora registra las validaciones saltadas SIN el texto del motivo", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ cfdiSinPoliza: 1, haberCentavos: 100_000 }));
    const motivo = "Cliente Juan Perez entrego tarde; cierro con la diferencia conocida";
    const res = await cerrar(app, periodo.id, { forzar: true, motivo });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("closed");
    expect(ctx.pilotoRepo.forzados).toEqual([{ propertyId: ctx.propertyId, periodoId: periodo.id, motivo, validaciones: ["balanza", "cfdi_sin_poliza"] }]);
    const entrada = sink().entries.find((e) => e.action === "despachos.cierre-mensual:cerrar-periodo-forzado")!;
    expect(entrada.actorUserId).toBe(ctx.staff.admin.id);
    expect(entrada.metadata).toMatchObject({ forzado: true, validaciones: "balanza,cfdi_sin_poliza" });
    expect(JSON.stringify(entrada)).not.toContain("Juan Perez");
  });

  it("un contador NO puede cerrar ni forzar (solo admin)", async () => {
    const app = buildApp(deps);
    const { periodo } = await abrirPeriodo();
    const res = await app.request(`${BASE()}/${periodo.id}/cerrar`, authedJson(ctx.staff.contador.token, { confirmacion: "2026-03", forzar: true, motivo: "quiero cerrar a la fuerza este periodo" }));
    expect(res.status).toBe(403);
  });

  it("forzar cuando TODO pasa no registra un cierre forzado (no hay nada que saltar)", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    const res = await cerrar(app, periodo.id, { forzar: true, motivo: "no hace falta pero lo mando de todos modos" });
    expect(res.status).toBe(200);
    expect(ctx.pilotoRepo.forzados).toHaveLength(0);
    expect(sink().entries.some((e) => e.action === "despachos.cierre-mensual:cerrar-periodo")).toBe(true);
    expect(sink().entries.some((e) => e.action === "despachos.cierre-mensual:cerrar-periodo-forzado")).toBe(false);
  });

  it("base sin la 027: cierra como antes (solo tareas), sin validaciones derivadas ni pasos de pos-cierre", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.disponible = false;
    const res = await cerrar(app, periodo.id, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; posCierre: { papelPagos: string; contabilidadElectronica: string; entrega: string } };
    expect(body.status).toBe("closed");
    expect(body.posCierre).toEqual({ papelPagos: "no_aplica", contabilidadElectronica: "no_generada", entrega: "no_aplica" });
  });
});

describe("pos-cierre: papel de pagos provisionales, contabilidad electronica y entrega al cliente", () => {
  async function fichaYLibro() {
    const f = validarFichaCliente({ rfc: "CLI010101CL1", razonSocial: "Cliente SA", regimenesFiscales: ["601"], cpFiscal: "06600" });
    if (!f.ok) throw new Error("ficha invalida");
    await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
    await ctx.libroRepo.sembrarCatalogo(ctx.propertyId, construirCatalogoBase());
    await ctx.libroRepo.registrarPoliza(ctx.propertyId, {
      tipo: "diario",
      fecha: "2026-03-10",
      concepto: "Ajuste",
      movimientos: [
        { cuenta: "1050000", concepto: "x", debeCentavos: 11_600, haberCentavos: 0 },
        { cuenta: "4080000", concepto: "x", debeCentavos: 0, haberCentavos: 11_600 },
      ],
    });
  }

  it("pre-genera el papel de pagos provisionales cuando no existe (forzando el cierre) y NO lo presenta", async () => {
    const app = buildApp(deps);
    await fichaYLibro();
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ pagosProvisionales: 0 }));
    const res = await cerrar(app, periodo.id, { forzar: true, motivo: "El papel se genera al cerrar, como pide el flujo" });
    const body = (await res.json()) as { posCierre: { papelPagos: string } };
    expect(body.posCierre.papelPagos).toBe("generado");
    const guardados = await ctx.pagosRepo.listarPapeles(ctx.propertyId, 2026);
    expect(guardados.papeles.filter((p) => p.mes === 3).length).toBeGreaterThanOrEqual(1);
    expect(guardados.papeles.every((p) => p.estado === "borrador")).toBe(true);
  });

  it("si el papel ya existia no lo recalcula", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    const body = (await (await cerrar(app, periodo.id, {})).json()) as { posCierre: { papelPagos: string } };
    expect(body.posCierre.papelPagos).toBe("ya_existia");
  });

  it("un fallo del papel (cliente sin ficha) se REPORTA pero no deshace el cierre", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    ctx.pilotoRepo.sembrarEstadoModulos(ctx.propertyId, 2026, 3, estado({ pagosProvisionales: 0 }));
    const res = await cerrar(app, periodo.id, { forzar: true, motivo: "Cierro aunque falte la ficha del cliente" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; posCierre: { papelPagos: string } };
    expect(body.status).toBe("closed");
    expect(body.posCierre.papelPagos).toMatch(/^no_generado: .*ficha/i);
    expect((await ctx.despachosRepo.findPeriodoCierre(ctx.propertyId, periodo.id))!.status).toBe("closed");
  });

  it("pre-genera el catalogo y la balanza XML de contabilidad electronica; se descargan con rol de escritura, sin leerlos como lista de otro despacho", async () => {
    const app = buildApp(deps);
    await fichaYLibro();
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    const cierre = (await (await cerrar(app, periodo.id, {})).json()) as { posCierre: { contabilidadElectronica: string } };
    expect(cierre.posCierre.contabilidadElectronica).toBe("generada");
    const detalle = (await (await app.request(`${BASE()}/${periodo.id}`, authedJson(ctx.staff.admin.token))).json()) as { artefactos: { id: string; tipo: string; nombreArchivo: string }[] };
    expect(detalle.artefactos.map((a) => a.tipo).sort()).toEqual(["contabilidad_balanza_xml", "contabilidad_catalogo_xml"]);
    const balanza = detalle.artefactos.find((a) => a.tipo === "contabilidad_balanza_xml")!;
    const antes = sink().entries.length;
    const dl = await app.request(`${BASE()}/${periodo.id}/artefactos/${balanza.id}/descargar`, authedJson(ctx.staff.contador.token));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("application/xml");
    expect(dl.headers.get("content-disposition")).toContain("balanza-2026-03.xml");
    expect(await dl.text()).toContain("<");
    expect(sink().entries.slice(antes).some((e) => e.action === "despachos.cierre_mensual.artefacto:descarga")).toBe(true);
    // auditor (solo lectura) y un artefacto inexistente
    expect((await app.request(`${BASE()}/${periodo.id}/artefactos/${balanza.id}/descargar`, authedJson(ctx.staff.auditor.token))).status).toBe(403);
    expect((await app.request(`${BASE()}/${periodo.id}/artefactos/00000000-0000-0000-0000-0000000000ee/descargar`, authedJson(ctx.staff.contador.token))).status).toBe(404);
  });

  it("sin movimientos en el libro no inventa un paquete vacio", async () => {
    const app = buildApp(deps);
    const { periodo, tareas } = await abrirPeriodo();
    await dejarTareasListas(periodo.id, tareas);
    const cierre = (await (await cerrar(app, periodo.id, {})).json()) as { posCierre: { contabilidadElectronica: string } };
    expect(cierre.posCierre.contabilidadElectronica).toBe("sin_libro_en_el_periodo");
  });

  describe("entrega de reportes al cliente (opt-in, apagada por omision)", () => {
    const optIn = async () => ctx.pilotoRepo.guardarAutomatizacion(ctx.propertyId, { contactoCorreo: "contacto@cliente.mx", envioReportesCierre: true, solicitudActiva: true, solicitudDia: 1, plantilla: {} });

    it("apagada por omision: cerrar NO manda nada al cliente", async () => {
      const app = buildApp(deps);
      const { periodo, tareas } = await abrirPeriodo();
      await dejarTareasListas(periodo.id, tareas);
      const cierre = (await (await cerrar(app, periodo.id, {})).json()) as { posCierre: { entrega: string } };
      expect(cierre.posCierre.entrega).toBe("no_activada");
      expect(ctx.despachosRepo.getMessagingOutbox().filter((j) => j.eventType === "despachos.cierre.entrega")).toHaveLength(0);
      expect(ctx.pilotoRepo.entregas).toHaveLength(0);
    });

    it("con opt-in: publica los 3 PDF en el portal, encola UN correo con enlace al portal y avisa en la campana", async () => {
      const app = buildApp(deps);
      await optIn();
      const { periodo, tareas } = await abrirPeriodo();
      await dejarTareasListas(periodo.id, tareas);
      const cierre = (await (await cerrar(app, periodo.id, {})).json()) as { posCierre: { entrega: string } };
      expect(cierre.posCierre.entrega).toBe("enviada");
      const entrega = ctx.pilotoRepo.entregas[0]!;
      expect(entrega.archivos.map((a) => a.tipo).sort()).toEqual(["balanza", "diot", "impuestos"]);
      for (const a of entrega.archivos) expect(Buffer.from(a.contenido.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
      const correos = ctx.despachosRepo.getMessagingOutbox().filter((j) => j.eventType === "despachos.cierre.entrega");
      expect(correos).toHaveLength(1);
      expect(correos[0]!.dedupeKey).toBe(`cierre-entrega:${periodo.id}`);
      expect(correos[0]!.payload.to).toBe("contacto@cliente.mx");
      expect(String(correos[0]!.payload.text)).toMatch(/\/portal\/cliente#t=[A-Za-z0-9_-]{43}/);
      expect(emisiones.filter((e) => e.evento === "despachos.cierre.entrega_enviada")).toHaveLength(1);
      expect(emisiones.find((e) => e.evento === "despachos.cierre.entrega_enviada")!.titulo + (emisiones[0]?.cuerpo ?? "")).not.toMatch(/@|contacto/);
      // La bitacora del cierre no lleva el correo del cliente.
      expect(JSON.stringify(sink().entries)).not.toContain("contacto@cliente.mx");
    });

    it("idempotente por periodo: la entrega ya existente no se repite", async () => {
      const app = buildApp(deps);
      await optIn();
      const { periodo, tareas } = await abrirPeriodo();
      await dejarTareasListas(periodo.id, tareas);
      await cerrar(app, periodo.id, {});
      const piloto = ctx.pilotoRepo;
      const otra = await piloto.crearEntrega(ctx.propertyId, periodo.id);
      expect(otra.creada).toBe(false);
      expect(ctx.despachosRepo.getMessagingOutbox().filter((j) => j.eventType === "despachos.cierre.entrega")).toHaveLength(1);
    });
  });
});
