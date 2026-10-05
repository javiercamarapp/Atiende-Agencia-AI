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
//  POST /despachos/:propertyId/libro/polizas/generar-periodo      D-P3-14: registra la poliza de cada CFDI del periodo que ya se puede contabilizar (mismas reglas del cron diario)
//  GET  /despachos/:propertyId/libro/balanza?periodo=YYYY-MM       balanza derivada
//  GET  /despachos/:propertyId/libro/contabilidad-electronica?periodo=YYYY-MM   catálogo + balanza XML con SHA-1
//
// Autorización: ver = VER_LIBRO_ROLES; escribir = GESTIONAR_LIBRO_ROLES (admin/contador); la membresía de la property aplica igual
// que en el resto. La base repite todo (funciones security definer con guard). Cada escritura deja bitácora (despachos.audit_log).
// Compatibilidad con la base sin migrar: las lecturas responden `estado: "no_disponible"` con vacío honesto y las escrituras 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  GESTIONAR_LIBRO_ROLES,
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  LibroSinPermisoError,
  LibroTopeExcedidoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
  PostgresCarteraRepository,
  PostgresLibroRepository,
  VER_LIBRO_ROLES,
  construirCatalogoBase,
  construirPolizaDesdeCfdi,
  estaPeriodoCerrado,
  evaluarCompuertaClasificacion,
  esFechaValida,
  generarPaqueteDesdeLibro,
  leerFuenteOpcional,
  naturalezaPorDefecto,
  totalesBalanza,
  validarPolizaEntrada,
} from "@atiende/domain-despachos";
import type { CarteraRepository, LibroRepository, PolizaInput } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { exigirStepUpDespachos } from "./step-up.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";
import { clasificacionDe } from "./clasificacion-deps.ts";

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
    return c.json({ estado: r.estado, cuentas: r.datos });
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
    const propertyId = c.req.param("propertyId");
    try {
      await libroDe(c.get("db")).guardarCuenta(propertyId, { codigo, descripcion, naturaleza });
      await auditar(c, "despachos.libro:guardar-cuenta", { propertyId, codigo });
      return c.json({ codigo, descripcion, naturaleza });
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
    const raw = await readJsonCapped<{ invoiceId?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.invoiceId !== "string" || !UUID_RE.test(raw.invoiceId)) throw Errors.validation("invoiceId: se esperaba el id del CFDI.");
    const propertyId = c.req.param("propertyId");
    const factura = await deps.despachosRepo(c.get("db")).findInvoice(propertyId, raw.invoiceId);
    if (!factura) throw Errors.notFound("CFDI no encontrado.");
    const cls = (await clasificacionDe(deps, c.get("db")).vigentes(propertyId, [factura.id])).datos.get(factura.id);
    const armada = construirPolizaDesdeCfdi(factura, cls ? { categoria: cls.categoria, cuenta: cls.cuenta } : null);
    if (!armada.ok) throw Errors.conflict(armada.motivo);
    const repo = libroDe(c.get("db"));
    try {
      await asegurarCatalogo(repo, propertyId);
      const r = await repo.registrarPoliza(propertyId, armada.poliza, factura.id);
      await auditar(c, "despachos.libro:poliza-desde-cfdi", { propertyId, polizaId: r.polizaId, invoiceId: factura.id, tipo: armada.poliza.tipo, folio: r.folio });
      return c.json({ polizaId: r.polizaId, folio: r.folio, tipo: armada.poliza.tipo, fecha: armada.poliza.fecha }, 201);
    } catch (err) {
      return traducirLibro(err);
    }
  });

  /**
   * D-P3-14 -- «Generar pólizas del periodo»: registra la póliza de cada CFDI del periodo que ya se puede contabilizar solo. MISMAS reglas que el cron diario
   * (`/internal/despachos/polizas-periodo`), con UNA diferencia: el boton tambien contabiliza un CFDI sin fila de clasificacion (usa la categoria gruesa), mientras el cron
   * exige clasificacion: clasificado con confianza suficiente (o por una persona), sin revisión pendiente, no cancelado ni excluido, sentido
   * conocido, periodo abierto, sin póliza vigente y armable sin inventar (`construirPolizaDesdeCfdi`). Idempotente: lo que ya tiene póliza no se repite. El resto
   * se devuelve con su motivo, para que el staff lo registre a mano. Cada póliza corre en su SAVEPOINT: una que falla no tumba las demás ni la transacción.
   */
  app.post("/despachos/:propertyId/libro/polizas/generar-periodo", async (c) => {
    assertVerticalRole(c, GESTIONAR_LIBRO_ROLES);
    const raw = await readJsonCapped<{ periodo?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.periodo !== "string") throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    const { periodo, ejercicio, mes } = periodoDe(raw.periodo, raw.periodo);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const despachos = deps.despachosRepo(db);
    const repo = libroDe(db);
    const clasificacion = clasificacionDe(deps, db);

    if (estaPeriodoCerrado(await despachos.findPeriodoCierrePorAnioMes(propertyId, ejercicio, mes))) throw Errors.despachosPeriodoCerrado(periodo);
    // `invoice.fecha` (migracion 006): sin ella 503 honesto, igual que `GET .../libro/cfdi`.
    const facturas = await leerFuenteOpcional(despachos, () => despachos.listInvoices(propertyId, { periodo }));
    if (facturas === null) throw Errors.serviceUnavailable("Los CFDI por periodo aún no están disponibles en esta base de datos: falta aplicar la migración 006.");

    const ids = facturas.map((f) => f.id);
    const vigentes = (await clasificacion.vigentes(propertyId, ids)).datos;
    const config = await clasificacion.leerConfig(propertyId);
    const conPoliza = await repo.polizasDeCfdi(propertyId, ids);
    const pendientes = new Set((await despachos.listPendingReviews(propertyId)).map((r) => r.invoiceId));

    let yaTenian = 0;
    let porRevision = 0;
    let porClasificacion = 0;
    const noArmables: { readonly folioFiscal: string; readonly motivo: string }[] = [];
    const aRegistrar: { readonly factura: (typeof facturas)[number]; readonly poliza: PolizaInput }[] = [];
    for (const f of facturas) {
      if (conPoliza.has(f.id)) {
        yaTenian += 1;
        continue;
      }
      if (f.tipo !== "I" || f.estadoSat === "cancelado") continue;
      if (pendientes.has(f.id)) {
        porRevision += 1;
        continue;
      }
      const cls = vigentes.get(f.id) ?? null;
      // Con clasificacion vigente debe pasar la misma compuerta de la ingesta; sin ella (base sin la 026) manda la categoria gruesa, como siempre.
      if (cls) {
        const porPersona = cls.metodo === "manual" || cls.metodo === "correccion";
        if (!porPersona && (cls.empate || evaluarCompuertaClasificacion(cls.confianza ?? 0, { umbral: config.umbral }).requiereRevision)) {
          porClasificacion += 1;
          continue;
        }
      }
      const armada = construirPolizaDesdeCfdi(f, cls ? { categoria: cls.categoria, cuenta: cls.cuenta } : null);
      if (!armada.ok) {
        if (noArmables.length < 50) noArmables.push({ folioFiscal: f.folioFiscal, motivo: armada.motivo });
        continue;
      }
      aRegistrar.push({ factura: f, poliza: armada.poliza });
    }

    let generadas = 0;
    const fallidas: { readonly folioFiscal: string; readonly motivo: string }[] = [];
    try {
      if (aRegistrar.length > 0) await asegurarCatalogo(repo, propertyId);
      for (const { factura, poliza } of aRegistrar) {
        try {
          await runWithSavepointFallback({
            session: db,
            primary: () => repo.registrarPoliza(propertyId, poliza, factura.id),
            isRecoverable: () => true,
            fallback: (e) => Promise.reject(e),
          });
          generadas += 1;
        } catch (err) {
          if (err instanceof PolizaDuplicadaError) {
            yaTenian += 1;
          } else if (err instanceof LibroDatosInvalidosError || err instanceof PeriodoLibroCerradoError || err instanceof LibroSinPermisoError) {
            fallidas.push({ folioFiscal: factura.folioFiscal, motivo: err.message });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      return traducirLibro(err);
    }

    if (generadas > 0) {
      const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(despachos, propertyId));
      await emitirNotificacion(db, { evento: "despachos.libro.polizas_generadas", organizationId: c.get("organizationId"), propertyId, clave: `${propertyId}:${hoy}`, parametros: { cantidad: generadas }, entidadTipo: "property", entidadId: propertyId });
    }
    await auditar(c, "despachos.libro:polizas-periodo", { propertyId, periodo, generadas, yaTenian, noArmables: noArmables.length, fallidas: fallidas.length });
    return c.json({ periodo, candidatos: facturas.length, generadas, yaTenian, porRevision, porClasificacion, noArmables, fallidas });
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
    // D-P3-14: la clasificacion vigente de cada CFDI manda sobre la categoria gruesa al armar la poliza (sin la migracion 026 no hay: se usa la gruesa de siempre).
    const clasificaciones = (await clasificacionDe(deps, db).vigentes(propertyId, visibles.map((f) => f.id))).datos;
    return c.json({
      periodo,
      truncado: facturas.length > MAX_CFDI_LISTADO,
      cfdi: visibles.map((f) => {
        const poliza = polizas.get(f.id) ?? null;
        const cls = clasificaciones.get(f.id);
        const armada = construirPolizaDesdeCfdi(f, cls ? { categoria: cls.categoria, cuenta: cls.cuenta } : null);
        return {
          id: f.id,
          folioFiscal: f.folioFiscal,
          tipo: f.tipo,
          direccion: f.direccion ?? null,
          fecha: f.fecha,
          totalCentavos: f.totalCentavos ?? Math.round(f.total * 100),
          estadoSat: f.estadoSat ?? "pendiente",
          poliza: poliza ? { id: poliza.id, folio: poliza.folio, tipo: poliza.tipo } : null,
          categoriaContable: cls?.categoria ?? null,
          confianzaClasificacion: cls?.confianza ?? null,
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
    await auditarAccesoDespachos(deps, c, { recurso: "libro.contabilidad_electronica", tipo: "export", metadata: { periodo } });
    const paquete = generarPaqueteDesdeLibro({ cuentas: cuentas.datos, balanza: balanza.datos, ejercicio, mes, rfc: ficha.rfc, razonSocial: ficha.razonSocial, generadoEn: new Date().toISOString() });
    return c.json({
      periodo,
      estado: paquete.estado,
      nota: "XML generado desde el libro; no se ha cotejado con el validador del SAT (queda en la lista de preguntas al fiscalista).",
      catalogo: paquete.catalogo,
      balanza: paquete.balanza,
      resumen: { cuentas: paquete.resumenBalanza.cuentas, totalDebe: paquete.resumenBalanza.totalDebe, totalHaber: paquete.resumenBalanza.totalHaber, cuadrada: paquete.resumenBalanza.cuadrada, saldosAnomalos: paquete.resumenBalanza.saldosAnomalos },
    });
  });

  return app;
}
