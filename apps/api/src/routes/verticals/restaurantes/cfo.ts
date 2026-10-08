// CFO de restaurantes (v1): API de lectura, captura y SoftRestaurant bajo `/v1/restaurantes/:propertyId/admin/cfo/*`.
// Diseño: work/briefs/restaurantes-cfo/00-diseno.md (§3, §4.1, §4.5, §4.6) y 05-repos-y-api.md.
//
// Seguridad y alcance:
//  - Middleware: authMiddleware -> dbSession -> requirePropertyMembership. Rol por ACCIÓN (roles.ts): `cfo.ver`, `cfo.capturar`, `cfo.importar_sr`,
//    `cfo.exportar`, todas SOLO owner/admin; staff y repartidor reciben 403. Un admin acotado (`membership.property_ids`) ve solo SUS sucursales,
//    «Todas» = las suyas, y nunca la fila «No asignado» (LLM de la organización ni costos organizacionales).
//  - `sucursales=<ids>`: el alcance del actor sale de `resolveEffectivePropertyIds` (membresía) y cada id se valida contra ese alcance; una sucursal ajena, de otra organización o inexistente da el MISMO 403
//    «No tienes acceso a esta sucursal.» (no revela si existe). La base vuelve a validar cada sucursal (doble puerta).
//  - Todas las funciones SQL son SECURITY DEFINER con su propia puerta; esta capa NO escribe DML: toda escritura pasa por funciones definer
//    (cfo_config_guardar, cfo_costo_guardar, sr_importar, cfo_registrar_exportacion) que dejan la bitácora.
//
// Estados honestos:
//  - Base sin la migración 081/082/083: 200 con `disponible: false` y `bloques` (lecturas); 503 en escrituras. Nunca 500.
//  - SQL 22023 -> 400 (parámetro inválido); 42501 -> 403; query inválida (fecha, > 400 días, > 20 sucursales) -> 422; cuerpo > 5 MB -> 413.
//  - Sin PII en ninguna respuesta. La exportación a Excel/PDF es CFO-06; aquí solo se registra la intención (`POST /exportaciones`).
//  - Lecturas con `ETag` débil + `Cache-Control: private, no-cache` (revalidación barata con If-None-Match).
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { consumeRateLimit } from "@atiende/domain-restaurantes";
import {
  CfoNoDisponibleError,
  CfoParametroInvalidoError,
  CfoSinAccesoError,
  MAX_RENGLONES_SR,
  ServicioCfo,
  normalizarExportSr,
  renglonesSqlCuentas,
  renglonesSqlResumen,
} from "@atiende/domain-restaurantes/cfo";
import type { CfoRepository, ConsultaCfo, VistaPreviaSr, ImportacionSrVista, AlcanceSucursales, SucursalApi } from "@atiende/domain-restaurantes/cfo";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import {
  CFO_BODY_MAX_BYTES,
  parsearConfig,
  parsearConsulta,
  parsearCostos,
  parsearCuerpoSr,
  parsearCursor,
  parsearExportacion,
  parsearFiltroPedidos,
  parsearHistorial,
  parsearLimite,
  parsearOrden,
  parsearRangoMeses,
  parsearSucursales,
  invalido,
  type ConsultaParseada,
} from "./cfo-esquemas.ts";

const BASE = "/v1/restaurantes/:propertyId/admin/cfo";
const MENSAJE_SIN_ACCESO = "No tienes acceso a esta sucursal.";

/** Tope de lecturas y escrituras por persona autenticada y organización (la llave es organización:usuario, sin IP; el CFO consulta mucho SQL): 429 con Retry-After al excederlo. */
export const CFO_LIMITES = { lecturaPorMin: 120, escrituraPorMin: 30, importarPor10Min: 10 } as const;

