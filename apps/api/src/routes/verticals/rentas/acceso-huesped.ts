// Rn-04 -- liberación de instrucciones de acceso al huésped (código de cerradura, dirección
// exacta) N horas antes del check-in, solo con reserva confirmada y pagada según la política.
//
// Staff (authMiddleware + dbSession + requirePropertyMembership; roles ACCESO_HUESPED_ROLES,
// la RLS de la migración 025 -- rentas.can_manage_acceso -- lo vuelve a exigir):
//   GET/PUT /rentas/:propertyId/acceso-huesped/politica
//   GET     /rentas/:propertyId/acceso-huesped/bitacora?limite=
//   GET     /rentas/:propertyId/acceso-huesped/reservas   reservas próximas con estado de pago/liberación
//   GET/PUT /rentas/:propertyId/unidades/:unidadId/acceso-instrucciones
//   POST    /rentas/:propertyId/reservas/:ocupacionId/pago-confirmado   { confirmado: boolean }
//   Rn-P3-08/09 (migracion 036):
//   GET/PUT /rentas/:propertyId/acceso-huesped/precheckin       enlace publico de la property, texto sugerido para la OTA y reglamento de la casa
//   GET     /rentas/:propertyId/acceso-huesped/pendientes       reservas proximas cuyo acceso se omitio por falta de correo y nadie entrego
//   GET     /rentas/:propertyId/reservas/:ocupacionId/acceso-mensaje   mensaje con las instrucciones DESCIFRADAS (bitacora lectura_admin, no-store)
//   POST    /rentas/:propertyId/reservas/:ocupacionId/entrega-manual   registra `entregada_manual` (la liberacion automatica ya no la toma)
// Cron (guard de secreto interno/Vercel Cron, igual que checkin-recordatorio.ts):
//   GET|POST /internal/rentas/acceso-huesped
// Cron en vercel.json (cada hora, minuto 10; ver docs/CRONS.md).
//
// Compatibilidad con la base sin migrar (migración 025 pendiente): las lecturas responden
// `disponible: false` y las escrituras 409 "aún no disponible"; el cron responde ok con
// `disponible: false` -- nunca un 500.
//
// Sin PII/secretos en logs: ningún handler imprime correo, dirección ni código. Las
// respuestas con el secreto llevan `Cache-Control: no-store`.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ACCESO_HUESPED_ROLES, AccesoDescifradoError, AccesoNoDisponibleError, POLITICA_ACCESO_POR_DEFECTO, PostgresRentasAccesoRepository, PostgresRentasPrecheckinRepository, ejecutarLiberacionAcceso, mensajeAccesoParaOta, textoSugeridoPrecheckin, validarInstruccion, validarPolitica, validarReglamento } from "@atiende/domain-rentas";
import type { PoliticaAcceso, RentasAccesoRepository, RentasPrecheckinRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { triggerRentasEmailDispatchInline } from "./email-dispatch.ts";
import { cifradorAccesoDeEntorno } from "./acceso-cipher.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE_BITACORA_MAX = 200;
const LIMITE_BITACORA_DEFECTO = 50;

/** Rn-29: sin llave valida el secreto no se lee ni se guarda: 503 "no disponible: falta RENTAS_ACCESS_KEY" (nunca texto plano ni 500). */
async function conLlave<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AccesoNoDisponibleError || err instanceof AccesoDescifradoError) throw Errors.serviceUnavailable(err.message);
    throw err;
  }
}

function requireUuid(value: string | undefined, campo: string): string {
  if (!value || !UUID_RE.test(value)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return value;
}

async function leerJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw Errors.validation("El cuerpo debe ser JSON válido.");
  }
}

const politicaAJson = (p: Pick<PoliticaAcceso, "activo" | "horasAntesCheckin" | "horaCheckin" | "exigirPago" | "otaCuentaComoPagada">) => ({
  activo: p.activo,
  horas_antes_checkin: p.horasAntesCheckin,
  hora_checkin: p.horaCheckin,
  exigir_pago: p.exigirPago,
  ota_cuenta_como_pagada: p.otaCuentaComoPagada,
});

