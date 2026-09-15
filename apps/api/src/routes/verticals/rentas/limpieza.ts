// Fase 17 -- módulo operativo de limpieza/mantenimiento: cierra el hallazgo de
// auditoría ALTA "el rol `limpieza` (LIMPIEZA_OPERACION_ROLES, ver
// packages/domain-rentas/src/roles.ts) sigue sin ninguna vista funcional" pese a que
// el motor transaccional completo ya existía desde Fase 8
// (packages/domain-rentas/src/limpieza/aplicacion/tareas.ts: asignarTarea/
// completarChecklistItem/completarTarea/registrarIncidencia) SIN que ningún HTTP
// route lo expusiera todavía (ver el comentario "Fuera de fase" que tenía el README
// de domain-rentas hasta esta fase, y `mapRentasDomainError` en reservas.ts, que ya
// traducía los códigos de error de este módulo "para que este switch exhaustivo
// siga compilando" sin que ninguna ruta los disparara).
//
// Mismo patrón arquitectónico exacto que reservas.ts/bloqueos.ts: el motor
// transaccional SIEMPRE vive en @atiende/domain-rentas, la ruta le pasa el
// `TenantDbSession` del request DIRECTO (satisface `EjecutorTransaccional` por
// structural typing) -- nunca se envuelve en `RentasRepository`, que aquí solo cubre
// las LECTURAS (listar tareas/detalle/inventario/incidencias) que este panel
// necesita. Sesión de staff obligatoria (authMiddleware + dbSession +
// requirePropertyMembership), filtrado fino de rol con `LIMPIEZA_OPERACION_ROLES`
// (roles.ts ya documenta por qué: "operar tareas... queda abierto al rol `limpieza`
// -- además de quien ya puede escribir calendario" -- `contador`/
// `operador:solo_calendario` nunca operan tareas de limpieza, ni siquiera para leer).
//
// Deliberadamente NO expone `crearTareaLimpiezaPorCheckout`/
// `procesarCheckoutsPendientes` (creación automática de tareas al checkout) ni
// `confirmarBloqueoMantenimiento` (confirmación de bloqueo de calendario por una
// incidencia grave, acotada a `LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES`) -- ninguno de los
// dos está en el alcance del hallazgo que cierra esta fase (4 capacidades
// concretas: listar tareas asignadas, marcar checklist, reportar incidencia,
// registrar movimiento de inventario), y agregarlos sería un hallazgo aparte
// (documentado honestamente como bloqueador conocido, no fingido como resuelto).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { asignarTarea, completarChecklistItem, completarTarea, LIMPIEZA_OPERACION_ROLES, registrarIncidencia, RentasDomainError } from "@atiende/domain-rentas";
import type { ConsumoInventario, EstadoTareaOperativa, SeveridadIncidencia } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { mapRentasDomainError } from "./reservas.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS_TAREA_VALIDOS: readonly EstadoTareaOperativa[] = ["pendiente", "asignada", "en_progreso", "completada", "bloqueada", "cancelada"];
const SEVERIDADES_VALIDAS: readonly SeveridadIncidencia[] = ["leve", "moderada", "grave"];
const MAX_FOTOS_POR_CHECKLIST_ITEM = 10;
const MAX_CONSUMOS_POR_TAREA = 50;

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-${max} caracteres.`);
  }
  return value.trim();
}

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  }
  return value;
}

/** `GET .../tareas?asignadoA=...` -- `"me"` es la propia sesión (vista "mis tareas de
 * hoy" del rol `limpieza`), `"sin_asignar"` pide `asignado_a IS NULL` (tareas que
 * cualquiera con este rol puede tomar), cualquier otro valor se trata como un
 * `staffUserId` literal (panel de admin_gestora viendo la carga de alguien más). */
function parseAsignadoAQuery(raw: string | undefined, ownUserId: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "me") return ownUserId;
  if (raw === "sin_asignar") return null;
  return raw;
}

function parseEstadoQuery(raw: string | undefined): readonly EstadoTareaOperativa[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const valores = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  for (const v of valores) {
    if (!(ESTADOS_TAREA_VALIDOS as readonly string[]).includes(v)) {
      throw Errors.validation(`estado: valor "${v}" inválido -- se esperaba uno de ${ESTADOS_TAREA_VALIDOS.join(", ")}.`);
    }
  }
  return valores as EstadoTareaOperativa[];
}

interface AsignarTareaBody {
  readonly asignadoA?: unknown;
  readonly esProveedorExterno?: unknown;
}

interface FotoChecklistInput {
  readonly rutaAlmacenamiento?: unknown;
}

interface CompletarChecklistItemBody {
  readonly fotos?: unknown;
}

interface ConsumoInventarioInput {
  readonly itemInventarioId?: unknown;
  readonly cantidad?: unknown;
}

interface CompletarTareaBody {
  readonly consumos?: unknown;
}

interface RegistrarIncidenciaBody {
  readonly severidad?: unknown;
  readonly titulo?: unknown;
  readonly descripcion?: unknown;
  readonly tareaOrigenId?: unknown;
  readonly propuestaBloqueoRango?: unknown;
}

function requireFotos(raw: unknown): readonly { rutaAlmacenamiento: string }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("fotos: se esperaba un arreglo.");
  if (raw.length > MAX_FOTOS_POR_CHECKLIST_ITEM) throw Errors.validation(`fotos: máximo ${MAX_FOTOS_POR_CHECKLIST_ITEM} por ítem de checklist.`);
  return raw.map((f, i) => {
    const item = f as FotoChecklistInput;
    return { rutaAlmacenamiento: requireOptionalString(item.rutaAlmacenamiento, `fotos[${i}].rutaAlmacenamiento`, 500) ?? "" };
  }).filter((f) => f.rutaAlmacenamiento.length > 0);
}

function requireConsumos(raw: unknown): readonly ConsumoInventario[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("consumos: se esperaba un arreglo.");
  if (raw.length > MAX_CONSUMOS_POR_TAREA) throw Errors.validation(`consumos: máximo ${MAX_CONSUMOS_POR_TAREA} por tarea.`);
  return raw.map((c, i) => {
    const item = c as ConsumoInventarioInput;
    const itemInventarioId = requireOptionalString(item.itemInventarioId, `consumos[${i}].itemInventarioId`, 100);
    if (!itemInventarioId) throw Errors.validation(`consumos[${i}].itemInventarioId: es obligatorio.`);
    if (typeof item.cantidad !== "number" || !Number.isFinite(item.cantidad) || item.cantidad <= 0) {
      throw Errors.validation(`consumos[${i}].cantidad: se esperaba un número positivo.`);
    }
    return { itemInventarioId, cantidad: item.cantidad };
  });
}

function requireSeveridad(value: unknown): SeveridadIncidencia {
  if (typeof value !== "string" || !(SEVERIDADES_VALIDAS as readonly string[]).includes(value)) {
    throw Errors.validation(`severidad: se esperaba uno de ${SEVERIDADES_VALIDAS.join(", ")}.`);
  }
  return value as SeveridadIncidencia;
}

function requireOptionalRango(raw: unknown): { inicio: string; fin: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw Errors.validation("propuestaBloqueoRango: se esperaba un objeto {inicio, fin}.");
  const r = raw as { inicio?: unknown; fin?: unknown };
  return { inicio: requireFecha(r.inicio, "propuestaBloqueoRango.inicio"), fin: requireFecha(r.fin, "propuestaBloqueoRango.fin") };
}

export function rentasLimpiezaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const tareasBase = "/rentas/:propertyId/tareas";
  const tareaDetallePath = "/rentas/:propertyId/tareas/:tareaId";
  const asignarPath = "/rentas/:propertyId/tareas/:tareaId/asignar";
  const checklistCompletarPath = "/rentas/:propertyId/tareas/:tareaId/checklist/:itemId/completar";
  const completarTareaPath = "/rentas/:propertyId/tareas/:tareaId/completar";
  const inventarioPath = "/rentas/:propertyId/unidades/:unidadId/inventario";
  const incidenciasPath = "/rentas/:propertyId/unidades/:unidadId/incidencias";

  for (const path of [tareasBase, tareaDetallePath, asignarPath, checklistCompletarPath, completarTareaPath, inventarioPath, incidenciasPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // ---- GET .../tareas: "mis tareas de hoy" (asignadoA=me), sin asignar
  // (asignadoA=sin_asignar), o todas (sin query) -- ver parseAsignadoAQuery. ----
  app.get(tareasBase, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasRepo(c.get("db"));

    const asignadoA = parseAsignadoAQuery(c.req.query("asignadoA"), c.get("userId"));
    const estados = parseEstadoQuery(c.req.query("estado"));
    const filtro = asignadoA !== undefined || estados !== undefined ? { ...(asignadoA !== undefined ? { asignadoA } : {}), ...(estados !== undefined ? { estados } : {}) } : undefined;

    const tareas = await repo.listTareas(propertyId, filtro);
    return c.json({ tareas }, 200);
  });

  app.get(tareaDetallePath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const tareaId = c.req.param("tareaId");
    const repo = deps.rentasRepo(c.get("db"));

    const tarea = await repo.findTareaDetalle(propertyId, tareaId);
    if (!tarea) throw Errors.notFound("Tarea no encontrada en esta property.");
    return c.json({ tarea }, 200);
  });

  // ---- POST .../asignar: sin `asignadoA` en el body, se auto-asigna a quien llama
  // (botón "Asignarme" de la vista "tareas sin asignar" del rol `limpieza`); con
  // `asignadoA`, admin_gestora/operador puede asignarla a otro staff. ----
  app.post(asignarPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const tareaId = c.req.param("tareaId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const existente = await repo.findTareaDetalle(propertyId, tareaId);
    if (!existente) throw Errors.notFound("Tarea no encontrada en esta property.");

    const raw = await readJsonCapped<AsignarTareaBody>(c.req.raw, 2 * 1024);
    const asignadoA = requireOptionalString(raw.asignadoA, "asignadoA", 100) ?? c.get("userId");
    if (raw.esProveedorExterno !== undefined && typeof raw.esProveedorExterno !== "boolean") {
      throw Errors.validation("esProveedorExterno: se esperaba un booleano.");
    }
    const esProveedorExterno = raw.esProveedorExterno === true;

    try {
      await asignarTarea(db, { tareaId, asignadoA, esProveedorExterno });
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
    const actualizada = await repo.findTareaDetalle(propertyId, tareaId);
    return c.json({ tarea: actualizada }, 200);
  });

  // ---- POST .../checklist/:itemId/completar: marca un ítem del checklist (H-051).
  // `fotos` son solo metadatos (`rutaAlmacenamiento`) -- la subida real de archivos
  // sigue fuera de fase (ver README de domain-rentas), mismo criterio "dev-local"
  // que el resto del monorepo. ----
  app.post(checklistCompletarPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const tareaId = c.req.param("tareaId");
    const itemId = c.req.param("itemId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const completadoPor = c.get("userId");

    const item = await repo.findChecklistItem(propertyId, tareaId, itemId);
    if (!item) throw Errors.notFound("Ítem de checklist no encontrado en esta tarea.");

    const raw = await readJsonCapped<CompletarChecklistItemBody>(c.req.raw, 4 * 1024);
    const fotos = requireFotos(raw.fotos).map((f) => ({ rutaAlmacenamiento: f.rutaAlmacenamiento, subidaPor: completadoPor }));

    try {
      await completarChecklistItem(db, { checklistItemId: itemId, completadoPor, fotos });
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
    const tarea = await repo.findTareaDetalle(propertyId, tareaId);
    return c.json({ tarea }, 200);
  });

  // ---- POST .../completar: exige checklist completo (H-051, REQ-113) -- si algún
  // ítem sigue pendiente, `completarTarea` bloquea la tarea (`estado='bloqueada'`) y
  // `mapRentasDomainError` traduce `checklist_incompleto` a 409, nunca a un 500.
  // `consumos` opcional descuenta inventario (H-052) -- este es el ÚNICO camino real
  // para registrar un movimiento de inventario (reabastecimiento manual sigue fuera
  // de fase, ver README de domain-rentas). ----
  app.post(completarTareaPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const tareaId = c.req.param("tareaId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);

    const existente = await repo.findTareaDetalle(propertyId, tareaId);
    if (!existente) throw Errors.notFound("Tarea no encontrada en esta property.");

    const raw = await readJsonCapped<CompletarTareaBody>(c.req.raw, 4 * 1024);
    const consumos = requireConsumos(raw.consumos);

    try {
      const resultado = await completarTarea(db, { tareaId, consumos });
      return c.json({ id: tareaId, estado: "completada", alertasStockBajo: resultado.alertasStockBajo }, 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  // ---- GET .../unidades/:unidadId/inventario: catálogo de ropa blanca/consumibles
  // de la unidad -- insumo para elegir qué `itemInventarioId` consumir arriba. ----
  app.get(inventarioPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const repo = deps.rentasRepo(c.get("db"));

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const items = await repo.listItemsInventario(propertyId, unidadId);
    return c.json({ items }, 200);
  });

  // ---- POST/GET .../unidades/:unidadId/incidencias: reportar/listar incidencias de
  // mantenimiento (H-055). La confirmación humana del bloqueo de calendario que una
  // incidencia GRAVE puede proponer (`confirmarBloqueoMantenimiento`,
  // LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES) NO se expone aquí -- fuera del alcance de este
  // hallazgo, ver comentario de cabecera del archivo. ----
  app.post(incidenciasPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const db = c.get("db");
    const repo = deps.rentasRepo(db);
    const reportadoPor = c.get("userId");

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const raw = await readJsonCapped<RegistrarIncidenciaBody>(c.req.raw, 4 * 1024);
    const severidad = requireSeveridad(raw.severidad);
    const titulo = requireOptionalString(raw.titulo, "titulo", 200);
    if (!titulo) throw Errors.validation("titulo: es obligatorio.");
    const descripcion = requireOptionalString(raw.descripcion, "descripcion", 4000);
    const tareaOrigenIdRaw = requireOptionalString(raw.tareaOrigenId, "tareaOrigenId", 100);
    const propuestaBloqueoRango = requireOptionalRango(raw.propuestaBloqueoRango);

    // Defensa en profundidad, mismo criterio que el resto del archivo: si viene
    // `tareaOrigenId`, debe ser una tarea real de ESTA property -- nunca se confía
    // en que el cliente "sabe" que le pertenece.
    let tareaOrigenId: string | null = null;
    if (tareaOrigenIdRaw) {
      const tareaOrigen = await repo.findTareaDetalle(propertyId, tareaOrigenIdRaw);
      if (!tareaOrigen) throw Errors.notFound("tareaOrigenId: no corresponde a una tarea de esta property.");
      tareaOrigenId = tareaOrigenIdRaw;
    }

    try {
      const resultado = await registrarIncidencia(db, {
        unidadId,
        tareaOrigenId,
        severidad,
        titulo,
        descripcion,
        reportadoPor,
        propuestaBloqueoRango,
      });
      return c.json({ id: resultado.incidenciaId, requiereConfirmacionHumana: resultado.requiereConfirmacionHumana }, 201);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  app.get(incidenciasPath, async (c) => {
    assertVerticalRole(c, LIMPIEZA_OPERACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const repo = deps.rentasRepo(c.get("db"));

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const incidencias = await repo.listIncidencias(propertyId, unidadId);
    return c.json({ incidencias }, 200);
  });

  return app;
}