export interface ContextoCfo {
  readonly servicio: ServicioCfo;
  readonly repo: CfoRepository;
  readonly organizationId: string;
  readonly alcance: AlcanceSucursales;
  readonly sucursales: readonly SucursalApi[];
  /** Todas las sucursales activas que este actor puede ver (para validar ids de cuerpo). */
  readonly permitidas: readonly SucursalApi[];
  readonly propertyIdsSql: readonly string[] | null;
}

/** Constantes y ayudas que comparte `cfo-exportar.ts` (CFO-06): el mismo alcance, el mismo mapeo de errores. */
export const MENSAJE_SIN_ACCESO_CFO = MENSAJE_SIN_ACCESO;

export function repoCfoDe(deps: AppDeps, c: Context<CoreAuthHonoEnv>): CfoRepository {
  if (!deps.cfoRestaurantesRepo) throw Errors.serviceUnavailable("El CFO no está disponible en este despliegue.");
  return deps.cfoRestaurantesRepo(c.get("db"));
}


/** Errores del repositorio -> HTTP. 22023 -> 400, 42501 -> 403 (mismo mensaje para ajena e inexistente), escritura sin migrar -> 503. */
export async function protegidoCfo<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof CfoParametroInvalidoError) throw Errors.validation(err.message);
    if (err instanceof CfoSinAccesoError) throw Errors.forbidden(MENSAJE_SIN_ACCESO);
    if (err instanceof CfoNoDisponibleError) throw Errors.serviceUnavailable("Esta función del CFO todavía no está disponible: falta aplicar la actualización de base de datos correspondiente.");
    throw err;
  }
}


/** Resuelve el alcance del actor y arma el servicio. `ids === null` = «todas». */
export async function construirContextoCfo(deps: AppDeps, c: Context<CoreAuthHonoEnv>, ids: readonly string[] | null): Promise<ContextoCfo> {
  const repo = repoCfoDe(deps, c);
  const organizationId = c.get("organizationId");
  const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
  // TODAS las sucursales de la organización (también las inactivas con historia): es el MISMO conjunto que usa la SQL (`branch_detail`) cuando recibe
  // p_props = null. Si el alcance se armara solo con las activas, el conjunto de clientes incluiría sucursales que las filas por sucursal descartan y
  // el consolidado no cuadraría. Las inactivas se marcan `activa: false` para que la UI las rotule.
  const ramas = await deps.restaurantesRepo(c.get("db")).listBranchesForOrganizationAdmin(organizationId);
  const organizacionCompleta = scope === null;
  const permitidas: SucursalApi[] = ramas
    .filter((b) => organizacionCompleta || (scope as readonly string[]).includes(b.propertyId))
    .map((b) => ({ propertyId: b.propertyId, nombre: b.name, slug: b.slug, activa: b.status === "active" }));
  let elegidas: readonly SucursalApi[];
  let propertyIdsSql: readonly string[] | null;
  if (ids === null) {
    elegidas = permitidas;
    // Org completa: null deja que la SQL incluya «No asignado». Admin acotado: su lista explícita (la SQL la valida de nuevo).
    propertyIdsSql = organizacionCompleta ? null : permitidas.map((p) => p.propertyId);
  } else {
    const validas: SucursalApi[] = [];
    for (const id of ids) {
      // Ajena, de otra organización o inexistente: el mismo 403, sin revelar cuál (`permitidas` ya está acotada por la membresía).
      const s = permitidas.find((p) => p.propertyId === id);
      if (!s) throw Errors.forbidden(MENSAJE_SIN_ACCESO);
      validas.push(s);
    }
    elegidas = validas;
    propertyIdsSql = validas.map((v) => v.propertyId);
  }
  const alcance: AlcanceSucursales = { propertyIds: elegidas.map((s) => s.propertyId), todas: ids === null, organizacionCompleta };
  const servicio = new ServicioCfo({
    repo, organizationId, alcance, propertyIdsSql, sucursales: elegidas, ahora: new Date(),
    // Un bloque que falla con un error no recuperable se degrada (bloques.<x>: false); aquí queda el rastro para operación.
    onError: (bloque, err) => logEvent(c, "error", "restaurantes_cfo_bloque_degradado", { organizationId, bloque, message: err instanceof Error ? err.message : String(err) }),
  });
  return { servicio, repo, organizationId, alcance, sucursales: elegidas, permitidas, propertyIdsSql };
}


