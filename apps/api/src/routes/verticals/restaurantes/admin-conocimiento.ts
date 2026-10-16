// Conocimiento del negocio (politicas, preguntas frecuentes y avisos temporales) e interruptor DURO del agente de WhatsApp por sucursal
// (migracion 053). Solo owner/admin (`STAFF_INVITE_ROLES`, el mismo umbral que las policies de la migracion: RLS es la autoridad, esta capa da
// defensa en profundidad y mejores mensajes). Corren en la sesion de STAFF autenticado y respetan el alcance por membership: un admin acotado a
// una sucursal nunca crea, edita ni borra conocimiento general ni de otra sucursal, ni apaga el agente de otra.
//
// Texto del conocimiento: lo valida `validarEntradaConocimiento` (nunca precios ni nombres exactos del catalogo: el precio sale de cotizar_pedido)
// y se guarda saneado. Todo cambio deja bitacora (`registrarAuditoria`). Base sin migrar: la lectura devuelve `disponible: false` (estado honesto,
// nunca una lista vacia disfrazada) y las escrituras responden 503 (`RestaurantesConfigUnavailableError`), nunca 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  CONOCIMIENTO_ESTADOS,
  CONOCIMIENTO_TOPE_PROMPT,
  RestaurantesConfigUnavailableError,
  STAFF_INVITE_ROLES,
  esTipoConocimiento,
  validarEntradaConocimiento,
} from "@atiende/domain-restaurantes";
import type { ConocimientoEntrada, ConocimientoEstado, ConocimientoPatch } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializar(e: ConocimientoEntrada) {
  return {
    id: e.id,
    sucursalId: e.propertyId,
    reemplazaId: e.reemplazaId,
    titulo: e.titulo,
    texto: e.texto,
    tipo: e.tipo,
    prioridad: e.prioridad,
    vigenteDesde: e.vigenteDesde,
    vigenteHasta: e.vigenteHasta,
    activo: e.activo,
    estado: e.estado,
    origen: e.origen,
    version: e.version,
    actualizadoEn: e.updatedAt,
  };
}

function asUnavailable(err: unknown): never {
  if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
  throw err;
}

function fechaOpcional(valor: unknown, campo: string): string | null {
  if (valor === null) return null;
  if (typeof valor !== "string" || !FECHA_RE.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`)) || new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) !== valor) {
    throw Errors.validation(`${campo}: se esperaba una fecha YYYY-MM-DD o null.`);
  }
  return valor;
}

function uuidOpcional(valor: unknown, campo: string): string | null {
  if (valor === null) return null;
  if (typeof valor !== "string" || !UUID_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba un UUID o null.`);
  return valor;
}

interface CuerpoConocimiento {
  readonly titulo?: unknown;
  readonly texto?: unknown;
  readonly tipo?: unknown;
  readonly sucursalId?: unknown;
  readonly reemplazaId?: unknown;
  readonly prioridad?: unknown;
  readonly vigenteDesde?: unknown;
  readonly vigenteHasta?: unknown;
  readonly activo?: unknown;
  readonly estado?: unknown;
}

/** Campos presentes del cuerpo, ya con su tipo; lo ausente queda `undefined` (PATCH parcial). */
function parsearCampos(raw: CuerpoConocimiento) {
  if (raw.titulo !== undefined && typeof raw.titulo !== "string") throw Errors.validation("titulo: se esperaba texto.");
  if (raw.texto !== undefined && typeof raw.texto !== "string") throw Errors.validation("texto: se esperaba texto.");
  if (raw.tipo !== undefined && !esTipoConocimiento(raw.tipo)) throw Errors.validation("tipo: debe ser politica, faq o aviso_temporal.");
  if (raw.prioridad !== undefined && (typeof raw.prioridad !== "number" || !Number.isInteger(raw.prioridad) || raw.prioridad < 0 || raw.prioridad > 100)) throw Errors.validation("prioridad: se esperaba un entero de 0 a 100.");
  if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba true o false.");
  if (raw.estado !== undefined && !(typeof raw.estado === "string" && (CONOCIMIENTO_ESTADOS as readonly string[]).includes(raw.estado))) throw Errors.validation("estado: debe ser borrador o publicado.");
  return {
    titulo: raw.titulo as string | undefined,
    texto: raw.texto as string | undefined,
    tipo: raw.tipo as ConocimientoEntrada["tipo"] | undefined,
    sucursalId: raw.sucursalId === undefined ? undefined : uuidOpcional(raw.sucursalId, "sucursalId"),
    reemplazaId: raw.reemplazaId === undefined ? undefined : uuidOpcional(raw.reemplazaId, "reemplazaId"),
    prioridad: raw.prioridad as number | undefined,
    vigenteDesde: raw.vigenteDesde === undefined ? undefined : fechaOpcional(raw.vigenteDesde, "vigenteDesde"),
    vigenteHasta: raw.vigenteHasta === undefined ? undefined : fechaOpcional(raw.vigenteHasta, "vigenteHasta"),
    activo: raw.activo as boolean | undefined,
    estado: raw.estado as ConocimientoEstado | undefined,
  };
}

