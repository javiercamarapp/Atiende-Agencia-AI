// paridad3 D-31 + D-P3-21 -- automatizacion por cliente, solicitudes de documentos (staff) y su cara en el portal del cliente final.
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { InMemoryPortalClienteRepository, generarTokenPortal, hashTokenPortal } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
let deps: AppDeps;
let portal: InMemoryPortalClienteRepository;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
  portal = new InMemoryPortalClienteRepository();
  portal.sembrarCliente({ propertyId: ctx.propertyId, clienteNombre: "Sede principal", despachoNombre: "Despacho de Prueba SC" });
  deps = { ...ctx.deps, portalClienteRepo: () => portal };
});

const B = () => `/despachos/${ctx.propertyId}`;
const sink = () => ctx.deps.despachosAuditSink as InstanceType<typeof InMemoryAuditSink>;
const put = (app: ReturnType<typeof buildApp>, token: string, cuerpo: unknown) => app.request(`${B()}/automatizacion`, { ...authedJson(token, cuerpo), method: "PUT" });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe("automatizacion por cliente", () => {
  it("por omision el envio de reportes esta APAGADO y no hay correo de contacto", async () => {
    const app = buildApp(deps);
    const r = await json<{ disponible: boolean; automatizacion: { envioReportesCierre: boolean; contactoCorreo: string | null; solicitudDia: number; solicitudActiva: boolean } }>(await app.request(`${B()}/automatizacion`, authedJson(ctx.staff.auditor.token)));
    expect(r).toMatchObject({ disponible: true, automatizacion: { envioReportesCierre: false, contactoCorreo: null, solicitudDia: 1, solicitudActiva: true } });
  });

  it("un contador guarda contacto, dia y plantilla; la bitacora NO lleva el correo", async () => {
    const app = buildApp(deps);
    const res = await put(app, ctx.staff.contador.token, { contactoCorreo: " Contacto@Cliente.MX ", envioReportesCierre: true, solicitudDia: 5, plantilla: { nomina: true, estadosCuenta: ["0123456789"] } });
    expect(res.status).toBe(200);
    const leida = await json<{ automatizacion: { contactoCorreo: string; envioReportesCierre: boolean; solicitudDia: number; plantilla: { nomina?: boolean } } }>(await app.request(`${B()}/automatizacion`, authedJson(ctx.staff.admin.token)));
    expect(leida.automatizacion).toMatchObject({ contactoCorreo: "contacto@cliente.mx", envioReportesCierre: true, solicitudDia: 5, plantilla: { nomina: true } });
    const entrada = sink().entries.find((e) => e.action === "despachos.automatizacion:guardar")!;
    expect(entrada.metadata).toMatchObject({ envioReportesCierre: true, solicitudDia: 5, tieneContacto: true });
    expect(JSON.stringify(sink().entries)).not.toContain("cliente.mx");
  });

  it.each([
    ["envio sin correo", { envioReportesCierre: true }],
    ["correo invalido", { contactoCorreo: "no-es-correo" }],
    ["dia fuera de rango", { solicitudDia: 29 }],
    ["dia no entero", { solicitudDia: 1.5 }],
    ["plantilla con clave desconocida", { plantilla: { otra: true } }],
    ["demasiadas cuentas", { plantilla: { estadosCuenta: Array.from({ length: 11 }, (_, i) => `c${i}`) } }],
    ["booleano mal formado", { solicitudActiva: "si" }],
  ])("validacion: %s -> 400 y no guarda", async (_n, cuerpo) => {
    const app = buildApp(deps);
    expect((await put(app, ctx.staff.admin.token, cuerpo)).status).toBe(400);
    expect(ctx.pilotoRepo.automatizacion.has(ctx.propertyId)).toBe(false);
  });

  it("auditor y readonly NO escriben (403); sin token 401", async () => {
    const app = buildApp(deps);
    expect((await put(app, ctx.staff.auditor.token, {})).status).toBe(403);
    expect((await put(app, ctx.staff.readonly.token, {})).status).toBe(403);
    expect((await app.request(`${B()}/automatizacion`, { method: "PUT" })).status).toBe(401);
  });

  it("base sin la 027: la lectura responde disponible:false y la escritura 503 (nunca 500)", async () => {
    const app = buildApp(deps);
    ctx.pilotoRepo.disponible = false;
    expect(await json(await app.request(`${B()}/automatizacion`, authedJson(ctx.staff.admin.token)))).toEqual({ disponible: false, automatizacion: null });
    expect((await put(app, ctx.staff.admin.token, { solicitudDia: 3 })).status).toBe(503);
  });
});

