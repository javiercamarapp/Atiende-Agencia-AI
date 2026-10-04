// Cerebro de ventas del superadmin (SA-L-37, SA-L-38, SA-L-41). El cerebro PROPONE y el humano envia: ninguna ruta de aqui contacta a nadie.
//
//   GET  /superadmin/cerebro/prospectos             lista con scores y la taxonomia vigente (base sin migrar: 200 con disponible:false y la lista anterior)
//   POST /superadmin/cerebro/prospectos             alta (base de licitud obligatoria con datos de contacto); calcula y guarda el score
//   PUT  /superadmin/cerebro/prospectos/:id         edicion; recalcula y guarda el score con su version
//   GET  /superadmin/cerebro/prospectos/:id/detalle personas de contacto y linea de tiempo
//   POST /superadmin/cerebro/prospectos/:id/personas persona de contacto (evidencia http(s) y origen verificable obligatorios)
//   GET  /superadmin/cerebro/taxonomia              versiones de la taxonomia por vertical (precio leido de core.plan)
//   PUT  /superadmin/cerebro/taxonomia/:vertical    editar = version nueva; exige step-up MFA (SENSITIVE_ROUTES)
//   POST /superadmin/cerebro/exportaciones          rastro (bitacora de acceso, accion `exportacion`) ANTES de que el navegador arme el CSV
//
// El mapa y la ficha (SA-L-42/43) leen la lista, que ademas trae por prospecto `suprimido` ({telefono, correo}: el destino esta en la lista
// de supresion de plataforma, SA-L-46); ausente = no se pudo verificar y la pantalla NO ofrece contactarlo.
//
// Autenticacion, gateo de superadmin y step-up montados una vez en routes/superadmin.ts sobre `/superadmin/*`; la autoridad
// real sigue en SQL (core.platform_superadmin + caller-binding). Ver docs/SUPERADMIN_CEREBRO.md y la migracion 0051.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { ProspectoRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import {
  CEREBRO_NO_DISPONIBLE,
  VERTICALES,
  agregarPersona,
  codigoPg,
  detalleProspecto,
  guardarProspecto,
  guardarTaxonomia,
  listarProspectos,
  listarTaxonomia,
  sanearExportacion,
  suprimidosPorProspecto,
  validarCoherenciaIcp,
  validarContenidoTaxonomia,
  validarDatosProspecto,
  validarPersona,
  vigentesPorVertical,
} from "../cerebro/index.ts";
import type { ProspectoCerebro, TaxonomiaVersion } from "../cerebro/index.ts";
import type { AppDeps } from "../deps.ts";

