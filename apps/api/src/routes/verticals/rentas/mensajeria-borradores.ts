// Fase 7 -- cola de aprobación humana obligatoria para mensajería con huésped
// (packages/domain-rentas/src/mensajeria/colaAprobacion.ts). NINGUNA ruta de este
// archivo envía un mensaje sin que exista, en la misma llamada, una transición
// explícita `aprobado -> enviado` (`marcarEnviadoTrasAprobacion`) -- no existe un
// endpoint "enviar" separado que un cliente pueda invocar directamente sin pasar por
// `/aprobar`. `POST .../intento-automatico` es el punto de prueba explícito del
// entregable "borrador no se envía sin aprobación: intento automático -> error
// tipado y auditoría" -- SIEMPRE responde con el error tipado, sin excepción, ver
// apps/api/tests/rentas-mensajeria.spec.ts.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AprobacionRequeridaError,
  ActorSinPermisoParaProponerBorradorError,
  BorradorIASinPropuestaError,
  ContenidoProhibidoError,
  GeneracionBorradorIAFallidaError,
  GeneradorBorradorIA,
  GeneradorBorradorPlantillas,
  MENSAJERIA_ESCRITURA_ROLES,
  MensajeExcedeLongitudError,
  SimuladorCanalMensajeria,
  TransicionBorradorInvalidaError,
  aprobarBorrador,
  intentarEnvioAutomatico,
  marcarEnviadoTrasAprobacion,
  rechazarBorrador,
  validarMensajeSaliente,
} from "@atiende/domain-rentas";
import type { ActorAgente, BorradorEstado, BorradorRecord, ContextoBorrador, RentasVerticalRole, ResultadoBorrador } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Traduce los errores tipados de dominio de mensajería al status HTTP
 * correspondiente -- mismo patrón que `mapRentasDomainError` de reservas.ts. */
function traducirErrorMensajeria(error: unknown): unknown {
  if (error instanceof MensajeExcedeLongitudError) return Errors.rentasMensajeExcedeLimite(error.message);
  if (error instanceof ContenidoProhibidoError) return Errors.rentasMensajeContenidoNoPermitido(error.message);
  if (error instanceof AprobacionRequeridaError) return Errors.rentasMensajeAprobacionRequerida(error.message);
  if (error instanceof TransicionBorradorInvalidaError) return Errors.rentasMensajeTransicionInvalida(error.message);
  if (error instanceof ActorSinPermisoParaProponerBorradorError) return Errors.forbidden(error.message);
  if (error instanceof BorradorIASinPropuestaError) return Errors.rentasMensajeriaSinPropuesta(error.message);
  if (error instanceof GeneracionBorradorIAFallidaError) return Errors.serviceUnavailable(error.message);
  return error;
}

interface CrearBorradorBody {
  readonly mensajeEntranteId?: unknown;
  /** `true` conecta `GeneradorBorradorIA` (respaldado por `deps.llmGateway`) en vez
   * del motor determinista sin LLM -- mismo criterio que `usarIa` en el repo origen:
   * si no hay gateway configurado para este ambiente, 503 explícito
   * (`rentasMensajeriaAgentesDeshabilitado`), nunca una degradación silenciosa al
   * motor determinista cuando un operador pidió explícitamente el motor de IA. */
  readonly usarIa?: unknown;
}

interface RechazarBorradorBody {
  readonly motivo?: unknown;
}

function requireMotivo(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw Errors.validation("motivo: se esperaba un texto no vacío.");
  return value.trim();
}

function contextoDesdeConversacion(conversacion: { huespedNombre: string | null; propiedadNombre: string; fechaCheckIn: string | null; fechaCheckOut: string | null; reservaConfirmada: boolean; canal: ContextoBorrador["canal"] }): ContextoBorrador {
  return {
    nombreHuesped: conversacion.huespedNombre,
    propiedadNombre: conversacion.propiedadNombre,
    fechaCheckIn: conversacion.fechaCheckIn,
    fechaCheckOut: conversacion.fechaCheckOut,
    reservaConfirmada: conversacion.reservaConfirmada,
    canal: conversacion.canal,
  };
}

export function rentasMensajeriaBorradoresRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const baseGenerar = "/rentas/:propertyId/conversaciones/:conversacionId/borradores";
  const baseAprobar = "/rentas/:propertyId/borradores/:id/aprobar";
  const baseRechazar = "/rentas/:propertyId/borradores/:id/rechazar";
  const baseIntentoAutomatico = "/rentas/:propertyId/borradores/:id/intento-automatico";

  app.use(baseGenerar, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(baseAprobar, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(baseRechazar, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(baseIntentoAutomatico, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // GET .../conversaciones/:conversacionId/borradores -- lectura abierta a cualquier
  // staff con acceso a la property (mismo criterio que GET de conversaciones).
  app.get(baseGenerar, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"), async (c) => {
    const propertyId = c.req.param("propertyId");
    const conversacionId = c.req.param("conversacionId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);
    const conversacion = await mensajeriaRepo.findConversacion(propertyId, conversacionId);
    if (!conversacion) throw Errors.notFound("Conversación no encontrada en esta property.");
    const borradores = await mensajeriaRepo.listBorradores(propertyId, conversacionId);
    return c.json({ borradores }, 200);
  });

  // POST .../conversaciones/:conversacionId/borradores -- genera un borrador (H-059)
  // a partir de un mensaje entrante ya registrado (o de texto vacío, si aún no hay
  // ninguno) y lo inserta SIEMPRE en 'pendiente_aprobacion'. El texto del huésped se
  // pasa como DATO estructurado a ambos generadores (determinista/IA), nunca como
  // instrucción -- ver domain-rentas/src/mensajeria/borrador.ts y
  // src/agentes/generadorBorradorIA.ts.
  app.post(baseGenerar, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const conversacionId = c.req.param("conversacionId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const conversacion = await mensajeriaRepo.findConversacion(propertyId, conversacionId);
    if (!conversacion) throw Errors.notFound("Conversación no encontrada en esta property.");

    const raw = await readJsonCapped<CrearBorradorBody>(c.req.raw, 4 * 1024);
    const usarIa = raw.usarIa === true;

    let mensajeEntranteId: string | null = null;
    let textoEntrada = "";
    if (typeof raw.mensajeEntranteId === "string" && raw.mensajeEntranteId) {
      const mensaje = await mensajeriaRepo.findMensajeEntrante(conversacionId, raw.mensajeEntranteId);
      if (!mensaje) throw Errors.notFound("Mensaje entrante no encontrado en esta conversación.");
      mensajeEntranteId = mensaje.id;
      textoEntrada = mensaje.texto;
    }

    const ctxBorrador = contextoDesdeConversacion(conversacion);

    let generado: ResultadoBorrador;
    let generadoPor: "motor_borrador" | "agente_llm";
    try {
      if (usarIa) {
        if (!deps.llmGateway) throw Errors.rentasMensajeriaAgentesDeshabilitado();
        const actor: ActorAgente = { usuarioId: c.get("userId"), rol: c.get("verticalRole") as RentasVerticalRole };
        const generador = new GeneradorBorradorIA(deps.llmGateway, actor, { tenantId: organizationId });
        generado = await generador.generar({ texto: textoEntrada, idioma: "es" }, ctxBorrador);
        generadoPor = "agente_llm";
      } else {
        generado = new GeneradorBorradorPlantillas().generar({ texto: textoEntrada, idioma: "es" }, ctxBorrador);
        generadoPor = "motor_borrador";
      }
    } catch (err) {
      throw traducirErrorMensajeria(err);
    }

    const borrador = await mensajeriaRepo.insertBorrador({ conversacionId, mensajeEntranteId, canal: conversacion.canal, texto: generado.texto, generadoPor });

    console.log(
      JSON.stringify({
        evento: "rentas_borrador_generado",
        borradorId: borrador.id,
        conversacionId,
        estado: "pendiente_aprobacion",
        generadoPor,
        necesitaEscalamiento: generado.necesitaEscalamiento,
        senales: generado.senales,
      }),
    );

    return c.json({ ...borrador, necesitaEscalamiento: generado.necesitaEscalamiento, senales: generado.senales }, 201);
  });

  // POST .../borradores/:id/aprobar -- ÚNICA ruta que puede terminar en un mensaje
  // saliente real. Aplica la política de canal (H-057/H-058) sobre el texto
  // aprobado, transiciona el borrador (pendiente_aprobacion -> aprobado -> enviado,
  // sin saltos) e inserta el mensaje saliente.
  app.post(baseAprobar, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const actual = await mensajeriaRepo.findBorrador(propertyId, id);
    if (!actual) throw Errors.notFound("Borrador no encontrado en esta property.");

    let actualizado: BorradorRecord;
    let redactado: boolean;
    try {
      const estado: BorradorEstado = { id: actual.id, estado: actual.estado };
      aprobarBorrador(estado, userId);

      const conversacion = await mensajeriaRepo.findConversacion(propertyId, actual.conversacionId);
      if (!conversacion) throw Errors.notFound("Conversación asociada al borrador no encontrada.");

      const validado = validarMensajeSaliente({ canal: actual.canal, texto: actual.texto, reservaConfirmada: conversacion.reservaConfirmada });

      const canal = new SimuladorCanalMensajeria(actual.canal);
      const envio = await canal.enviarMensajeAprobado({ borradorId: actual.id, texto: validado.texto, aprobadoPor: userId });

      // Solo AHORA, con aprobadoPor poblado, se permite 'enviado'.
      marcarEnviadoTrasAprobacion({ id: actual.id, estado: "aprobado" });

      const mensajeSaliente = await mensajeriaRepo.insertMensaje({ conversacionId: actual.conversacionId, direccion: "saliente", origen: "simulador", texto: validado.texto, redactado: validado.redactado });

      actualizado = await mensajeriaRepo.marcarBorradorAprobadoYEnviado({ id: actual.id, aprobadoPor: userId, textoFinal: validado.texto, redactado: validado.redactado, mensajeEnviadoId: mensajeSaliente.id });
      redactado = validado.redactado;

      console.log(
        JSON.stringify({ evento: "rentas_borrador_aprobado_y_enviado", borradorId: id, aprobadoPor: userId, canal: actual.canal, redactado, enviadoEn: envio.enviadoEn }),
      );
    } catch (err) {
      throw traducirErrorMensajeria(err);
    }

    return c.json(actualizado, 200);
  });

  // POST .../borradores/:id/rechazar
  app.post(baseRechazar, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const userId = c.get("userId");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const actual = await mensajeriaRepo.findBorrador(propertyId, id);
    if (!actual) throw Errors.notFound("Borrador no encontrado en esta property.");

    const raw = await readJsonCapped<RechazarBorradorBody>(c.req.raw, 2 * 1024);
    const motivo = requireMotivo(raw.motivo);

    let actualizado: BorradorRecord;
    try {
      rechazarBorrador({ id: actual.id, estado: actual.estado }, userId, motivo);
      actualizado = await mensajeriaRepo.marcarBorradorRechazado({ id: actual.id, rechazadoPor: userId, motivo });
    } catch (err) {
      throw traducirErrorMensajeria(err);
    }

    console.log(JSON.stringify({ evento: "rentas_borrador_rechazado", borradorId: id, rechazadoPor: userId }));
    return c.json(actualizado, 200);
  });

  // POST .../borradores/:id/intento-automatico -- punto de prueba explícito del
  // entregable "borrador no se envía sin aprobación: intento automático -> error
  // tipado y auditoría". Simula lo que haría un worker/scheduler que intentara
  // enviar SIN que un humano haya pulsado "aprobar" -- SIEMPRE es rechazado, sin
  // excepción, incluso si el borrador ya está aprobado (D-006: no existe ruta de
  // envío directo para procesos automáticos, ver
  // colaAprobacion.ts::intentarEnvioAutomatico). Deliberadamente NO exige
  // `MENSAJERIA_ESCRITURA_ROLES`: cualquier miembro del staff con acceso a la
  // property puede disparar/observar este endpoint de auditoría -- la garantía real
  // no depende de quién lo llame, depende de que la función de dominio SIEMPRE lance.
  app.post(baseIntentoAutomatico, async (c) => {
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const actual = await mensajeriaRepo.findBorrador(propertyId, id);
    if (!actual) throw Errors.notFound("Borrador no encontrado en esta property.");

    // Deja un rastro de auditoría (actualizado_en) del intento, aunque no cambie el
    // estado.
    await mensajeriaRepo.tocarBorradorParaAuditoria(id);

    try {
      intentarEnvioAutomatico({ id: actual.id, estado: actual.estado });
    } catch (err) {
      console.error(JSON.stringify({ evento: "rentas_intento_envio_automatico_rechazado", borradorId: id, motivo: "sin_aprobacion_humana_en_el_instante_del_envio" }));
      throw traducirErrorMensajeria(err);
    }
    // intentarEnvioAutomatico siempre lanza -- este punto es inalcanzable, pero
    // TypeScript exige un retorno explícito.
    return c.json({ error: "inalcanzable" }, 500);
  });

  return app;
}
