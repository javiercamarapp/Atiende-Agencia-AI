// Alta autoservicio -- importador de menu: el dueño sube su menu (PDF, foto o CSV), recibe un BORRADOR de categorias/productos/precios/
// paquetes, lo revisa en pantalla y solo entonces se guarda en el catalogo (productos de la organizacion + precio y disponibilidad en
// ESTA sucursal, que es lo que leen el agente y `quoteOrder`).
//
//   POST /v1/restaurantes/:propertyId/admin/menu/importar/extraer  -> { borrador, fuente } (NO escribe nada)
//        body { csv } (texto, <= 512 KB) o { archivo: { nombre, mimeType, base64 } } (PDF/PNG/JPEG/WebP, <= 3 MB decodificado).
//        PDF/foto: el modelo de la actividad `extraccion_menu` (apps/api/src/production/llm-models.ts: baratos, ZDR, con entrada de
//        imagen/PDF) devuelve JSON con esquema estricto; `borradorDesdeExtraccion` lo valida y marca dudas (nunca inventa precios).
//        CSV: `borradorDesdeCsv` sin modelo. El archivo viaja solo en la peticion: nunca se guarda ni se registra.
//   POST /v1/restaurantes/:propertyId/admin/menu/importar/guardar  -> { creados, omitidos, categoriasCreadas }
//        body { productos: [{ nombre, categoria, descripcion?, precio }] } (lo aprobado en la revision, <= 300). Todo en la transaccion
//        de la peticion (dbSession): o se guarda todo o nada. Un producto con el mismo nombre en la misma categoria ya existente se omite
//        (no duplica). Bitacora `menu.importado`.
//
// Permisos: igual que crear productos (admin-catalog.ts): `catalogo.precio` (owner/admin) + administrador de toda la organizacion.
// Costo: tope de 20 extracciones por hora por organizacion (core-ratelimit) ademas de los topes del gateway (presupuesto mensual, turnos
// diarios por rol, interruptor de plataforma `restaurantes:extraccion_menu`).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { GatewayBudgetExceededError, KillSwitchEngagedError, MonthlyBudgetExceededError, RoleDailyTurnLimitExceededError } from "@atiende/agent-core";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import {
  borradorDesdeCsv,
  borradorDesdeExtraccion,
  claveProductoImportacion,
  ESQUEMA_EXTRACCION_MENU,
  ImportacionMenuInvalida,
  PROMPT_EXTRACCION_MENU,
  slugCategoria,
  validarImportacionAprobada,
} from "@atiende/domain-restaurantes";
import type { BorradorMenu } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { RESTAURANTES_EXTRACCION_MENU_ROLE } from "../../../production/llm-models.ts";
import { assertAccion } from "./permisos-accion.ts";
import { assertAdminGeneral } from "./admin-scope.ts";
import { conAvisoOnboardingListo } from "./onboarding-aviso.ts";

export const IMPORTADOR_MENU_LIMITES = {
  archivoMaxBytes: 3 * 1024 * 1024,
  /** Cuerpo JSON: base64 del archivo (+33 %) y holgura; debajo del limite de 4.5 MB de Vercel. */
  cuerpoExtraerMaxBytes: 4_400_000,
  csvMaxChars: 512 * 1024,
  cuerpoGuardarMaxBytes: 512 * 1024,
  extraccionesPorHora: 20,
  timeoutMs: 25_000,
  maxOutputTokens: 12_000,
} as const;