function vigenciaCoherente(desde: string | null, hasta: string | null): void {
  if (desde !== null && hasta !== null && hasta < desde) throw Errors.validation("vigenteHasta no puede ser anterior a vigenteDesde.");
}

export function restaurantesAdminConocimientoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const baseBranch = "/v1/restaurantes/:propertyId/admin";
  const conocimientoPath = `${baseBranch}/conocimiento`;
  const conocimientoIdPath = `${conocimientoPath}/:entradaId`;
  const interruptorPath = `${baseBranch}/config/sucursales/:branchId/agente-whatsapp`;

  for (const path of [conocimientoPath, conocimientoIdPath, interruptorPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  /** Solo un admin con alcance a TODA la organizacion toca lo general; uno acotado, solo sus sucursales. */
  function assertAlcance(scope: readonly string[] | null, propertyId: string | null): void {
    if (propertyId === null) {
      if (scope !== null) throw Errors.forbidden("El conocimiento general de la organización solo lo edita un administrador con acceso a todas las sucursales.");
      return;
    }
    if (scope !== null && !scope.includes(propertyId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
  }

  async function nombresDelCatalogo(c: Context<CoreAuthHonoEnv>, organizationId: string): Promise<readonly string[]> {
    return (await deps.restaurantesRepo(c.get("db")).listProducts(organizationId)).map((p) => p.name);
  }

  // ---- lista (borradores incluidos) ----
  app.get(conocimientoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const lectura = await deps.restaurantesRepo(c.get("db")).listarConocimiento(organizationId);
    const visibles = lectura.entradas.filter((e) => scope === null || e.propertyId === null || scope.includes(e.propertyId));
    return c.json({ disponible: lectura.disponible, topeCaracteres: CONOCIMIENTO_TOPE_PROMPT, entradas: visibles.map(serializar) });
  });

  // ---- alta ----
  app.post(conocimientoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const f = parsearCampos(await readJsonCapped<CuerpoConocimiento>(c.req.raw, 16 * 1024));
    if (f.titulo === undefined || f.texto === undefined || f.tipo === undefined) throw Errors.validation("titulo, texto y tipo son obligatorios.");
    const sucursalId = f.sucursalId ?? null;
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    assertAlcance(scope, sucursalId);
    if (sucursalId !== null && !(await repo.findBranchById(organizationId, sucursalId))) throw Errors.notFound("Sucursal no encontrada.");
    if (f.reemplazaId && sucursalId === null) throw Errors.validation("reemplazaId solo aplica a una entrada de sucursal.");
    vigenciaCoherente(f.vigenteDesde ?? null, f.vigenteHasta ?? null);
    const valida = validarEntradaConocimiento({ titulo: f.titulo, texto: f.texto }, await nombresDelCatalogo(c, organizationId));
    if (!valida.ok) throw Errors.validation(valida.mensaje);
    let creada: ConocimientoEntrada;
    try {
      creada = await repo.crearConocimiento(organizationId, c.get("userId"), {
        propertyId: sucursalId,
        reemplazaId: f.reemplazaId ?? null,
        titulo: valida.titulo,
        texto: valida.texto,
        tipo: f.tipo,
        ...(f.prioridad !== undefined ? { prioridad: f.prioridad } : {}),
        vigenteDesde: f.vigenteDesde ?? null,
        vigenteHasta: f.vigenteHasta ?? null,
        ...(f.activo !== undefined ? { activo: f.activo } : {}),
        // Una entrada creada a mano nace publicada; los borradores solo salen de importar un documento (y aqui no se aceptan: nada entra al agente sin una persona que lo apruebe).
        estado: "publicado",
        origen: "manual",
      });
    } catch (err) {
      return asUnavailable(err);
    }
    logEvent(c, "info", "restaurantes_admin_conocimiento_creado", { actorUserId: c.get("userId"), organizationId, entradaId: creada.id, tipo: creada.tipo });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.conocimiento_creado",
      entityType: "configuracion",
      entityId: creada.id,
      campo: "conocimiento",
      antes: null,
      despues: JSON.stringify({ titulo: creada.titulo, tipo: creada.tipo, sucursalId: creada.propertyId, caracteres: creada.texto.length }),
    });
    return c.json(serializar(creada), 201);
  });

  /** La entrada debe existir en ESTA organizacion y estar dentro del alcance del admin. */
  async function resolverEntrada(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const entradaId = c.req.param("entradaId") ?? "";
    if (!UUID_RE.test(entradaId)) throw Errors.validation("entradaId: se esperaba un UUID.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const actual = (await repo.listarConocimiento(organizationId)).entradas.find((e) => e.id === entradaId);
    if (!actual) throw Errors.notFound("Entrada de conocimiento no encontrada.");
    assertAlcance(await resolveEffectivePropertyIds(deps, c, organizationId, null), actual.propertyId);
    return { organizationId, repo, actual };
  }

  // ---- edicion parcial (incluye apagar/encender y aprobar un borrador: estado = publicado) ----
  app.patch(conocimientoIdPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, repo, actual } = await resolverEntrada(c);
    const f = parsearCampos(await readJsonCapped<CuerpoConocimiento>(c.req.raw, 16 * 1024));
    if (f.sucursalId !== undefined) throw Errors.validation("sucursalId no se puede cambiar: cree una entrada nueva para otra sucursal.");
    const patch: { -readonly [K in keyof ConocimientoPatch]: ConocimientoPatch[K] } = {};
    if (f.titulo !== undefined || f.texto !== undefined) {
      const valida = validarEntradaConocimiento({ titulo: f.titulo ?? actual.titulo, texto: f.texto ?? actual.texto }, await nombresDelCatalogo(c, organizationId));
      if (!valida.ok) throw Errors.validation(valida.mensaje);
      patch.titulo = valida.titulo;
      patch.texto = valida.texto;
    }
    if (f.tipo !== undefined) patch.tipo = f.tipo;
    if (f.prioridad !== undefined) patch.prioridad = f.prioridad;
    if (f.activo !== undefined) patch.activo = f.activo;
    if (f.estado !== undefined) patch.estado = f.estado;
    if (f.reemplazaId !== undefined) {
      if (f.reemplazaId !== null && actual.propertyId === null) throw Errors.validation("reemplazaId solo aplica a una entrada de sucursal.");
      patch.reemplazaId = f.reemplazaId;
    }
    if (f.vigenteDesde !== undefined) patch.vigenteDesde = f.vigenteDesde;
    if (f.vigenteHasta !== undefined) patch.vigenteHasta = f.vigenteHasta;
    if (Object.keys(patch).length === 0) throw Errors.validation("No hay ningún campo para actualizar.");
    vigenciaCoherente(patch.vigenteDesde === undefined ? actual.vigenteDesde : patch.vigenteDesde, patch.vigenteHasta === undefined ? actual.vigenteHasta : patch.vigenteHasta);
    // Un borrador importado se revisa ANTES de entrar al agente: publicarlo exige que su texto pase la misma validacion (precios / productos).
    if (patch.estado === "publicado" && actual.estado === "borrador" && patch.texto === undefined) {
      const valida = validarEntradaConocimiento({ titulo: actual.titulo, texto: actual.texto }, await nombresDelCatalogo(c, organizationId));
      if (!valida.ok) throw Errors.validation(`No se puede publicar: ${valida.mensaje}`);
    }
    let guardada: ConocimientoEntrada | null;
    try {
      guardada = await repo.actualizarConocimiento(organizationId, c.get("userId"), actual.id, patch);
    } catch (err) {
      return asUnavailable(err);
    }
    if (!guardada) throw Errors.notFound("Entrada de conocimiento no encontrada.");
    logEvent(c, "info", "restaurantes_admin_conocimiento_actualizado", { actorUserId: c.get("userId"), organizationId, entradaId: actual.id, version: guardada.version });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: patch.estado === "publicado" && actual.estado === "borrador" ? "configuracion.conocimiento_aprobado" : "configuracion.conocimiento_actualizado",
      entityType: "configuracion",
      entityId: actual.id,
      campo: "conocimiento",
      antes: JSON.stringify({ titulo: actual.titulo, tipo: actual.tipo, estado: actual.estado, activo: actual.activo, version: actual.version }),
      despues: JSON.stringify({ titulo: guardada.titulo, tipo: guardada.tipo, estado: guardada.estado, activo: guardada.activo, version: guardada.version }),
    });
    return c.json(serializar(guardada));
  });

  // ---- baja ----
  app.delete(conocimientoIdPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, repo, actual } = await resolverEntrada(c);
    let borrada: boolean;
    try {
      borrada = await repo.borrarConocimiento(organizationId, actual.id);
    } catch (err) {
      return asUnavailable(err);
    }
    if (!borrada) throw Errors.notFound("Entrada de conocimiento no encontrada.");
    logEvent(c, "info", "restaurantes_admin_conocimiento_eliminado", { actorUserId: c.get("userId"), organizationId, entradaId: actual.id });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.conocimiento_eliminado",
      entityType: "configuracion",
      entityId: actual.id,
      campo: "conocimiento",
      antes: JSON.stringify({ titulo: actual.titulo, tipo: actual.tipo, estado: actual.estado }),
      despues: null,
    });
    return c.json({ ok: true });
  });

  // ---- interruptor del agente de WhatsApp de UNA sucursal ----
  async function resolverSucursal(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId") ?? "";
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(branchId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const branch = await repo.findBranchById(organizationId, branchId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return { organizationId, branch, repo };
  }

  app.get(interruptorPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolverSucursal(c);
    const estado = await repo.listarAgentesWhatsappApagados(organizationId);
    return c.json({ disponible: estado.disponible, agenteActivo: !estado.propertyIdsApagados.includes(branch.propertyId) });
  });

  app.put(interruptorPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolverSucursal(c);
    const raw = await readJsonCapped<{ activo?: unknown }>(c.req.raw, 1024);
    if (typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba true o false.");
    const anterior = await repo.findAgenteWhatsappActivo(branch.propertyId);
    try {
      await repo.fijarAgenteWhatsappActivo(organizationId, branch.propertyId, c.get("userId"), raw.activo);
    } catch (err) {
      return asUnavailable(err);
    }
    logEvent(c, "info", "restaurantes_admin_agente_whatsapp_sucursal", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId, activo: raw.activo });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.agente_whatsapp_sucursal",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "agenteWhatsappActivo",
      antes: String(anterior),
      despues: String(raw.activo),
    });
    // Aviso in-app (`restaurantes.agente.whatsapp_apagado`): apagar el agente manda los mensajes de esa sucursal a la bandeja del equipo. Uno por
    // sucursal por dia, sin PII (texto fijo del catalogo). Best-effort: SAVEPOINT dentro de emitirNotificacion.
    if (anterior && !raw.activo) {
      await emitirNotificacion(c.get("db"), {
        evento: "restaurantes.agente.whatsapp_apagado",
        organizationId,
        propertyId: branch.propertyId,
        clave: `${branch.propertyId}:${new Date().toISOString().slice(0, 10)}`,
        entidadTipo: "branch",
        entidadId: branch.propertyId,
      });
    }
    return c.json({ disponible: true, agenteActivo: raw.activo });
  });

  return app;
}