export function rentasAccesoHuespedRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const accesoRepo = (db: Parameters<AppDeps["rentasRepo"]>[0]): RentasAccesoRepository => {
    if (deps.rentasAccesoRepo) return deps.rentasAccesoRepo(db);
    const { cipher, error } = cifradorAccesoDeEntorno(deps.env);
    return new PostgresRentasAccesoRepository(db, cipher, error);
  };

  const precheckinRepo = (db: Parameters<AppDeps["rentasRepo"]>[0]): RentasPrecheckinRepository => (deps.rentasPrecheckinRepo ? deps.rentasPrecheckinRepo(db) : new PostgresRentasPrecheckinRepository(db));

  const rutas = [
    "/rentas/:propertyId/acceso-huesped/precheckin",
    "/rentas/:propertyId/acceso-huesped/pendientes",
    "/rentas/:propertyId/reservas/:ocupacionId/acceso-mensaje",
    "/rentas/:propertyId/reservas/:ocupacionId/entrega-manual",
    "/rentas/:propertyId/acceso-huesped/politica",
    "/rentas/:propertyId/acceso-huesped/bitacora",
    "/rentas/:propertyId/acceso-huesped/reservas",
    "/rentas/:propertyId/unidades/:unidadId/acceso-instrucciones",
    "/rentas/:propertyId/reservas/:ocupacionId/pago-confirmado",
  ];
  for (const ruta of rutas) app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/rentas/:propertyId/acceso-huesped/politica", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const r = await accesoRepo(c.get("db")).obtenerPolitica(c.req.param("propertyId"));
    if (!r.disponible) return c.json({ disponible: false, politica: null, configurada: false }, 200);
    return c.json({ disponible: true, configurada: r.valor !== null, politica: politicaAJson(r.valor ?? POLITICA_ACCESO_POR_DEFECTO) }, 200);
  });

  app.put("/rentas/:propertyId/acceso-huesped/politica", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const v = validarPolitica(await leerJson(c));
    if (!v.ok) throw Errors.validation(v.error);
    const r = await accesoRepo(c.get("db")).guardarPolitica(c.get("organizationId") as string, c.req.param("propertyId"), v.valor, c.get("userId"));
    if (!r.disponible) throw Errors.conflict("La liberación de acceso al huésped aún no está disponible en este ambiente (migración pendiente).");
    return c.json({ disponible: true, configurada: true, politica: politicaAJson(r.valor) }, 200);
  });

  app.get("/rentas/:propertyId/acceso-huesped/bitacora", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const crudo = c.req.query("limite");
    let limite = LIMITE_BITACORA_DEFECTO;
    if (crudo !== undefined) {
      limite = Number(crudo);
      if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_BITACORA_MAX) throw Errors.validation(`limite: se esperaba un entero entre 1 y ${LIMITE_BITACORA_MAX}.`);
    }
    const r = await accesoRepo(c.get("db")).listarBitacora(c.req.param("propertyId"), limite);
    if (!r.disponible) return c.json({ disponible: false, eventos: [] }, 200);
    return c.json({ disponible: true, eventos: r.valor.map((e) => ({ id: e.id, reserva_id: e.ocupacionId, evento: e.evento, canal: e.canal, creado_en: e.creadoEn })) }, 200);
  });

  app.get("/rentas/:propertyId/acceso-huesped/reservas", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const r = await accesoRepo(c.get("db")).listarReservasProximas(c.req.param("propertyId"), 100);
    if (!r.disponible) return c.json({ disponible: false, reservas: [] }, 200);
    return c.json(
      {
        disponible: true,
        reservas: r.valor.map((x) => ({
          reserva_id: x.ocupacionId,
          unidad_id: x.unidadId,
          unidad_nombre: x.unidadNombre,
          canal: x.canal,
          check_in: x.checkIn,
          check_out: x.checkOut,
          huesped_nombre: x.huespedNombre,
          pago_confirmado: x.pagoConfirmado,
          liberada: x.liberada,
        })),
      },
      200,
    );
  });

  app.get("/rentas/:propertyId/unidades/:unidadId/acceso-instrucciones", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const unidadId = requireUuid(c.req.param("unidadId"), "unidadId");
    const r = await conLlave(() => accesoRepo(c.get("db")).obtenerInstruccion(c.req.param("propertyId"), unidadId));
    c.header("Cache-Control", "no-store");
    if (!r.disponible) return c.json({ disponible: false, instrucciones: null }, 200);
    return c.json(
      { disponible: true, instrucciones: r.valor ? { direccion_exacta: r.valor.direccionExacta, codigo_acceso: r.valor.codigoAcceso, instrucciones: r.valor.instrucciones } : null },
      200,
    );
  });

  app.put("/rentas/:propertyId/unidades/:unidadId/acceso-instrucciones", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const unidadId = requireUuid(c.req.param("unidadId"), "unidadId");
    const v = validarInstruccion(await leerJson(c));
    if (!v.ok) throw Errors.validation(v.error);
    const r = await conLlave(() => accesoRepo(c.get("db")).guardarInstruccion(c.get("organizationId") as string, c.req.param("propertyId"), unidadId, v.valor, c.get("userId")));
    if (!r.disponible) throw Errors.conflict("La liberación de acceso al huésped aún no está disponible en este ambiente (migración pendiente).");
    if (r.valor === null) throw Errors.notFound("Unidad no encontrada en esta property.");
    c.header("Cache-Control", "no-store");
    return c.json({ disponible: true, instrucciones: { direccion_exacta: r.valor.direccionExacta, codigo_acceso: r.valor.codigoAcceso, instrucciones: r.valor.instrucciones } }, 200);
  });

  app.post("/rentas/:propertyId/reservas/:ocupacionId/pago-confirmado", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const ocupacionId = requireUuid(c.req.param("ocupacionId"), "ocupacionId");
    const cuerpo = (await leerJson(c)) as { confirmado?: unknown } | null;
    if (typeof cuerpo !== "object" || cuerpo === null || typeof cuerpo.confirmado !== "boolean") throw Errors.validation("confirmado: se esperaba true o false.");
    const r = await accesoRepo(c.get("db")).confirmarPago(ocupacionId, cuerpo.confirmado);
    if (r === "no_disponible") throw Errors.conflict("La liberación de acceso al huésped aún no está disponible en este ambiente (migración pendiente).");
    if (r === "no_encontrada") throw Errors.notFound("Reserva no encontrada en esta property.");
    return c.json({ reserva_id: ocupacionId, pago_confirmado: r === "confirmado" }, 200);
  });

  // ---- Rn-P3-08: enlace publico de pre-check-in y reglamento de la casa ----
  const configAJson = (propertyId: string, reglamento: string | null, version: number) => {
    const enlace = `${deps.env.appBaseUrl}/rentas/precheckin/${propertyId}`;
    return { disponible: true, enlace_publico: enlace, texto_sugerido: textoSugeridoPrecheckin(enlace), reglamento, reglamento_version: version };
  };

  app.get("/rentas/:propertyId/acceso-huesped/precheckin", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const propertyId = c.req.param("propertyId");
    const r = await precheckinRepo(c.get("db")).obtenerConfig(propertyId);
    if (!r.disponible) return c.json({ disponible: false, enlace_publico: null, texto_sugerido: null, reglamento: null, reglamento_version: 1 }, 200);
    return c.json(configAJson(propertyId, r.valor.reglamento, r.valor.reglamentoVersion), 200);
  });

  app.put("/rentas/:propertyId/acceso-huesped/precheckin", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const v = validarReglamento(await leerJson(c));
    if (!v.ok) throw Errors.validation(v.error);
    const propertyId = c.req.param("propertyId");
    const r = await precheckinRepo(c.get("db")).guardarReglamento(c.get("organizationId") as string, propertyId, v.valor.reglamento, c.get("userId"));
    if (!r.disponible) throw Errors.conflict("El pre-check-in aún no está disponible en este ambiente (migración pendiente).");
    return c.json(configAJson(propertyId, r.valor.reglamento, r.valor.reglamentoVersion), 200);
  });

  // ---- Rn-P3-09: accesos omitidos por falta de correo ----
  app.get("/rentas/:propertyId/acceso-huesped/pendientes", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const r = await accesoRepo(c.get("db")).listarPendientesEntrega(c.req.param("propertyId"), 100);
    if (!r.disponible) return c.json({ disponible: false, pendientes: [] }, 200);
    return c.json(
      {
        disponible: true,
        pendientes: r.valor.map((p) => ({
          reserva_id: p.ocupacionId,
          unidad_id: p.unidadId,
          unidad_nombre: p.unidadNombre,
          canal: p.canal,
          check_in: p.checkIn,
          check_out: p.checkOut,
          huesped_nombre: p.huespedNombre,
          omitida_en: p.omitidaEn,
        })),
      },
      200,
    );
  });

  app.get("/rentas/:propertyId/reservas/:ocupacionId/acceso-mensaje", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const ocupacionId = requireUuid(c.req.param("ocupacionId"), "ocupacionId");
    const propertyId = c.req.param("propertyId");
    const repo = accesoRepo(c.get("db"));
    c.header("Cache-Control", "no-store");
    const reserva = await repo.obtenerReservaParaMensaje(propertyId, ocupacionId);
    if (!reserva.disponible) return c.json({ disponible: false, mensaje: null }, 200);
    if (reserva.valor === null) throw Errors.notFound("Reserva no encontrada en esta property.");
    // Descifra con bitacora `lectura_admin` (Rn-29); sin llave valida responde 503, nunca texto plano.
    const instruccion = await conLlave(() => repo.obtenerInstruccion(propertyId, reserva.valor!.unidadId));
    if (!instruccion.disponible) return c.json({ disponible: false, mensaje: null }, 200);
    if (instruccion.valor === null) throw Errors.conflict("La unidad no tiene instrucciones de acceso capturadas: captúralas antes de copiar el mensaje.");
    return c.json({ disponible: true, mensaje: mensajeAccesoParaOta(reserva.valor, instruccion.valor) }, 200);
  });

  app.post("/rentas/:propertyId/reservas/:ocupacionId/entrega-manual", async (c) => {
    assertVerticalRole(c, ACCESO_HUESPED_ROLES);
    const ocupacionId = requireUuid(c.req.param("ocupacionId"), "ocupacionId");
    const r = await accesoRepo(c.get("db")).marcarEntregadaManual(ocupacionId, c.req.param("propertyId"));
    if (r === "no_disponible") throw Errors.conflict("La entrega manual aún no está disponible en este ambiente (migración pendiente).");
    if (r === "no_encontrada") throw Errors.notFound("Reserva no encontrada en esta property.");
    return c.json({ reserva_id: ocupacionId, entregada: true, nueva: r === "entregada" }, 200);
  });

  // ---- Barrido de cifrado de las instrucciones heredadas en texto plano (Rn-29) ----
  // Sistema (guard de secreto interno/cron), SOLO POR POST y NO agendado en vercel.json: se corre a mano tras aplicar la
  // migracion 028 y configurar RENTAS_ACCESS_KEY. Idempotente: cifra, verifica el ida y vuelta y SOLO entonces anula el texto plano.
  // Una transaccion por tanda (`limite` filas, 1..200, por defecto 50); repetir hasta `ok: true` y `cifradas: 0` (`fallidas > 0` = filas que siguen en claro). Sin llave: 503.
  app.post("/internal/rentas/acceso-cifrar", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const crudo = c.req.query("limite");
    let limite = 50;
    if (crudo !== undefined) {
      limite = Number(crudo);
      if (!Number.isInteger(limite) || limite < 1 || limite > 200) throw Errors.validation("limite: se esperaba un entero entre 1 y 200.");
    }
    const r = await conLlave(() => deps.engine.withAppSession({ userId: null }, (db) => accesoRepo(db).cifrarPendientes(limite)));
    return c.json({ ok: r.fallidas === 0, disponible: r.disponible, cifradas: r.cifradas, fallidas: r.fallidas }, 200);
  });

  // ---- Cron ----
  app.on(["GET", "POST"], "/internal/rentas/acceso-huesped", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/acceso-huesped", async () => {
      // Una transacción POR RESERVA (ver @atiende/domain-rentas::ejecutarLiberacionAcceso).
      const resumen = await ejecutarLiberacionAcceso((fn) => deps.engine.withAppSession({ userId: null }, (db) => fn({ acceso: accesoRepo(db), rentas: deps.rentasRepo(db) })));
      if (resumen.liberadas > 0) {
        // Disparo inline best-effort del outbox (mismo patrón que checkin-recordatorio.ts):
        // sin esto el correo esperaría al cron diario de email-dispatch.
        await deps.engine.withAppSession({ userId: null }, (db) => triggerRentasEmailDispatchInline(deps, db, deps.rentasRepo(db)));
      }
      const response = c.json(
        {
          ok: resumen.errores === 0,
          disponible: resumen.disponible,
          liberadas: resumen.liberadas,
          omitidas_sin_contacto: resumen.omitidasSinContacto,
          omitidas_sin_instrucciones: resumen.omitidasSinInstrucciones,
          errores: resumen.errores,
          truncada: resumen.truncada,
        },
        200,
      );
      if (resumen.errores > 0) throw new CronPartialFailureError(`acceso-huesped: ${resumen.errores} reserva(s) fallaron`, response);
      return response;
    })();
  });

  return app;
}