describe("solicitudes de documentos (staff)", () => {
  const pedir = (app: ReturnType<typeof buildApp>, token: string, periodo: unknown) => app.request(`${B()}/solicitudes-documentos`, authedJson(token, { periodo }));

  it("pedir los documentos crea la solicitud con la plantilla por omision (cuenta, XML emitidos, XML recibidos) y es idempotente", async () => {
    const app = buildApp(deps);
    const r1 = await pedir(app, ctx.staff.contador.token, "2026-06");
    expect(r1.status).toBe(201);
    const a = await json<{ id: string; creada: boolean; correo: string }>(r1);
    expect(a).toMatchObject({ creada: true, correo: "sin_contacto" });
    const r2 = await pedir(app, ctx.staff.contador.token, "2026-06");
    expect(r2.status).toBe(200);
    expect(await json(r2)).toMatchObject({ id: a.id, creada: false, correo: "ya_existia" });
    const lista = await json<{ disponible: boolean; solicitudes: { estado: string; renglones: { tipo: string; estado: string }[] }[] }>(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.readonly.token)));
    expect(lista.solicitudes).toHaveLength(1);
    expect(lista.solicitudes[0]!.renglones.map((r) => r.tipo).sort()).toEqual(["estado_cuenta", "xml_emitidos", "xml_recibidos"]);
  });

  it("con correo de contacto encola UN aviso con enlace al portal (idempotente por solicitud) y sin PII en la bitacora", async () => {
    const app = buildApp(deps);
    await ctx.pilotoRepo.guardarAutomatizacion(ctx.propertyId, { contactoCorreo: "contacto@cliente.mx", envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} });
    const a = await json<{ correo: string; id: string }>(await pedir(app, ctx.staff.admin.token, "2026-06"));
    expect(a.correo).toBe("enviado");
    await pedir(app, ctx.staff.admin.token, "2026-06");
    const correos = ctx.despachosRepo.getMessagingOutbox().filter((j) => j.eventType === "despachos.solicitud.documentos");
    expect(correos).toHaveLength(1);
    expect(correos[0]!.dedupeKey).toBe(`solicitud:${a.id}:inicial`);
    expect(correos[0]!.payload.to).toBe("contacto@cliente.mx");
    expect(String(correos[0]!.payload.text)).toMatch(/\/portal\/cliente#t=[A-Za-z0-9_-]{43}/);
    expect(String(correos[0]!.payload.text)).toContain("Estado de cuenta bancario");
    expect(JSON.stringify(sink().entries)).not.toContain("cliente.mx");
  });

  it.each([["2026-13"], ["26-06"], [""], [null], [202606]])("periodo invalido %j -> 400", async (periodo) => {
    expect((await pedir(buildApp(deps), ctx.staff.admin.token, periodo)).status).toBe(400);
  });

  it("solo admin y contador piden documentos", async () => {
    const app = buildApp(deps);
    expect((await pedir(app, ctx.staff.auditor.token, "2026-06")).status).toBe(403);
    expect((await pedir(app, ctx.staff.readonly.token, "2026-06")).status).toBe(403);
  });

  async function conSolicitud() {
    const app = buildApp(deps);
    await pedir(app, ctx.staff.contador.token, "2026-06");
    const lista = await json<{ solicitudes: { id: string; renglones: { id: string; tipo: string }[] }[] }>(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.contador.token)));
    const renglon = (tipo: string) => lista.solicitudes[0]!.renglones.find((r) => r.tipo === tipo)!.id;
    return { app, renglon };
  }
  const accion = (app: ReturnType<typeof buildApp>, token: string, id: string, ruta: string, cuerpo: unknown = {}) => app.request(`${B()}/solicitudes-documentos/renglones/${id}/${ruta}`, authedJson(token, cuerpo));

  it("«no aplica» exige motivo, lo guarda en el renglon y NO lo manda a la bitacora; reabrir lo devuelve a pendiente", async () => {
    const { app, renglon } = await conSolicitud();
    const id = renglon("xml_emitidos");
    expect((await accion(app, ctx.staff.contador.token, id, "no-aplica", {})).status).toBe(400);
    expect((await accion(app, ctx.staff.contador.token, id, "no-aplica", { motivo: "ab" })).status).toBe(400);
    expect((await accion(app, ctx.staff.contador.token, id, "no-aplica", { motivo: "No facturó este mes (Juan)" })).status).toBe(200);
    const lista = await json<{ solicitudes: { renglones: { id: string; estado: string; motivoNoAplica: string | null }[] }[] }>(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.contador.token)));
    expect(lista.solicitudes[0]!.renglones.find((r) => r.id === id)).toMatchObject({ estado: "no_aplica", motivoNoAplica: "No facturó este mes (Juan)" });
    expect(JSON.stringify(sink().entries)).not.toContain("Juan");
    expect(sink().entries.find((e) => e.action === "despachos.solicitudes-documentos:no-aplica")!.metadata).toMatchObject({ renglonId: id });
    expect((await accion(app, ctx.staff.contador.token, id, "no-aplica", { motivo: "otra vez no aplica" })).status).toBe(409);
    expect((await accion(app, ctx.staff.contador.token, id, "reabrir")).status).toBe(200);
    expect((await accion(app, ctx.staff.contador.token, id, "reabrir")).status).toBe(409);
  });

  it("marcar todos los renglones completa la solicitud y el estado del cierre lo refleja", async () => {
    const { app, renglon } = await conSolicitud();
    for (const t of ["estado_cuenta", "xml_emitidos", "xml_recibidos"]) expect((await accion(app, ctx.staff.admin.token, renglon(t), "no-aplica", { motivo: "No aplica este mes" })).status).toBe(200);
    const lista = await json<{ solicitudes: { estado: string }[] }>(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.admin.token)));
    expect(lista.solicitudes[0]!.estado).toBe("completa");
  });

  it("renglon con id mal formado 400, inexistente 404, auditor 403", async () => {
    const { app, renglon } = await conSolicitud();
    expect((await accion(app, ctx.staff.admin.token, "no-es-uuid", "reabrir")).status).toBe(400);
    expect((await accion(app, ctx.staff.admin.token, "00000000-0000-0000-0000-0000000000ee", "vincular", { documentoId: "00000000-0000-0000-0000-0000000000dd" })).status).toBe(404);
    expect((await accion(app, ctx.staff.auditor.token, renglon("xml_emitidos"), "no-aplica", { motivo: "intento" })).status).toBe(403);
  });

  it("cross-tenant: un renglon de OTRA property no se toca (404) y nada cambia", async () => {
    const { app, renglon } = await conSolicitud();
    const id = renglon("xml_emitidos");
    ctx.pilotoRepo.propiedadesAjenas.add(ctx.propertyId);
    const r = await accion(app, ctx.staff.admin.token, id, "no-aplica", { motivo: "intento ajeno" });
    expect([403, 404]).toContain(r.status);
    ctx.pilotoRepo.propiedadesAjenas.delete(ctx.propertyId);
    const lista = await json<{ solicitudes: { renglones: { id: string; estado: string }[] }[] }>(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.admin.token)));
    expect(lista.solicitudes[0]!.renglones.find((x) => x.id === id)!.estado).toBe("pendiente");
  });

  it("base sin la 027: pedir documentos responde 503 y listar disponible:false", async () => {
    const app = buildApp(deps);
    ctx.pilotoRepo.disponible = false;
    expect((await pedir(app, ctx.staff.admin.token, "2026-06")).status).toBe(503);
    expect(await json(await app.request(`${B()}/solicitudes-documentos`, authedJson(ctx.staff.admin.token)))).toEqual({ disponible: false, solicitudes: [] });
  });
});