const MUTACION_RATE_LIMIT = { max: 60, windowMs: 5 * 60_000 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Prospecto de la base SIN migrar (solo las columnas de 0012/0016): los campos del Cerebro quedan vacios. */
function desdeLegado(p: ProspectoRow): ProspectoCerebro {
  return {
    id: p.id,
    empresa: p.empresa,
    vertical: p.vertical,
    ciudad: p.ciudad,
    contactoNombre: p.contactoNombre,
    telefono: p.telefono,
    correo: p.correo,
    estado: p.estado,
    fuente: p.fuente,
    notas: p.notas,
    creadoPor: p.creadoPor,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    necesitaSeguimientoDesde: p.necesitaSeguimientoDesde,
    subtipo: null,
    tamano: null,
    entidad: null,
    municipio: null,
    zona: null,
    lat: null,
    lng: null,
    sitioWeb: null,
    sitioVerificado: false,
    redes: {},
    senales: [],
    baseLicitud: null,
    consentimientoEn: null,
    scoreAjuste: null,
    scoreUrgencia: null,
    scoreCierre: null,
    scoreCompletitud: null,
    scoreExplicacion: null,
    scoreVersion: null,
    duplicadoDe: null,
    vendedorId: null,
    organizationId: null,
    orgDemoId: null,
    ultimoToqueEn: null,
    siguientePaso: null,
    siguientePasoEn: null,
    contactoLegado: false,
  };
}

function serializarTaxonomia(t: TaxonomiaVersion) {
  return {
    id: t.id,
    vertical: t.vertical,
    version: t.version,
    vigente: t.vigente,
    subtipos: t.subtipos,
    rangosTamano: t.rangosTamano,
    senales: t.senales.map((s) => ({ tipo: s.tipo, nombre: s.nombre, dimension: s.dimension, puntos: s.puntos, comoConseguirla: s.como_conseguirla })),
    icp: { descripcion: t.icp.descripcion, subtiposObjetivo: t.icp.subtipos_objetivo, tamanosObjetivo: t.icp.tamanos_objetivo },
    objeciones: t.objeciones,
    mensajesBase: t.mensajesBase,
    contexto: t.contexto,
    planId: t.planId,
    planNombre: t.planNombre,
    precio: t.precio,
    estadoValidacion: t.estadoValidacion,
    notaCambio: t.notaCambio,
    vigenteDesde: t.vigenteDesde,
    creadoEn: t.creadoEn,
  };
}

/** Traduce los CHECK de la base (23514) a un 422 claro; cualquier otro error se repropaga. */
function traducirErrorPg(err: unknown): never {
  if (codigoPg(err) === "23514") {
    const msg = err instanceof Error ? err.message : "";
    const claro = msg.startsWith("base_licitud_requerida") ? "La base de licitud es obligatoria para guardar datos de contacto."
      : msg.startsWith("mensajes_promesa_cifras") ? "Un mensaje base no puede prometer cifras (porcentajes ni montos)."
      : /evidencia_url/u.test(msg) ? "La evidencia es obligatoria: indica la URL (http o https) donde viste este dato."
      : /origen/u.test(msg) ? "El origen no es válido: solo se aceptan datos con un origen verificable."
      : /consentimiento/u.test(msg) ? "Esta base de licitud exige la fecha de consentimiento."
      : "Los datos no cumplen una regla de la base (revisa la base de licitud, el consentimiento y la evidencia).";
    throw new ApiError(422, "regla_de_datos", claro);
  }
  throw err;
}

export function superadminCerebroRoutes(deps: AppDeps, opciones: { readonly ahora?: () => Date } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = opciones.ahora ?? (() => new Date());

  async function limitarMutaciones(c: { req: { raw: Request } }, callerId: string): Promise<void> {
    const ok = await rateLimit(`admin:cerebro:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!ok) throw Errors.tooManyRequests("Demasiados cambios en el Cerebro de ventas en poco tiempo.");
  }

  function idValido(id: string): string {
    if (!UUID_RE.test(id)) throw Errors.notFound("El prospecto no existe.");
    return id;
  }

  app.get("/superadmin/cerebro/prospectos", async (c) => {
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const lista = await listarProspectos(db, callerId);
      if (!lista.disponible) return { lista, taxonomias: [] as TaxonomiaVersion[] };
      const tax = await listarTaxonomia(db, callerId);
      return { lista, taxonomias: tax.disponible ? [...vigentesPorVertical(tax.versiones).values()] : [] };
    });
    if (!r.lista.disponible) {
      // Base sin migrar: el flujo de hoy (lista, alta y cambio de etapa) sigue funcionando por las funciones anteriores.
      const legado = await deps.coreRepo.listProspectosForSuperadmin(callerId);
      return c.json({ disponible: false, mensaje: CEREBRO_NO_DISPONIBLE, prospectos: legado.map(desdeLegado), taxonomias: [] });
    }
    // Supresion por prospecto: funcion SOLO DE SISTEMA, en su propia sesion (si falla, el mapa sigue y NO ofrece contactar: nunca un 500).
    const suprimidos = await deps.engine
      .withAppSession({ userId: null }, (db) => suprimidosPorProspecto(db, r.lista.prospectos))
      .catch((err: unknown) => {
        console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", evento: "cerebro_supresion_no_verificada", error: err instanceof Error ? err.message : String(err) }));
        return null;
      });
    const prospectos = suprimidos === null ? r.lista.prospectos : r.lista.prospectos.map((p) => ({ ...p, suprimido: suprimidos.get(p.id) ?? { telefono: false, correo: false } }));
    return c.json({ disponible: true, prospectos, taxonomias: r.taxonomias.map(serializarTaxonomia) });
  });

  app.post("/superadmin/cerebro/exportaciones", async (c) => {
    const callerId = c.get("userId");
    await limitarMutaciones(c, callerId);
    const cuerpo = sanearExportacion(await c.req.json().catch(() => null));
    if (!cuerpo.ok) throw Errors.validation(cuerpo.error);
    const zona = deps.cfoZoneRepo;
    // Sin bitacora configurada o sin la migracion 0034 aplicada no hay donde registrar: se dice (`registrada: false`) y la pantalla lo avisa.
    // Si registrar LANZA, el error se propaga (500): la pantalla NO arma el archivo (mismo criterio que la lectura del MRR, sin_bitacora).
    if (!zona) return c.json({ registrada: false, motivo: "bitacora_no_disponible" });
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      zona(db).logAccess(callerId, "exportacion", "cerebro_prospectos", { ...cuerpo.filtros, total: cuerpo.total, _ruta: c.req.path.slice(0, 160) }),
    );
    if (r.availability === "not_migrated") return c.json({ registrada: false, motivo: "bitacora_no_disponible" });
    return c.json({ registrada: true });
  });

  async function guardar(c: Context<CoreAuthHonoEnv>, prospectoId: string | null) {
    const callerId = c.get("userId");
    await limitarMutaciones(c, callerId);
    const raw = await c.req.json().catch(() => null);
    const vertical = raw && typeof raw === "object" && typeof (raw as { vertical?: unknown }).vertical === "string" ? (raw as { vertical: string }).vertical : null;
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        // Taxonomia vigente de la vertical (si ya existe): valida subtipo y tamano contra ella.
        const tax = await listarTaxonomia(db, callerId);
        const vigente = tax.disponible && vertical ? vigentesPorVertical(tax.versiones).get(vertical) : undefined;
        const validado = validarDatosProspecto(raw, prospectoId === null, vigente ? { subtipos: vigente.subtipos.map((s) => s.clave), rangos: vigente.rangosTamano.rangos.map((x) => x.clave) } : null);
        if (!validado.ok) return { tipo: "invalido" as const, mensaje: validado.error, codigo: validado.codigo };
        return { tipo: "guardado" as const, resultado: await guardarProspecto(db, callerId, prospectoId, validado.valor, ahora()) };
      });
      if (r.tipo === "invalido") {
        if (r.codigo === "base_licitud_requerida") throw new ApiError(422, "base_licitud_requerida", r.mensaje);
        throw Errors.validation(r.mensaje);
      }
      if (r.resultado.estado === "no_migrada") throw Errors.serviceUnavailable(CEREBRO_NO_DISPONIBLE);
      if (r.resultado.estado === "no_existe") throw Errors.notFound("El prospecto no existe.");
      return c.json({ prospecto: r.resultado.prospecto }, prospectoId === null ? 201 : 200);
    } catch (err) {
      return traducirErrorPg(err);
    }
  }

  app.post("/superadmin/cerebro/prospectos", (c) => guardar(c, null));
  app.put("/superadmin/cerebro/prospectos/:id", (c) => guardar(c, idValido(c.req.param("id"))));

  app.get("/superadmin/cerebro/prospectos/:id/detalle", async (c) => {
    const callerId = c.get("userId");
    const id = idValido(c.req.param("id"));
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => detalleProspecto(db, callerId, id));
    if (!r.disponible) return c.json({ disponible: false, mensaje: CEREBRO_NO_DISPONIBLE, personas: [], eventos: [] });
    return c.json({ disponible: true, personas: r.personas, eventos: r.eventos });
  });

  app.post("/superadmin/cerebro/prospectos/:id/personas", async (c) => {
    const callerId = c.get("userId");
    await limitarMutaciones(c, callerId);
    const id = idValido(c.req.param("id"));
    const validada = validarPersona(await c.req.json().catch(() => null));
    if (!validada.ok) {
      if (validada.codigo === "evidencia_requerida" || validada.codigo === "origen_invalido") throw new ApiError(422, validada.codigo, validada.error);
      throw Errors.validation(validada.error);
    }
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => agregarPersona(db, callerId, id, validada.valor, ahora()));
      if (r.estado === "no_migrada") throw Errors.serviceUnavailable(CEREBRO_NO_DISPONIBLE);
      if (r.estado === "no_existe") throw Errors.notFound("El prospecto no existe.");
      return c.json({ persona: r.persona, prospecto: r.prospecto }, 201);
    } catch (err) {
      return traducirErrorPg(err);
    }
  });

  app.get("/superadmin/cerebro/taxonomia", async (c) => {
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => listarTaxonomia(db, callerId));
    if (!r.disponible) return c.json({ disponible: false, mensaje: CEREBRO_NO_DISPONIBLE, verticales: VERTICALES, versiones: [] });
    return c.json({ disponible: true, verticales: VERTICALES, versiones: r.versiones.map(serializarTaxonomia) });
  });

  app.put("/superadmin/cerebro/taxonomia/:vertical", async (c) => {
    const callerId = c.get("userId");
    await limitarMutaciones(c, callerId);
    const vertical = c.req.param("vertical");
    if (!(VERTICALES as readonly string[]).includes(vertical)) throw Errors.validation("vertical inválida.");
    const raw = (await c.req.json().catch(() => null)) as { contenido?: unknown; planId?: unknown; nota?: unknown; validada?: unknown } | null;
    if (!raw || typeof raw !== "object") throw Errors.validation("El cuerpo debe ser un objeto.");
    const contenido = validarContenidoTaxonomia(vertical, raw.contenido ?? {});
    if (!contenido.ok) throw Errors.validation(contenido.error);
    const planId = raw.planId === undefined || raw.planId === null || raw.planId === "" ? null : typeof raw.planId === "string" && raw.planId.length <= 60 ? raw.planId : undefined;
    if (planId === undefined) throw Errors.validation("planId inválido.");
    const nota = typeof raw.nota === "string" && raw.nota.trim() ? raw.nota.trim().slice(0, 500) : null;
    if (raw.validada !== undefined && typeof raw.validada !== "boolean") throw Errors.validation("validada debe ser verdadero o falso.");
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const tax = await listarTaxonomia(db, callerId);
        if (!tax.disponible) return { estado: "no_migrada" } as const;
        const incoherencia = validarCoherenciaIcp(contenido.valor, vigentesPorVertical(tax.versiones).get(vertical));
        if (incoherencia) return { estado: "rechazada", mensaje: incoherencia } as const;
        return guardarTaxonomia(db, callerId, vertical, contenido.valor, planId, nota, raw.validada === true);
      });
      if (r.estado === "no_migrada") throw Errors.serviceUnavailable(CEREBRO_NO_DISPONIBLE);
      if (r.estado === "rechazada") throw Errors.validation(r.mensaje);
      return c.json({ taxonomia: serializarTaxonomia(r.taxonomia) });
    } catch (err) {
      return traducirErrorPg(err);
    }
  });

  return app;
}