type TipoArchivo = "pdf" | "png" | "jpeg" | "webp";
const MIME: Record<TipoArchivo, string> = { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Tipo real por bytes magicos (nunca por el nombre o el mimeType que manda el navegador). */
export function tipoPorBytes(b: Uint8Array): TipoArchivo | null {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "pdf";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  return null;
}

interface ExtraerBody {
  readonly csv?: unknown;
  readonly archivo?: { readonly nombre?: unknown; readonly base64?: unknown };
}

function decodificarBase64(v: unknown): Uint8Array {
  if (typeof v !== "string" || v.length === 0 || !/^[A-Za-z0-9+/=\s]+$/.test(v)) throw Errors.validation("archivo.base64: contenido inválido.");
  const buf = Buffer.from(v, "base64");
  if (buf.byteLength === 0) throw Errors.validation("archivo.base64: contenido vacío.");
  if (buf.byteLength > IMPORTADOR_MENU_LIMITES.archivoMaxBytes) throw Errors.payloadTooLarge("El archivo pesa más de 3 MB: sube una foto más ligera o un PDF con menos páginas.");
  return new Uint8Array(buf);
}

export function restaurantesAdminMenuImportarRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/menu/importar";
  app.use(`${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(`${base}/extraer`, async (c) => {
    assertAccion(c, "catalogo.precio");
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const body = await readJsonCapped<ExtraerBody>(c.req.raw, IMPORTADOR_MENU_LIMITES.cuerpoExtraerMaxBytes);

    if (typeof body.csv === "string") {
      if (body.csv.length > IMPORTADOR_MENU_LIMITES.csvMaxChars) throw Errors.payloadTooLarge("El CSV es demasiado grande (máximo 512 KB).");
      const borrador = borradorDesdeCsv(body.csv);
      if (borrador.productos.length === 0) throw Errors.validation("No encontramos productos: el CSV necesita encabezado con al menos las columnas «nombre» y «precio».");
      return c.json({ fuente: "csv", borrador });
    }

    if (!body.archivo || typeof body.archivo !== "object") throw Errors.validation("Manda un archivo (PDF o foto) o un CSV.");
    const bytes = decodificarBase64(body.archivo.base64);
    const tipo = tipoPorBytes(bytes);
    if (!tipo) throw Errors.validation("Formato no soportado: sube un PDF, una foto (JPG, PNG o WebP) o un CSV.");

    const gateway = deps.llmGateway;
    if (!gateway) throw Errors.serviceUnavailable("La lectura de PDF y fotos no está disponible aún: requiere el proveedor de modelos. Puedes importar un CSV.");
    if (!(await rateLimit(`restaurantes:menu-importar:${organizationId}`, IMPORTADOR_MENU_LIMITES.extraccionesPorHora, 60 * 60_000, { category: "auth:token-issue" }))) {
      throw Errors.tooManyRequests("Llegaste al tope de lecturas de menú por hora. Intenta más tarde o importa un CSV.");
    }

    const nombre = typeof body.archivo.nombre === "string" && body.archivo.nombre.trim() ? body.archivo.nombre.trim().slice(0, 120) : `menu.${tipo === "jpeg" ? "jpg" : tipo}`;
    let borrador: BorradorMenu;
    try {
      const r = await gateway.complete({
        tenantId: organizationId,
        runId: randomUUID(),
        lane: "interactive",
        role: RESTAURANTES_EXTRACCION_MENU_ROLE,
        request: {
          system: PROMPT_EXTRACCION_MENU,
          messages: [{ role: "user", content: "Extrae todos los productos de este menú.", archivos: [{ kind: tipo === "pdf" ? "pdf" : "imagen", mimeType: MIME[tipo], data: Buffer.from(bytes).toString("base64"), filename: nombre }] }],
          maxOutputTokens: IMPORTADOR_MENU_LIMITES.maxOutputTokens,
          responseFormat: { name: "menu_restaurante", schema: ESQUEMA_EXTRACCION_MENU },
          signal: AbortSignal.timeout(IMPORTADOR_MENU_LIMITES.timeoutMs),
        },
      });
      borrador = borradorDesdeExtraccion(r.text);
      logEvent(c, "info", "restaurantes_menu_importar_extraido", { organizationId, tipo, modelo: r.model, productos: borrador.productos.length, ilegibles: borrador.ilegibles });
    } catch (err) {
      if (err instanceof KillSwitchEngagedError) throw Errors.serviceUnavailable("La lectura de menús está pausada por la plataforma. Puedes importar un CSV.");
      if (err instanceof RoleDailyTurnLimitExceededError || err instanceof MonthlyBudgetExceededError || err instanceof GatewayBudgetExceededError) {
        throw Errors.tooManyRequests("Se alcanzó el tope de uso de IA. Intenta más tarde o importa un CSV.");
      }
      logEvent(c, "error", "restaurantes_menu_importar_fallo_modelo", { organizationId, tipo, message: err instanceof Error ? err.message : String(err) });
      throw Errors.serviceUnavailable("No pudimos leer el menú en este momento. Intenta de nuevo o importa un CSV.");
    }
    if (borrador.productos.length === 0) throw Errors.validation("No encontramos productos en el archivo. Prueba con una foto más nítida o un CSV.");
    return c.json({ fuente: "vision", borrador });
  });

  app.post(`${base}/guardar`, async (c) => {
    assertAccion(c, "catalogo.precio");
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const raw = await readJsonCapped<unknown>(c.req.raw, IMPORTADOR_MENU_LIMITES.cuerpoGuardarMaxBytes);
    let aprobados;
    try {
      aprobados = validarImportacionAprobada(raw);
    } catch (err) {
      if (err instanceof ImportacionMenuInvalida) throw Errors.validation(err.message);
      throw err;
    }

    const categorias = await repo.listCategories(organizationId);
    const categoriaPorSlug = new Map(categorias.map((cat) => [cat.slug, cat]));
    const nombreCategoriaPorId = new Map(categorias.map((cat) => [cat.id, cat.name]));
    const existentes = new Set((await repo.listProducts(organizationId)).map((p) => claveProductoImportacion(p.name, (p.categoryId && nombreCategoriaPorId.get(p.categoryId)) || "")));
    let orden = categorias.length;
    let categoriasCreadas = 0;
    let creados = 0;
    let omitidos = 0;

    await conAvisoOnboardingListo(deps, c, organizationId, async () => {
      for (const p of aprobados) {
        const slug = slugCategoria(p.categoria);
        let categoria = categoriaPorSlug.get(slug);
        if (!categoria) {
          categoria = await repo.createCategory(organizationId, { name: p.categoria, slug, displayOrder: orden++ });
          categoriaPorSlug.set(slug, categoria);
          nombreCategoriaPorId.set(categoria.id, categoria.name);
          categoriasCreadas += 1;
        }
        const clave = claveProductoImportacion(p.nombre, categoria.name);
        if (existentes.has(clave)) {
          omitidos += 1;
          continue;
        }
        existentes.add(clave);
        const producto = await repo.createProduct(organizationId, { name: p.nombre, price: p.precio, description: p.descripcion, categoryId: categoria.id, isAvailable: true });
        await repo.upsertBranchProductState(propertyId, producto.id, p.precio, true);
        creados += 1;
      }
    });

    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "menu.importado",
      entityType: "producto",
      entityId: propertyId,
      campo: "productos",
      antes: null,
      despues: `${creados} productos nuevos (${omitidos} omitidos por repetidos), ${categoriasCreadas} categorías nuevas, sucursal ${propertyId}`,
    });
    logEvent(c, "info", "restaurantes_menu_importado", { actorUserId: c.get("userId"), organizationId, propertyId, creados, omitidos, categoriasCreadas });
    return c.json({ creados, omitidos, categoriasCreadas }, 201);
  });

  return app;
}