describe("portal del cliente final: solicitudes y reportes", () => {
  async function conEnlace() {
    const app = buildApp(deps);
    const token = generarTokenPortal();
    await portal.crearEnlace(ctx.propertyId, hashTokenPortal(token), "Solicitud 2026-06", 30);
    await ctx.pilotoRepo.crearEnlaceSistema(ctx.propertyId, hashTokenPortal(token), "Solicitud 2026-06", 30);
    return { app, token, h: { "x-portal-token": token } };
  }
  const subir = (app: ReturnType<typeof buildApp>, token: string, query = "") =>
    app.request(`/portal-cliente/documentos${query}`, { method: "POST", headers: { "x-portal-token": token, "content-type": "application/pdf", "x-nombre-archivo": "edo.pdf" }, body: new TextEncoder().encode("%PDF-1.4\n%contenido") });

  it("el cliente ve lo que se le pidio con el estado de cada renglon (sin ids internos de enlace ni de otras properties)", async () => {
    const { app, h } = await conEnlace();
    await ctx.pilotoRepo.crearSolicitudSistema(ctx.propertyId, 2026, 6);
    const r = await json<{ solicitudes: { ejercicio: number; mes: number; renglones: { etiqueta: string; estado: string }[] }[] }>(await app.request("/portal-cliente/solicitudes", { headers: h }));
    expect(r.solicitudes).toHaveLength(1);
    expect(r.solicitudes[0]).toMatchObject({ ejercicio: 2026, mes: 6 });
    expect(r.solicitudes[0]!.renglones.map((x) => x.etiqueta)).toContain("Estado de cuenta bancario");
    expect(JSON.stringify(r)).not.toContain(ctx.propertyId);
  });

  it("subir un archivo PARA un renglon lo deja ligado y en revision; el despacho lo acepta y el renglon queda recibido", async () => {
    const { app, token } = await conEnlace();
    ctx.pilotoRepo.buscarDocumentoPortal = (id) => ({ id, propertyId: ctx.propertyId, tokenHash: hashTokenPortal(token), estado: "recibido" });
    await ctx.pilotoRepo.crearSolicitudSistema(ctx.propertyId, 2026, 6);
    const renglonId = ctx.pilotoRepo.solicitudes[0]!.renglones.find((r) => r.tipo === "estado_cuenta")!.id;
    const res = await subir(app, token, `?renglonId=${renglonId}`);
    expect(res.status).toBe(201);
    const body = await json<{ id: string; renglon: { vinculado: boolean; estado: string } }>(res);
    expect(body.renglon).toEqual({ vinculado: true, estado: "en_revision" });
    ctx.pilotoRepo.resolverDocumentoPortal(body.id, "aceptado");
    expect(ctx.pilotoRepo.solicitudes[0]!.renglones.find((r) => r.id === renglonId)!.estado).toBe("recibido");
  });

  it("un renglon que no es del cliente (o ya no aplica) NO falla la subida: el archivo queda recibido y se avisa renglon.vinculado=false", async () => {
    const { app, token } = await conEnlace();
    ctx.pilotoRepo.buscarDocumentoPortal = (id) => ({ id, propertyId: ctx.propertyId, tokenHash: hashTokenPortal(token), estado: "recibido" });
    const res = await subir(app, token, "?renglonId=00000000-0000-0000-0000-0000000000ee");
    expect(res.status).toBe(201);
    expect((await json<{ renglon: { vinculado: boolean } }>(res)).renglon).toEqual({ vinculado: false });
  });

  it("renglonId mal formado -> 400 sin subir nada", async () => {
    const { app, token } = await conEnlace();
    expect((await subir(app, token, "?renglonId=malo")).status).toBe(400);
  });

  it("sin token valido todo responde el mismo 404 generico (sin oraculo), incluida la descarga de reportes", async () => {
    const app = buildApp(deps);
    const cabeceras = { "x-portal-token": generarTokenPortal() };
    for (const ruta of ["/portal-cliente/solicitudes", "/portal-cliente/reportes", "/portal-cliente/reportes/00000000-0000-0000-0000-0000000000aa"]) {
      const r = await app.request(ruta, { headers: cabeceras });
      expect(r.status, ruta).toBe(404);
      expect(((await r.json()) as { code: string }).code).toBe("enlace_no_valido");
    }
    expect((await app.request("/portal-cliente/solicitudes")).status).toBe(404);
  });

  it("reportes: el cliente lista y baja el PDF de SU property; el id de otro cliente responde 404", async () => {
    const { app, h } = await conEnlace();
    ctx.pilotoRepo.verificarCerrado = null;
    ctx.pilotoRepo.sembrarCliente({ organizationId: ctx.organizationId, propertyId: "otra-property", razonSocial: "Otro" });
    ctx.pilotoRepo.automatizacion.set(ctx.propertyId, { contactoCorreo: "a@b.mx", envioReportesCierre: true, solicitudActiva: true, solicitudDia: 1, plantilla: {} });
    ctx.pilotoRepo.automatizacion.set("otra-property", { contactoCorreo: "c@d.mx", envioReportesCierre: true, solicitudActiva: true, solicitudDia: 1, plantilla: {} });
    for (const [pid, periodoId] of [[ctx.propertyId, "p-a"], ["otra-property", "p-b"]] as const) {
      ctx.pilotoRepo.sembrarPeriodo({ periodoId, organizationId: ctx.organizationId, propertyId: pid, anio: 2026, mes: 6, cerrado: true });
    }
    const pdf = new TextEncoder().encode("%PDF-1.4\nreporte");
    const propia = await ctx.pilotoRepo.crearEntrega(ctx.propertyId, "p-a");
    const ajena = await ctx.pilotoRepo.crearEntrega("otra-property", "p-b");
    await ctx.pilotoRepo.agregarArchivoEntrega(ctx.propertyId, propia.id, "diot", "diot-2026-06.pdf", pdf);
    await ctx.pilotoRepo.agregarArchivoEntrega("otra-property", ajena.id, "diot", "diot-ajena.pdf", pdf);
    const lista = await json<{ reportes: { anio: number; mes: number; archivos: { id: string; tipo: string; nombreArchivo: string }[] }[] }>(await app.request("/portal-cliente/reportes", { headers: h }));
    expect(lista.reportes).toHaveLength(1);
    expect(lista.reportes[0]!.archivos.map((a) => a.nombreArchivo)).toEqual(["diot-2026-06.pdf"]);
    const dl = await app.request(`/portal-cliente/reportes/${lista.reportes[0]!.archivos[0]!.id}`, { headers: h });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toContain("diot-2026-06.pdf");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    const idAjeno = ctx.pilotoRepo.entregas.find((e) => e.id === ajena.id)!.archivos[0]!.id;
    expect((await app.request(`/portal-cliente/reportes/${idAjeno}`, { headers: h })).status).toBe(404);
    expect((await app.request("/portal-cliente/reportes/no-es-uuid", { headers: h })).status).toBe(404);
  });

  it("base sin la 027: el portal responde 503 honesto, no 500", async () => {
    const { app, h } = await conEnlace();
    ctx.pilotoRepo.disponible = false;
    expect((await app.request("/portal-cliente/solicitudes", { headers: h })).status).toBe(503);
    expect((await app.request("/portal-cliente/reportes", { headers: h })).status).toBe(503);
  });
});
