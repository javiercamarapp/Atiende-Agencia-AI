// D-24 -- libro contable persistido de un cliente del despacho (migración 020): catálogo de cuentas, pólizas con folio (manuales o
// armadas desde un CFDI persistido), reversas, balanza derivada y paquete de contabilidad electrónica del mes. SIN llamadas al SAT.
//
//  GET  /despachos/:propertyId/libro/cuentas                       catálogo del cliente
//  POST /despachos/:propertyId/libro/catalogo/sembrar              siembra el catálogo base (idempotente)
//  PUT  /despachos/:propertyId/libro/cuentas                       alta/edición de una cuenta
//  GET  /despachos/:propertyId/libro/polizas?ejercicio=&mes=       pólizas (paginadas)
//  GET  /despachos/:propertyId/libro/polizas/:polizaId             póliza con sus partidas
//  POST /despachos/:propertyId/libro/polizas                       registra una póliza (cuadrada, en centavos)
//  POST /despachos/:propertyId/libro/polizas/desde-cfdi            póliza de un CFDI persistido
//  POST /despachos/:propertyId/libro/polizas/:polizaId/reversar    póliza de reversa
//  GET  /despachos/:propertyId/libro/cfdi?periodo=YYYY-MM         CFDI del periodo con su poliza (o por que no se puede armar sola)
//  GET  /despachos/:propertyId/libro/balanza?periodo=YYYY-MM       balanza derivada
//  GET  /despachos/:propertyId/libro/contabilidad-electronica?periodo=YYYY-MM   catálogo + balanza XML con SHA-1 (conformes al XSD 1.3; ?tipoEnvio=N|C&fechaModBal=)
//  GET  /despachos/:propertyId/libro/contabilidad-electronica/polizas?periodo=&tipoSolicitud=&numOrden=|numTramite=   XML de pólizas del periodo (PolizasPeriodo 1.3)
//  POST /despachos/:propertyId/libro/catalogo/agrupadores           asigna el código agrupador del SAT a varias cuentas (lista cerrada del Anexo 24)
//  POST /despachos/:propertyId/libro/catalogo/agrupadores/proponer  aplica la propuesta del catálogo base a las cuentas SIN código (acción explícita del staff)
//  POST /despachos/:propertyId/libro/catalogo/importar              catálogo XML del proveedor anterior (vista previa; con confirmar: true + segundo factor, lo importa sin borrar nada)
//  POST /despachos/:propertyId/libro/apertura/importar              balanza XML del proveedor anterior -> póliza de apertura (vista previa; con confirmar: true + segundo factor, la registra)
//  GET  /despachos/:propertyId/libro/pagos-rep?periodo=YYYY-MM|folioFiscalRep=   pagos de complemento de pago con su póliza vigente y si se pueden contabilizar
//  POST /despachos/:propertyId/libro/polizas/desde-rep              pólizas de cobro/pago de los pagos de un REP (una vigente por pago)
//
// Autorización: ver = VER_LIBRO_ROLES; escribir = GESTIONAR_LIBRO_ROLES (admin/contador); la membresía de la property aplica igual
// que en el resto. La base repite todo (funciones security definer con guard). Cada escritura deja bitácora (despachos.audit_log).
// Compatibilidad con la base sin migrar: las lecturas responden `estado: "no_disponible"` con vacío honesto y las escrituras 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  CODIGO_AGRUPADOR_BASE,
  CatalogoSinCodigoAgrupadorError,
  ContabilidadElectronicaDatosInvalidosError,
  GESTIONAR_LIBRO_ROLES,
  ImportacionXmlContabilidadError,
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  LibroSinPermisoError,
  LibroTopeExcedidoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
  PostgresCarteraRepository,
  PostgresLibroRepository,
  TIPOS_SOLICITUD_POLIZAS,
  VER_LIBRO_ROLES,
  calcularHashSha1,
  construirAperturaDesdeBalanza,
  construirCatalogoBase,
  construirPolizaDesdeCfdi,
  construirPolizaDesdeRep,
  esCodigoAgrupadorSat,
  esFechaValida,
  generarPaqueteDesdeLibro,
  generarXmlPolizasPeriodo,
  leerBalanzaXml,
  leerCatalogoXml,
  leerFuenteOpcional,
  naturalezaPorDefecto,
  totalesBalanza,
  validarPolizaEntrada,
} from "@atiende/domain-despachos";
import type { CarteraRepository, CuentaLibro, LibroRepository, OpcionesPolizaCfdi, TipoSolicitudPolizas } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { exigirStepUpDespachos } from "./step-up.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

const MAX_BODY_BYTES = 128 * 1024;
const PERIODO_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Errores de dominio del libro -> HTTP (la base ya devolvió un mensaje sin detalles internos). */
export function traducirLibro(err: unknown): never {
  if (err instanceof LibroNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof LibroSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof PeriodoLibroCerradoError) throw Errors.conflict(err.message);
  if (err instanceof PolizaDuplicadaError) throw Errors.conflict(err.message);
  if (err instanceof LibroTopeExcedidoError) throw Errors.conflict(err.message);
  if (err instanceof LibroNoEncontradoError) throw Errors.notFound(err.message);
  if (err instanceof LibroDatosInvalidosError) throw Errors.validation(err.message);
  throw err;
}