export function restaurantesCfoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use(`${BASE}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- infraestructura ---------------------------------------------------------------------------------------------------------------------

  const repoDe = (c: Context<CoreAuthHonoEnv>): CfoRepository => repoCfoDe(deps, c);
  const protegido = protegidoCfo;
  const contexto = (c: Context<CoreAuthHonoEnv>, ids: readonly string[] | null): Promise<ContextoCfo> => construirContextoCfo(deps, c, ids);

  async function limitar(c: Context<CoreAuthHonoEnv>, scope: string, max: number, ventanaSeg: number): Promise<void> {
    const r = await consumeRateLimit(deps.restaurantesRepo(c.get("db")), scope, `${c.get("organizationId")}:${c.get("userId")}`, max, ventanaSeg);
    if (!r.allowed) throw Errors.tooManyRequests();
  }

  /** JSON con ETag débil: si el cliente ya tiene esta versión, 304 sin cuerpo. */
  function jsonConEtag(c: Context<CoreAuthHonoEnv>, data: unknown): Response {
    const texto = JSON.stringify(data);
    const etag = `W/"${createHash("sha256").update(texto).digest("base64url").slice(0, 22)}"`;
    const headers: Record<string, string> = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Authorization" };
    const previo = c.req.header("if-none-match");
    if (previo && previo.split(",").some((x) => x.trim() === etag)) return new Response(null, { status: 304, headers });
    return new Response(texto, { status: 200, headers: { ...headers, "content-type": "application/json; charset=UTF-8" } });
  }

  const consultaDe = (q: ConsultaParseada): ConsultaCfo => ({ desde: q.desde, hasta: q.hasta, comparar: q.comparar, granularidad: q.granularidad });

  /** Ruta de lectura: rol, tope por persona, query, alcance y respuesta con ETag. */
  function lectura(path: string, armar: (ctx: ContextoCfo, q: ConsultaParseada, c: Context<CoreAuthHonoEnv>) => Promise<unknown>): void {
    app.get(`${BASE}${path}`, async (c) => {
      assertAccion(c, "cfo.ver");
      await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
      const q = parsearConsulta((k) => c.req.query(k));
      return protegido(async () => jsonConEtag(c, await armar(await contexto(c, q.sucursales), q, c)));
    });
  }

  // ---- lecturas ------------------------------------------------------------------------------------------------------------------------------

  app.get(`${BASE}/alcance`, async (c) => {
    assertAccion(c, "cfo.ver");
    await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
    return protegido(async () => jsonConEtag(c, await (await contexto(c, parsearSucursales(c.req.query("sucursales")))).servicio.alcanceVista()));
  });

  lectura("/resumen", (ctx, q, c) => ctx.servicio.resumen(consultaDe(q), parsearOrden(c.req.query("orden"))));
  lectura("/ventas", (ctx, q) => ctx.servicio.ventasVista(consultaDe(q)));
  lectura("/sucursales", (ctx, q) => ctx.servicio.sucursalesVista(consultaDe(q)));
  lectura("/estado-resultados", (ctx, q) => ctx.servicio.estadoResultados(consultaDe(q)));
  lectura("/clientes", (ctx, q) => ctx.servicio.clientesVista(consultaDe(q)));
  lectura("/productos", (ctx, q) => ctx.servicio.productosVista(consultaDe(q)));
  lectura("/patrones", (ctx, q) => ctx.servicio.patronesVista(consultaDe(q)));
  lectura("/operacion", (ctx, q) => ctx.servicio.operacionVista(consultaDe(q)));
  lectura("/pedidos", (ctx, q, c) => ctx.servicio.pedidosVista(consultaDe(q), parsearFiltroPedidos(c.req.query("filtro")), parsearLimite(c.req.query("limite")), parsearCursor(c.req.query("cursor"))));
  lectura("/softrestaurant/cuadre", (ctx, q) => ctx.servicio.cuadreSr(consultaDe(q)));

  app.get(`${BASE}/softrestaurant/lotes`, async (c) => {
    assertAccion(c, "cfo.ver");
    await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
    const limiteRaw = c.req.query("limite");
    if (limiteRaw !== undefined && (!/^\d{1,3}$/.test(limiteRaw) || Number(limiteRaw) < 1 || Number(limiteRaw) > 200)) throw invalido("limite debe ser un entero entre 1 y 200.");
    const sucursales = parsearSucursales(c.req.query("sucursales"));
    return protegido(async () => jsonConEtag(c, await (await contexto(c, sucursales)).servicio.lotesSr(limiteRaw === undefined ? 50 : Number(limiteRaw))));
  });

  // ---- configuración (cfo_config) ------------------------------------------------------------------------------------------------------------

  app.get(`${BASE}/config`, async (c) => {
    assertAccion(c, "cfo.ver");
    await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
    return protegido(async () => jsonConEtag(c, await (await contexto(c, null)).servicio.configVista()));
  });

  app.put(`${BASE}/config`, async (c) => {
    assertAccion(c, "cfo.capturar");
    await limitar(c, "cfo-escritura", CFO_LIMITES.escrituraPorMin, 60);
    const cambios = parsearConfig(await readJsonCapped<unknown>(c.req.raw, 4 * 1024));
    return protegido(async () => {
      const ctx = await contexto(c, null);
      // La configuración es de la ORGANIZACIÓN: un admin acotado la lee pero no la cambia.
      if (!ctx.alcance.organizacionCompleta) throw Errors.forbidden("Solo el dueño o un administrador de toda la organización puede cambiar la configuración del CFO.");
      await ctx.repo.configGuardar(ctx.organizationId, cambios);
      logEvent(c, "info", "restaurantes_cfo_config_guardada", { actorUserId: c.get("userId"), organizationId: ctx.organizationId, llaves: Object.keys(cambios) });
      // Respuesta con la configuración vigente (servicio nuevo: no reutiliza la lectura memoizada previa).
      return c.json(await (await contexto(c, null)).servicio.configVista());
    });
  });

  // ---- costos capturados ---------------------------------------------------------------------------------------------------------------------

  app.get(`${BASE}/costos`, async (c) => {
    assertAccion(c, "cfo.ver");
    await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
    const { mesDesde, mesHasta } = parsearRangoMeses((k) => c.req.query(k), new Date().toISOString().slice(0, 10));
    const sucursales = parsearSucursales(c.req.query("sucursales"));
    return protegido(async () => jsonConEtag(c, await (await contexto(c, sucursales)).servicio.costosVista(mesDesde, mesHasta)));
  });

  app.get(`${BASE}/costos/historial`, async (c) => {
    assertAccion(c, "cfo.capturar");
    await limitar(c, "cfo-lectura", CFO_LIMITES.lecturaPorMin, 60);
    const h = parsearHistorial((k) => c.req.query(k));
    return protegido(async () => {
      const ctx = await contexto(c, null);
      if (h.propertyId === null && !ctx.alcance.organizacionCompleta) throw Errors.forbidden("Solo el dueño o un administrador de toda la organización ve los costos de la organización.");
      if (h.propertyId !== null && !ctx.permitidas.some((p) => p.propertyId === h.propertyId)) throw Errors.forbidden(MENSAJE_SIN_ACCESO);
      return jsonConEtag(c, await ctx.servicio.costoHistorialVista(h.propertyId, h.mes, h.concepto));
    });
  });

  app.put(`${BASE}/costos`, async (c) => {
    assertAccion(c, "cfo.capturar");
    await limitar(c, "cfo-escritura", CFO_LIMITES.escrituraPorMin, 60);
    const costos = parsearCostos(await readJsonCapped<unknown>(c.req.raw, 64 * 1024));
    return protegido(async () => {
      const ctx = await contexto(c, null);
      // Validación de alcance ANTES de escribir nada: un solo renglón ajeno rechaza el lote completo (y la transacción única lo revierte).
      for (const x of costos) {
        if (x.propertyId === null) {
          if (!ctx.alcance.organizacionCompleta) throw Errors.forbidden("Solo el dueño o un administrador de toda la organización puede capturar costos de la organización.");
        } else if (!ctx.permitidas.some((p) => p.propertyId === x.propertyId)) {
          throw Errors.forbidden(MENSAJE_SIN_ACCESO);
        }
      }
      const ids: string[] = [];
      // Secuencial: una sola sesión; cada guardado crea una versión nueva (la anterior queda en el historial).
      for (const x of costos) ids.push(await ctx.repo.costoGuardar({ organizationId: ctx.organizationId, propertyId: x.propertyId, mes: x.mes, concepto: x.concepto, montoCentavos: x.montoCentavos, pct: x.pct, nota: x.nota }));
      logEvent(c, "info", "restaurantes_cfo_costos_capturados", { actorUserId: c.get("userId"), organizationId: ctx.organizationId, renglones: costos.length });
      const meses = costos.map((x) => x.mes).sort();
      const fresco = await contexto(c, null);
      return c.json({ guardados: ids.length, ids, ...(await fresco.servicio.costosVista(meses[0] as string, meses[meses.length - 1] as string)) });
    });
  });

  // ---- SoftRestaurant: importación -----------------------------------------------------------------------------------------------------------

  /** Normaliza el archivo (sin escribir). Devuelve la respuesta de error o los renglones SQL. */
  async function prepararSr(c: Context<CoreAuthHonoEnv>) {
    const cuerpo = parsearCuerpoSr(await readJsonCapped<unknown>(c.req.raw, CFO_BODY_MAX_BYTES));
    const ctx = await contexto(c, [cuerpo.propertyId]);
    const corte = await ctx.servicio.corteDe(cuerpo.propertyId);
    const n = normalizarExportSr({ tabla: cuerpo.tabla, corte, ...(cuerpo.tipo ? { tipo: cuerpo.tipo } : {}) });
    return { cuerpo, ctx, n };
  }

  function errorNormalizacion(n: Exclude<ReturnType<typeof normalizarExportSr>, { ok: true }>): Response {
    if (n.motivo === "columnas_personales") {
      return Response.json(
        { code: "columnas_personales", message: "El archivo trae columnas de datos personales; por privacidad no se importa. Quite esas columnas y vuelva a subirlo.", columnas: n.columnas, escribio: false },
        { status: 422 },
      );
    }
    if (n.motivo === "demasiados_renglones") {
      return Response.json({ code: "payload_too_large", message: n.mensaje, maximo: n.maximo, recibidos: n.recibidos, escribio: false }, { status: 413 });
    }
    return Response.json({ code: n.motivo, message: n.motivo === "sin_encabezado" ? "No se encontró la fila de encabezados del reporte de SoftRestaurant." : "Faltan columnas obligatorias en el archivo.", faltan: n.faltan, escribio: false }, { status: 422 });
  }

  /** Huella determinista del CONTENIDO normalizado (sucursal + layout + renglones): el mismo archivo con el mismo mapeo repite la huella. */
  const huellaDe = (propertyId: string, tipo: string, renglones: unknown): string => createHash("sha256").update(JSON.stringify({ propertyId, tipo, renglones })).digest("hex");

  app.post(`${BASE}/softrestaurant/importar/vista-previa`, async (c) => {
    assertAccion(c, "cfo.importar_sr");
    await limitar(c, "cfo-escritura", CFO_LIMITES.escrituraPorMin, 60);
    return protegido(async () => {
      const { cuerpo, n } = await prepararSr(c);
      if (!n.ok) return errorNormalizacion(n);
      const renglones = n.tipo === "cuentas" ? renglonesSqlCuentas(n.renglones) : renglonesSqlResumen(n.renglones);
      const vista: VistaPreviaSr = {
        ok: true, tipo: n.tipo, inferido: true, avisoAlias: n.avisoAlias, mapeo: n.mapeo, ignoradas: n.ignoradas, advertencias: n.advertencias, aceptados: n.aceptados, rechazados: n.rechazados,
        omitidos: n.omitidos, errores: n.errores, fechaMin: n.fechaMin, fechaMax: n.fechaMax, muestra: renglones.slice(0, 10), huella: huellaDe(cuerpo.propertyId, n.tipo, renglones), escribio: false,
      };
      return c.json(vista);
    });
  });

  app.post(`${BASE}/softrestaurant/importar`, async (c) => {
    assertAccion(c, "cfo.importar_sr");
    await limitar(c, "cfo-importar", CFO_LIMITES.importarPor10Min, 600);
    return protegido(async () => {
      const { cuerpo, ctx, n } = await prepararSr(c);
      if (!n.ok) return errorNormalizacion(n);
      if (n.aceptados === 0) return Response.json({ code: "sin_renglones_validos", message: "Ningún renglón del archivo es válido; no se importó nada.", errores: n.errores, escribio: false }, { status: 422 });
      const renglones = n.tipo === "cuentas" ? renglonesSqlCuentas(n.renglones) : renglonesSqlResumen(n.renglones);
      if (renglones.length > MAX_RENGLONES_SR[n.tipo]) return Response.json({ code: "payload_too_large", message: `El archivo supera el máximo de ${MAX_RENGLONES_SR[n.tipo]} renglones.`, escribio: false }, { status: 413 });
      const huella = huellaDe(cuerpo.propertyId, n.tipo, renglones);
      const r = await ctx.repo.srImportar({ organizationId: ctx.organizationId, propertyId: cuerpo.propertyId, huella, tipo: n.tipo, nombreArchivo: cuerpo.nombreArchivo, renglones });
      logEvent(c, "info", "restaurantes_cfo_sr_importado", { actorUserId: c.get("userId"), organizationId: ctx.organizationId, propertyId: cuerpo.propertyId, tipo: n.tipo, creado: r.creado, aceptados: r.aceptados, rechazados: r.rechazados });
      // Los renglones que el normalizador ya descartó (fecha ilegible, monto inválido…) no llegan a la base: se suman a los rechazados.
      const vista: ImportacionSrVista = {
        ...r,
        rechazados: r.rechazados + n.rechazados,
        errores: [...n.errores.map((e) => ({ renglon: e.renglon, campo: e.campo, motivo: e.motivo })), ...r.errores].slice(0, 50),
        tipo: n.tipo,
        huella,
        inferido: true,
      };
      return Response.json(vista, { status: r.creado ? 201 : 200 });
    });
  });

  // ---- exportaciones (solo bitácora; el archivo es CFO-06) -------------------------------------------------------------------------------------

  app.post(`${BASE}/exportaciones`, async (c) => {
    assertAccion(c, "cfo.exportar");
    await limitar(c, "cfo-escritura", CFO_LIMITES.escrituraPorMin, 60);
    const e = parsearExportacion(await readJsonCapped<unknown>(c.req.raw, 4 * 1024));
    return protegido(async () => {
      const ctx = await contexto(c, e.sucursales);
      const id = await ctx.repo.registrarExportacion({ organizationId: ctx.organizationId, propertyIds: ctx.propertyIdsSql, vista: e.vista, formato: e.formato, desde: e.desde, hasta: e.hasta });
      logEvent(c, "info", "restaurantes_cfo_exportacion_registrada", { actorUserId: c.get("userId"), organizationId: ctx.organizationId, vista: e.vista, formato: e.formato });
      return c.json({ id, registrada: true, vista: e.vista, formato: e.formato, desde: e.desde, hasta: e.hasta }, 201);
    });
  });

  return app;
}