export function despachosLibroRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const libroDe = (db: TenantDbSession): LibroRepository => (deps.libroRepo ? deps.libroRepo(db) : new PostgresLibroRepository(db));
  const carteraDe = (db: TenantDbSession): CarteraRepository => (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db));

  app.use("/despachos/:propertyId/libro/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Siembra el catálogo base la primera vez (idempotente). Base sin migrar: 503 honesto. */
  async function asegurarCatalogo(repo: LibroRepository, propertyId: string): Promise<void> {
    const actual = await repo.listarCuentas(propertyId);
    if (actual.estado === "no_disponible") throw new LibroNoDisponibleError();
    if (actual.datos.length === 0) await repo.sembrarCatalogo(propertyId, construirCatalogoBase());
  }

  /** Garantiza que las cuentas que usará una póliza existan en el catálogo del cliente: si falta alguna siembra el catálogo base (solo agrega las que faltan). */
  async function asegurarCuentas(repo: LibroRepository, propertyId: string, requeridas: readonly string[]): Promise<void> {
    const actual = await repo.listarCuentas(propertyId);
    if (actual.estado === "no_disponible") throw new LibroNoDisponibleError();
    const tiene = new Set(actual.datos.map((x) => x.codigo));
    if (actual.datos.length === 0 || requeridas.some((x) => !tiene.has(x))) await repo.sembrarCatalogo(propertyId, construirCatalogoBase());
  }

  async function auditar(c: Context<CoreAuthHonoEnv>, action: string, metadata: Record<string, unknown>): Promise<void> {
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action,
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata,
    });
  }

  function periodoDe(valor: string | undefined, defecto: string): { ejercicio: number; mes: number; periodo: string } {
    const p = valor ?? defecto;
    const m = PERIODO_RE.exec(p);
    if (!m) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    return { ejercicio: Number(m[1]), mes: Number(m[2]), periodo: p };
  }

  app.get("/despachos/:propertyId/libro/cuentas", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const r = await libroDe(c.get("db")).listarCuentas(c.req.param("propertyId"));
    // `propuestaCodigo`: el código agrupador que el catálogo base propone para la cuenta (supuesto por validar con el fiscalista); solo se aplica con una acción explícita.
    const cuentas = r.datos.map((x) => ({ ...x, nivel: x.nivel ?? 1, cuentaPadre: x.cuentaPadre ?? null, codigoAgrupador: x.codigoAgrupador ?? null, propuestaCodigo: CODIGO_AGRUPADOR_BASE[x.codigo] ?? null }));
    return c.json({ estado: r.estado, cuentas, sinCodigoAgrupador: cuentas.filter((x) => x.codigoAgrupador === null).length });
  });

  app.post("/despachos/:propertyId/libro/catalogo/sembrar", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    try {
      const agregadas = await libroDe(c.get("db")).sembrarCatalogo(propertyId, construirCatalogoBase());
      if (agregadas > 0) await auditar(c, "despachos.libro:sembrar-catalogo", { propertyId, agregadas });
      return c.json({ agregadas });
    } catch (err) {
      return traducirLibro(err);
    }
  });

  app.put("/despachos/:propertyId/libro/cuentas", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const codigo = typeof raw.codigo === "string" ? raw.codigo.trim() : "";
    const descripcion = typeof raw.descripcion === "string" ? raw.descripcion.trim() : "";
    if (!/^\d{4,10}$/.test(codigo)) throw Errors.validation("codigo: de 4 a 10 dígitos.");
    if (descripcion.length < 1 || descripcion.length > 200) throw Errors.validation("descripcion: de 1 a 200 caracteres.");
    const naturaleza = raw.naturaleza === undefined ? naturalezaPorDefecto(codigo) : raw.naturaleza;
    if (naturaleza !== "D" && naturaleza !== "A") throw Errors.validation("naturaleza: D (deudora) o A (acreedora).");
    let nivel: number | undefined;
    if (raw.nivel !== undefined && raw.nivel !== null) {
      if (typeof raw.nivel !== "number" || !Number.isInteger(raw.nivel) || raw.nivel < 1 || raw.nivel > 10) throw Errors.validation("nivel: entero de 1 a 10.");
      nivel = raw.nivel;
    }
    let cuentaPadre: string | undefined;
    if (raw.cuentaPadre !== undefined && raw.cuentaPadre !== null && raw.cuentaPadre !== "") {
      if (typeof raw.cuentaPadre !== "string" || !/^\d{4,10}$/.test(raw.cuentaPadre.trim())) throw Errors.validation("cuentaPadre: de 4 a 10 dígitos.");
      cuentaPadre = raw.cuentaPadre.trim();
    }
    let codigoAgrupador: string | undefined;
    if (raw.codigoAgrupador !== undefined && raw.codigoAgrupador !== null && raw.codigoAgrupador !== "") {
      if (typeof raw.codigoAgrupador !== "string" || !esCodigoAgrupadorSat(raw.codigoAgrupador.trim())) throw Errors.validation("codigoAgrupador: debe ser un código de la lista del Anexo 24 (por ejemplo 102.01).");
      codigoAgrupador = raw.codigoAgrupador.trim();
    }
    if ((nivel === undefined) !== (cuentaPadre === undefined) && !(nivel === 1 && cuentaPadre === undefined)) throw Errors.validation("nivel y cuentaPadre van juntos (el nivel 1 no lleva cuenta padre).");
    const propertyId = c.req.param("propertyId");
    try {
      await libroDe(c.get("db")).guardarCuenta(propertyId, { codigo, descripcion, naturaleza, nivel, cuentaPadre, codigoAgrupador });
      await auditar(c, "despachos.libro:guardar-cuenta", { propertyId, codigo, nivel: nivel ?? null, cuentaPadre: cuentaPadre ?? null, codigoAgrupador: codigoAgrupador ?? null });
      return c.json({ codigo, descripcion, naturaleza, nivel: nivel ?? null, cuentaPadre: cuentaPadre ?? null, codigoAgrupador: codigoAgrupador ?? null });
    } catch (err) {
      return traducirLibro(err);
    }
  });

  app.get("/despachos/:propertyId/libro/polizas", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
    const ejercicio = c.req.query("ejercicio") === undefined ? Number(hoy.slice(0, 4)) : Number(c.req.query("ejercicio"));
    if (!Number.isInteger(ejercicio) || ejercicio < 2014 || ejercicio > 2099) throw Errors.validation("ejercicio: entre 2014 y 2099.");
    const mesRaw = c.req.query("mes");
    const mes = mesRaw === undefined ? undefined : Number(mesRaw);
    if (mes !== undefined && (!Number.isInteger(mes) || mes < 1 || mes > 12)) throw Errors.validation("mes: de 1 a 12.");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const r = await libroDe(c.get("db")).listarPolizas(propertyId, { ejercicio, mes, limit, offset });
    return c.json({ estado: r.estado, ejercicio, mes: mes ?? null, limit, offset, polizas: r.datos });
  });

  app.get("/despachos/:propertyId/libro/polizas/:polizaId", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const polizaId = c.req.param("polizaId");
    if (!UUID_RE.test(polizaId)) throw Errors.notFound("Póliza no encontrada.");
    const poliza = await libroDe(c.get("db")).obtenerPoliza(c.req.param("propertyId"), polizaId);
    if (!poliza) throw Errors.notFound("Póliza no encontrada.");
    return c.json(poliza);
  });

  app.post("/despachos/:propertyId/libro/polizas", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const v = validarPolizaEntrada(raw);
    if (!v.ok) throw Errors.validation(v.errores.map((e) => `${e.campo}: ${e.mensaje}`).join(" "));
    const propertyId = c.req.param("propertyId");
    const repo = libroDe(c.get("db"));
    try {
      await asegurarCatalogo(repo, propertyId);
      const r = await repo.registrarPoliza(propertyId, v.valor);
      await auditar(c, "despachos.libro:registrar-poliza", { propertyId, polizaId: r.polizaId, tipo: v.valor.tipo, folio: r.folio });
      return c.json({ polizaId: r.polizaId, folio: r.folio, tipo: v.valor.tipo, fecha: v.valor.fecha }, 201);
    } catch (err) {
      return traducirLibro(err);
    }
  });

  app.post("/despachos/:propertyId/libro/polizas/desde-cfdi", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<{ invoiceId?: unknown; cuentaGasto?: unknown; tratamientoIeps?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.invoiceId !== "string" || !UUID_RE.test(raw.invoiceId)) throw Errors.validation("invoiceId: se esperaba el id del CFDI.");
    const opciones: { cuentaGasto?: string; tratamientoIeps?: "costo" | "acreditable" } = {};
    if (raw.cuentaGasto !== undefined && raw.cuentaGasto !== null && raw.cuentaGasto !== "") {
      if (typeof raw.cuentaGasto !== "string" || !/^\d{4,10}$/.test(raw.cuentaGasto.trim())) throw Errors.validation("cuentaGasto: de 4 a 10 dígitos.");
      opciones.cuentaGasto = raw.cuentaGasto.trim();
    }
    if (raw.tratamientoIeps !== undefined && raw.tratamientoIeps !== null) {
      if (raw.tratamientoIeps !== "costo" && raw.tratamientoIeps !== "acreditable") throw Errors.validation("tratamientoIeps: costo o acreditable.");
      opciones.tratamientoIeps = raw.tratamientoIeps;
    }
    const propertyId = c.req.param("propertyId");
    const factura = await deps.despachosRepo(c.get("db")).findInvoice(propertyId, raw.invoiceId);
    if (!factura) throw Errors.notFound("CFDI no encontrado.");
    const armada = construirPolizaDesdeCfdi(factura, opciones as OpcionesPolizaCfdi);
    if (!armada.ok) throw Errors.conflict(armada.motivo);
    const repo = libroDe(c.get("db"));
    try {
      // Con retenciones, IEPS o un cliente anterior a las cuentas de impuestos retenidos, completa el catálogo base antes de registrar.
      await asegurarCuentas(repo, propertyId, armada.poliza.movimientos.map((m) => m.cuenta));
      const r = await repo.registrarPoliza(propertyId, armada.poliza, factura.id);
      await auditar(c, "despachos.libro:poliza-desde-cfdi", { propertyId, polizaId: r.polizaId, invoiceId: factura.id, tipo: armada.poliza.tipo, folio: r.folio });
      return c.json({ polizaId: r.polizaId, folio: r.folio, tipo: armada.poliza.tipo, fecha: armada.poliza.fecha }, 201);
    } catch (err) {
      return traducirLibro(err);
    }
  });

  app.post("/despachos/:propertyId/libro/polizas/:polizaId/reversar", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const polizaId = c.req.param("polizaId");
    if (!UUID_RE.test(polizaId)) throw Errors.notFound("Póliza no encontrada.");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    if (!esFechaValida(raw.fecha)) throw Errors.validation("fecha: fecha de la póliza de reversa (AAAA-MM-DD).");
    const concepto = typeof raw.concepto === "string" ? raw.concepto.trim() : "";
    if (concepto.length < 1 || concepto.length > 300) throw Errors.validation("concepto: de 1 a 300 caracteres.");
    const propertyId = c.req.param("propertyId");
    try {
      const r = await libroDe(c.get("db")).reversarPoliza(propertyId, polizaId, raw.fecha, concepto);
      await auditar(c, "despachos.libro:reversar-poliza", { propertyId, polizaOriginalId: polizaId, polizaId: r.polizaId, folio: r.folio });
      return c.json({ polizaId: r.polizaId, folio: r.folio }, 201);
    } catch (err) {
      return traducirLibro(err);
    }
  });

  const MAX_CFDI_LISTADO = 500;

  app.get("/despachos/:propertyId/libro/cfdi", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const despachos = deps.despachosRepo(db);
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(despachos, propertyId));
    const { periodo } = periodoDe(c.req.query("periodo"), hoy.slice(0, 7));
    // El filtro por periodo usa `invoice.fecha` (migracion 006): contra una base que no la tiene, 503 honesto (nunca un 500).
    const facturas = await leerFuenteOpcional(despachos, () => despachos.listInvoices(propertyId, { periodo }));
    if (facturas === null) throw Errors.serviceUnavailable("Los CFDI por periodo aún no están disponibles en esta base de datos: falta aplicar la migración 006.");
    const visibles = facturas.slice(0, MAX_CFDI_LISTADO);
    const polizas = await libroDe(db).polizasDeCfdi(propertyId, visibles.map((f) => f.id));
    return c.json({
      periodo,
      truncado: facturas.length > MAX_CFDI_LISTADO,
      cfdi: visibles.map((f) => {
        const poliza = polizas.get(f.id) ?? null;
        const armada = construirPolizaDesdeCfdi(f);
        return {
          id: f.id,
          folioFiscal: f.folioFiscal,
          tipo: f.tipo,
          direccion: f.direccion ?? null,
          fecha: f.fecha,
          totalCentavos: f.totalCentavos ?? Math.round(f.total * 100),
          estadoSat: f.estadoSat ?? "pendiente",
          poliza: poliza ? { id: poliza.id, folio: poliza.folio, tipo: poliza.tipo } : null,
          armable: poliza === null && armada.ok,
          motivo: poliza === null && !armada.ok ? armada.motivo : null,
        };
      }),
    });
  });

  app.get("/despachos/:propertyId/libro/balanza", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
    const { ejercicio, mes, periodo } = periodoDe(c.req.query("periodo"), hoy.slice(0, 7));
    const r = await libroDe(c.get("db")).balanza(propertyId, ejercicio, mes);
    return c.json({ estado: r.estado, periodo, lineas: r.datos, totales: totalesBalanza(r.datos) });
  });

  app.get("/despachos/:propertyId/libro/contabilidad-electronica", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    // D-30: misma exportacion fiscal que `POST .../contabilidad-electronica/paquete` (desde el libro) -> mismo segundo factor.
    await exigirStepUpDespachos(deps, c);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(db), propertyId));
    const { ejercicio, mes, periodo } = periodoDe(c.req.query("periodo"), hoy.slice(0, 7));
    const ficha = await carteraDe(db).obtenerFicha(propertyId);
    if (!ficha) throw Errors.conflict("Captura la ficha del cliente (RFC y razón social) en Cartera antes de generar la contabilidad electrónica.");
    const repo = libroDe(db);
    const [cuentas, balanza] = [await repo.listarCuentas(propertyId), await repo.balanza(propertyId, ejercicio, mes)];
    if (cuentas.estado === "no_disponible" || balanza.estado === "no_disponible") throw Errors.serviceUnavailable("El libro contable todavía no está disponible en esta base (migración pendiente).");
    if (balanza.datos.length === 0) throw Errors.conflict(`El libro no tiene movimientos en ${periodo}: no hay balanza que generar.`);
    const tipoEnvioCrudo = c.req.query("tipoEnvio") ?? "N";
    if (tipoEnvioCrudo !== "N" && tipoEnvioCrudo !== "C") throw Errors.validation("tipoEnvio: N (normal) o C (complementaria).");
    const fechaModBal = c.req.query("fechaModBal") || undefined;
    let paquete;
    try {
      paquete = generarPaqueteDesdeLibro({ cuentas: cuentas.datos, balanza: balanza.datos, ejercicio, mes, rfc: ficha.rfc, razonSocial: ficha.razonSocial, generadoEn: new Date().toISOString(), tipoEnvio: tipoEnvioCrudo, fechaModBal });
    } catch (err) {
      return respuestaErrorXml(c, err);
    }
    await auditarAccesoDespachos(deps, c, { recurso: "libro.contabilidad_electronica", tipo: "export", metadata: { periodo, tipoEnvio: tipoEnvioCrudo } });
    return c.json({
      periodo,
      estado: paquete.estado,
      nota: "XML conforme al XSD 1.3 del SAT (validado contra el esquema oficial en las pruebas); no se ha enviado ni firmado: el envío y la e.firma son humanos (queda en la lista de preguntas al fiscalista).",
      catalogo: paquete.catalogo,
      balanza: paquete.balanza,
      resumen: { cuentas: paquete.resumenBalanza.cuentas, totalDebe: paquete.resumenBalanza.totalDebe, totalHaber: paquete.resumenBalanza.totalHaber, cuadrada: paquete.resumenBalanza.cuadrada, saldosAnomalos: paquete.resumenBalanza.saldosAnomalos },
    });
  });

  /** Errores del generador de XML -> respuesta: cuentas sin código agrupador = 409 con la lista (el staff las asigna en la pestaña Catálogo); datos que el XSD no admite = 409. */
  function respuestaErrorXml(c: Context<CoreAuthHonoEnv>, err: unknown): Response {
    if (err instanceof CatalogoSinCodigoAgrupadorError) {
      const lista = err.cuentas.slice(0, 15).map((x) => x.codigo).join(", ");
      return c.json({ code: "catalogo_sin_codigo_agrupador", message: `${err.message} Cuentas: ${lista}${err.cuentas.length > 15 ? ", ..." : ""}.`, cuentasSinCodigo: err.cuentas.slice(0, 200), total: err.cuentas.length }, 409);
    }
    if (err instanceof ContabilidadElectronicaDatosInvalidosError) throw Errors.conflict(err.message);
    if (err instanceof Error && /^Catálogo inválido/.test(err.message)) throw Errors.conflict(err.message);
    throw err;
  }

  // ---- Código agrupador del SAT (D-P3-16) -------------------------------------------------------------------------------------------------------------

  app.post("/despachos/:propertyId/libro/catalogo/agrupadores", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<{ asignaciones?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    if (!Array.isArray(raw.asignaciones) || raw.asignaciones.length < 1 || raw.asignaciones.length > 500) throw Errors.validation("asignaciones: de 1 a 500 elementos {codigo, codigoAgrupador}.");
    const asignaciones = raw.asignaciones.map((x, i) => {
      const a = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const codigo = typeof a.codigo === "string" ? a.codigo.trim() : "";
      const codigoAgrupador = typeof a.codigoAgrupador === "string" ? a.codigoAgrupador.trim() : "";
      if (!/^\d{4,10}$/.test(codigo)) throw Errors.validation(`asignaciones[${i}].codigo: de 4 a 10 dígitos.`);
      if (!esCodigoAgrupadorSat(codigoAgrupador)) throw Errors.validation(`asignaciones[${i}].codigoAgrupador: debe ser un código de la lista del Anexo 24 (por ejemplo 102.01).`);
      return { codigo, codigoAgrupador };
    });
    const propertyId = c.req.param("propertyId");
    try {
      const actualizadas = await libroDe(c.get("db")).asignarCodigosAgrupadores(propertyId, asignaciones);
      await auditar(c, "despachos.libro:asignar-agrupadores", { propertyId, actualizadas });
      return c.json({ actualizadas });
    } catch (err) {
      return traducirLibro(err);
    }
  });

  app.post("/despachos/:propertyId/libro/catalogo/agrupadores/proponer", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = libroDe(c.get("db"));
    try {
      const actual = await repo.listarCuentas(propertyId);
      if (actual.estado === "no_disponible") throw new LibroNoDisponibleError();
      const asignaciones = actual.datos
        .filter((x) => !x.codigoAgrupador && CODIGO_AGRUPADOR_BASE[x.codigo] !== undefined)
        .map((x) => ({ codigo: x.codigo, codigoAgrupador: CODIGO_AGRUPADOR_BASE[x.codigo] as string }));
      const sinPropuesta = actual.datos.filter((x) => !x.codigoAgrupador && CODIGO_AGRUPADOR_BASE[x.codigo] === undefined).length;
      let aplicadas = 0;
      for (let i = 0; i < asignaciones.length; i += 500) aplicadas += await repo.asignarCodigosAgrupadores(propertyId, asignaciones.slice(i, i + 500));
      if (aplicadas > 0) await auditar(c, "despachos.libro:proponer-agrupadores", { propertyId, aplicadas, sinPropuesta });
      return c.json({ aplicadas, sinPropuesta, nota: "Son propuestas del catálogo base: el fiscalista debe validarlas antes de enviar la contabilidad electrónica." });
    } catch (err) {
      return traducirLibro(err);
    }
  });

  // ---- Importación del catálogo y la balanza del proveedor anterior (D-P3-44) ----------------------------------------------------------------------------

  const MAX_XML_BODY_BYTES = 3 * 1024 * 1024;

  async function leerCuerpoXml(c: Context<CoreAuthHonoEnv>): Promise<{ xml: string; confirmar: boolean }> {
    const raw = await readJsonCapped<{ xml?: unknown; confirmar?: unknown }>(c.req.raw, MAX_XML_BODY_BYTES);
    if (typeof raw.xml !== "string" || raw.xml.trim().length === 0) throw Errors.validation("xml: se esperaba el contenido del archivo XML.");
    if (raw.confirmar !== undefined && typeof raw.confirmar !== "boolean") throw Errors.validation("confirmar: true o false.");
    return { xml: raw.xml, confirmar: raw.confirmar === true };
  }

  async function exigirFichaConRfc(c: Context<CoreAuthHonoEnv>, propertyId: string): Promise<string> {
    const ficha = await carteraDe(c.get("db")).obtenerFicha(propertyId);
    if (!ficha) throw Errors.conflict("Captura la ficha del cliente (RFC y razón social) en Cartera antes de importar contabilidad electrónica.");
    return ficha.rfc;
  }

  app.post("/despachos/:propertyId/libro/catalogo/importar", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const { xml, confirmar } = await leerCuerpoXml(c);
    const propertyId = c.req.param("propertyId");
    const rfcCliente = await exigirFichaConRfc(c, propertyId);
    const repo = libroDe(c.get("db"));
    const actual = await repo.listarCuentas(propertyId);
    if (actual.estado === "no_disponible") throw Errors.serviceUnavailable(new LibroNoDisponibleError().message);
    const existentes = new Map(actual.datos.map((x) => [x.codigo, x.nivel ?? 1] as const));
    let leido;
    try {
      leido = leerCatalogoXml(xml, existentes);
    } catch (err) {
      if (err instanceof ImportacionXmlContabilidadError) throw Errors.validation(err.message);
      throw err;
    }
    if (leido.rfc !== rfcCliente.trim().toUpperCase()) throw Errors.conflict("El RFC del archivo no coincide con el RFC del cliente: revisa que sea el catálogo de este cliente.");
    const nuevas = leido.cuentas.filter((x) => !existentes.has(x.codigo)).length;
    const resumen = {
      periodo: `${leido.ejercicio}-${String(leido.mes).padStart(2, "0")}`,
      aceptadas: leido.cuentas.length,
      nuevas,
      actualizadas: leido.cuentas.length - nuevas,
      sinCodigoAgrupador: leido.cuentas.filter((x) => x.codigoAgrupador === null).length,
      rechazadasTotal: leido.rechazadas.length,
      rechazadas: leido.rechazadas.slice(0, 100),
      advertencias: leido.advertencias,
    };
    if (!confirmar) return c.json({ ...resumen, confirmado: false });
    if (leido.cuentas.length === 0) throw Errors.conflict("El archivo no trae ninguna cuenta que se pueda importar.");
    await exigirStepUpDespachos(deps, c);
    try {
      let agregadas = 0;
      let actualizadas = 0;
      const cuentas: CuentaLibro[] = leido.cuentas.map((x) => ({ codigo: x.codigo, descripcion: x.descripcion, naturaleza: x.naturaleza, nivel: x.nivel, cuentaPadre: x.cuentaPadre, codigoAgrupador: x.codigoAgrupador }));
      for (let i = 0; i < cuentas.length; i += 500) {
        const r = await repo.importarCatalogo(propertyId, cuentas.slice(i, i + 500));
        agregadas += r.agregadas;
        actualizadas += r.actualizadas;
      }
      await auditar(c, "despachos.libro:importar-catalogo", { propertyId, agregadas, actualizadas, rechazadas: leido.rechazadas.length });
      return c.json({ ...resumen, confirmado: true, agregadas, actualizadas });
    } catch (err) {
      return traducirLibro(err);
    }
  });

  const CONCEPTO_APERTURA = "Póliza de apertura (balanza importada";

  app.post("/despachos/:propertyId/libro/apertura/importar", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const { xml, confirmar } = await leerCuerpoXml(c);
    const propertyId = c.req.param("propertyId");
    const rfcCliente = await exigirFichaConRfc(c, propertyId);
    const repo = libroDe(c.get("db"));
    const actual = await repo.listarCuentas(propertyId);
    if (actual.estado === "no_disponible") throw Errors.serviceUnavailable(new LibroNoDisponibleError().message);
    let balanza;
    try {
      balanza = leerBalanzaXml(xml);
    } catch (err) {
      if (err instanceof ImportacionXmlContabilidadError) throw Errors.validation(err.message);
      throw err;
    }
    if (balanza.rfc !== rfcCliente.trim().toUpperCase()) throw Errors.conflict("El RFC del archivo no coincide con el RFC del cliente: revisa que sea la balanza de este cliente.");
    const apertura = construirAperturaDesdeBalanza(balanza, new Map(actual.datos.map((x) => [x.codigo, x.naturaleza] as const)));
    if (!apertura.ok) return c.json({ code: "apertura_no_posible", message: apertura.motivo, cuentasFaltantes: apertura.cuentasFaltantes ?? [] }, 409);
    const concepto = `${CONCEPTO_APERTURA} ${balanza.ejercicio}-${String(balanza.mes).padStart(2, "0")})`;
    const [ejercicioApertura, mesApertura] = [Number(apertura.fecha.slice(0, 4)), Number(apertura.fecha.slice(5, 7))];
    const existentes = await repo.listarPolizas(propertyId, { ejercicio: ejercicioApertura, mes: mesApertura, limit: 200, offset: 0 });
    if (existentes.datos.some((p) => p.tipo === "diario" && !p.reversada && p.concepto === concepto)) throw Errors.conflict("Ya hay una póliza de apertura vigente para esta balanza: reviértela primero si quieres volver a importarla.");
    const resumen = { periodo: `${balanza.ejercicio}-${String(balanza.mes).padStart(2, "0")}`, tipoEnvio: balanza.tipoEnvio, fecha: apertura.fecha, partidas: apertura.partidas.length, totalCentavos: apertura.totalCentavos, concepto };
    if (!confirmar) return c.json({ ...resumen, confirmado: false });
    await exigirStepUpDespachos(deps, c);
    try {
      const r = await repo.registrarPoliza(propertyId, {
        tipo: "diario",
        fecha: apertura.fecha,
        concepto,
        movimientos: apertura.partidas.map((m) => ({ cuenta: m.cuenta, concepto: "Saldo inicial", debeCentavos: m.debeCentavos, haberCentavos: m.haberCentavos })),
      });
      await auditar(c, "despachos.libro:importar-apertura", { propertyId, polizaId: r.polizaId, folio: r.folio, partidas: apertura.partidas.length, totalCentavos: apertura.totalCentavos });
      return c.json({ ...resumen, confirmado: true, polizaId: r.polizaId, folio: r.folio }, 201);
    } catch (err) {
      return traducirLibro(err);
    }
  });

  // ---- Pólizas de cobro / pago de un complemento de pago (D-P3-17) -------------------------------------------------------------------------------------

  const UUID_REP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  app.get("/despachos/:propertyId/libro/pagos-rep", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    const propertyId = c.req.param("propertyId");
    const folioFiscalRep = c.req.query("folioFiscalRep");
    if (folioFiscalRep !== undefined && !UUID_REP_RE.test(folioFiscalRep)) throw Errors.validation("folioFiscalRep: se esperaba el UUID del complemento de pago.");
    let filtro: { folioFiscalRep?: string; ejercicio?: number; mes?: number };
    if (folioFiscalRep) filtro = { folioFiscalRep };
    else {
      const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
      const { ejercicio, mes } = periodoDe(c.req.query("periodo"), hoy.slice(0, 7));
      filtro = { ejercicio, mes };
    }
    const r = await libroDe(c.get("db")).listarPagosRep(propertyId, filtro);
    return c.json({
      estado: r.estado,
      pagos: r.datos.map((p) => {
        const armada = construirPolizaDesdeRep(p);
        return {
          pagoId: p.pagoId,
          folioFiscalRep: p.folioFiscalRep,
          folioFiscalCfdi: p.folioFiscalCfdi,
          fechaPago: p.fechaPago,
          flujo: p.flujo,
          numParcialidad: p.numParcialidad,
          importePagadoCentavos: p.importePagadoCentavos,
          ivaCentavos: p.ivaCentavos,
          poliza: p.polizaVigente,
          armable: p.polizaVigente === null && armada.ok,
          motivo: p.polizaVigente === null && !armada.ok ? armada.motivo : null,
        };
      }),
    });
  });

  const MAX_PAGOS_POR_REP = 50;

  app.post("/despachos/:propertyId/libro/polizas/desde-rep", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<{ folioFiscalRep?: unknown; pagoId?: unknown; cuentaBancos?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.folioFiscalRep !== "string" || !UUID_REP_RE.test(raw.folioFiscalRep)) throw Errors.validation("folioFiscalRep: se esperaba el UUID del complemento de pago.");
    if (raw.pagoId !== undefined && raw.pagoId !== null && (typeof raw.pagoId !== "string" || !UUID_RE.test(raw.pagoId))) throw Errors.validation("pagoId: se esperaba el id del pago.");
    let cuentaBancos: string | undefined;
    if (raw.cuentaBancos !== undefined && raw.cuentaBancos !== null && raw.cuentaBancos !== "") {
      if (typeof raw.cuentaBancos !== "string" || !/^\d{4,10}$/.test(raw.cuentaBancos.trim())) throw Errors.validation("cuentaBancos: de 4 a 10 dígitos.");
      cuentaBancos = raw.cuentaBancos.trim();
    }
    const propertyId = c.req.param("propertyId");
    const repo = libroDe(c.get("db"));
    const lectura = await repo.listarPagosRep(propertyId, { folioFiscalRep: raw.folioFiscalRep });
    if (lectura.estado === "no_disponible") throw Errors.serviceUnavailable(new LibroNoDisponibleError().message);
    const pagos = lectura.datos.filter((p) => typeof raw.pagoId !== "string" || p.pagoId === raw.pagoId);
    if (pagos.length === 0) throw Errors.notFound("No hay pagos registrados de ese complemento de pago en este cliente.");
    if (pagos.length > MAX_PAGOS_POR_REP) throw Errors.validation(`El complemento trae más de ${MAX_PAGOS_POR_REP} pagos: contabilízalos por pago.`);
    type Resultado = { pagoId: string; estado: "registrada" | "ya_existia" | "omitida" | "error"; polizaId?: string; folio?: number; motivo?: string; advertencias?: readonly string[] };
    const resultados: Resultado[] = [];
    for (const pago of pagos) {
      if (pago.polizaVigente) {
        resultados.push({ pagoId: pago.pagoId, estado: "ya_existia", polizaId: pago.polizaVigente.id, folio: pago.polizaVigente.folio });
        continue;
      }
      const armada = construirPolizaDesdeRep(pago, { cuentaBancos });
      if (!armada.ok) {
        resultados.push({ pagoId: pago.pagoId, estado: "omitida", motivo: armada.motivo });
        continue;
      }
      try {
        await asegurarCuentas(repo, propertyId, armada.poliza.movimientos.map((m) => m.cuenta));
        const r = await repo.registrarPolizaRep(propertyId, pago.pagoId, armada.poliza);
        resultados.push({ pagoId: pago.pagoId, estado: "registrada", polizaId: r.polizaId, folio: r.folio, advertencias: armada.advertencias });
      } catch (err) {
        // Un periodo cerrado o un dato inválido de UN pago no tumba los demás; permisos y base sin migrar sí cortan todo.
        if (err instanceof PeriodoLibroCerradoError || err instanceof PolizaDuplicadaError || err instanceof LibroDatosInvalidosError || err instanceof LibroTopeExcedidoError) {
          resultados.push({ pagoId: pago.pagoId, estado: "error", motivo: err.message });
          continue;
        }
        return traducirLibro(err);
      }
    }
    const registradas = resultados.filter((r) => r.estado === "registrada").length;
    if (registradas > 0) await auditar(c, "despachos.libro:poliza-desde-rep", { propertyId, folioFiscalRep: raw.folioFiscalRep, registradas, total: resultados.length });
    return c.json({ folioFiscalRep: raw.folioFiscalRep, registradas, resultados }, registradas > 0 ? 201 : 200);
  });

  // ---- XML de pólizas del periodo (D-P3-16) ------------------------------------------------------------------------------------------------------------

  const MAX_POLIZAS_XML = 5000;

  app.get("/despachos/:propertyId/libro/contabilidad-electronica/polizas", async (c) => {
    assertVerticalRole(c, VER_LIBRO_ROLES);
    // Misma exportación fiscal que el catálogo y la balanza -> mismo segundo factor.
    await exigirStepUpDespachos(deps, c);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(db), propertyId));
    const { ejercicio, mes, periodo } = periodoDe(c.req.query("periodo"), hoy.slice(0, 7));
    const tipoSolicitud = c.req.query("tipoSolicitud");
    if (!tipoSolicitud || !(TIPOS_SOLICITUD_POLIZAS as readonly string[]).includes(tipoSolicitud)) throw Errors.validation("tipoSolicitud: AF, FC, DE o CO (lo fija la orden o el trámite de la autoridad).");
    const ficha = await carteraDe(db).obtenerFicha(propertyId);
    if (!ficha) throw Errors.conflict("Captura la ficha del cliente (RFC y razón social) en Cartera antes de generar la contabilidad electrónica.");
    const repo = libroDe(db);
    const [cuentas, polizas] = [await repo.listarCuentas(propertyId), await repo.polizasDelPeriodo(propertyId, ejercicio, mes, MAX_POLIZAS_XML).catch((err) => traducirLibro(err))];
    if (cuentas.estado === "no_disponible" || polizas.estado === "no_disponible") throw Errors.serviceUnavailable("El libro contable todavía no está disponible en esta base (migración pendiente).");
    if (polizas.datos.length === 0) throw Errors.conflict(`El libro no tiene pólizas en ${periodo}: no hay nada que declarar.`);
    let xml: string;
    try {
      xml = generarXmlPolizasPeriodo(
        polizas.datos.map((p) => ({ tipo: p.tipo, folio: p.folio, fecha: p.fecha, concepto: p.concepto, movimientos: p.movimientos })),
        new Map(cuentas.datos.map((x) => [x.codigo, x.descripcion] as const)),
        { rfc: ficha.rfc, ejercicio, mes, tipoSolicitud: tipoSolicitud as TipoSolicitudPolizas, numOrden: c.req.query("numOrden") || undefined, numTramite: c.req.query("numTramite") || undefined },
      );
    } catch (err) {
      if (err instanceof ContabilidadElectronicaDatosInvalidosError) throw Errors.validation(err.message);
      throw err;
    }
    await auditarAccesoDespachos(deps, c, { recurso: "libro.contabilidad_electronica_polizas", tipo: "export", metadata: { periodo, tipoSolicitud, polizas: polizas.datos.length } });
    return c.json({
      periodo,
      tipoSolicitud,
      polizas: polizas.datos.length,
      xml,
      sha1: calcularHashSha1(xml),
      nota: "XML de pólizas conforme al XSD 1.3 (sin nodos de complemento: CFDI, cheque y transferencia son opcionales y el libro aún no guarda esos datos). No se ha enviado ni firmado.",
    });
  });

  return app;
}
