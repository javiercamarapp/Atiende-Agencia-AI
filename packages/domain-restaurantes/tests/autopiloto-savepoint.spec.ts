// Autopiloto + REGLA DURA de compatibilidad con la base SIN migrar: el repositorio corre en la transaccion unica del request/unidad. Contra la
// base vieja (42883/42P01/42703) cae a "no disponible" SIN abortar la transaccion (AbortAwareFakeSession reproduce el 25P02 y el COMMIT que
// devolveria ROLLBACK). 42501/22023 se traducen a errores tipados (403/422) y tampoco dejan la transaccion abortada.
import { describe, expect, it } from "vitest";
import { AutopilotoAccesoError, AutopilotoValidacionError, PostgresAutopilotoRepository, estimarTiempoSucursal } from "../src/autopiloto/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PROP = "00000000-0000-4000-8000-0000000000a2";
const ORDER = "00000000-0000-4000-8000-0000000000a3";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  // Postgres real: 42883 trae "function restaurantes.x(uuid) does not exist" (un "operator does not exist" NO es una migracion pendiente).
  const err = new Error(code === "42883" ? "function restaurantes.autopiloto_x(uuid) does not exist" : message) as Error & { code: string };
  err.code = code;
  return err;
}

async function sesionViva(s: AbortAwareFakeSession): Promise<void> {
  await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
}

describe("PostgresAutopilotoRepository contra la base sin migrar", () => {
  it.each(["42883", "42P01", "42703"])("leerConfig (%s): valores por omision seguros, disponible=false y la sesion sigue viva", async (code) => {
    const s = new AbortAwareFakeSession([{ match: /autopiloto_config_leer/, respond: () => pgError(code, "does not exist") }, SIGUIENTE]);
    const r = await new PostgresAutopilotoRepository(s).leerConfig(ORG, PROP);
    expect(r.disponible).toBe(false);
    expect(r.valor.cancelacionAuto).toBe(false);
    expect(r.valor.aceptacionAuto).toBe(false);
    expect(r.valor.aprobacionMinutos).toBe(10);
    await sesionViva(s);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("bandera por organizacion: base SIN migrar => apagada (el agente sigue por el camino de siempre) y la sesion sigue viva; migrada => la lee", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /autopiloto_org_config_leer/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(viejo).leerConfigOrg(ORG)).toEqual({ disponible: false, valor: { cancelacionAgente: false } });
    await sesionViva(viejo);
    const nuevo = new AbortAwareFakeSession([{ match: /autopiloto_org_config_leer/, respond: () => [{ v: true }] }]);
    expect(await new PostgresAutopilotoRepository(nuevo).leerConfigOrg(ORG)).toEqual({ disponible: true, valor: { cancelacionAgente: true } });
  });

  it("guardar la bandera por organizacion: sin migrar => no disponible; 42501 (sin alcance organizacional) => 403", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /autopiloto_org_config_guardar/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(viejo).guardarConfigOrg(ORG, { cancelacionAgente: true })).toEqual({ disponible: false });
    await sesionViva(viejo);
    const sa = new AbortAwareFakeSession([{ match: /autopiloto_org_config_guardar/, respond: () => pgError("42501", "sin acceso") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(sa).guardarConfigOrg(ORG, { cancelacionAgente: true })).rejects.toBeInstanceOf(AutopilotoAccesoError);
    await sesionViva(sa);
  });

  it("retenerPedidoGrande: base sin migrar => no_disponible (el pedido sigue el flujo anterior) y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /solicitud_pedido_grande_retener/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(s).retenerPedidoGrande(ORG, ORDER, {})).toEqual({ estado: "no_disponible", solicitudId: null, propertyId: null });
    await sesionViva(s);
  });

  it("retenerPedidoGrande: base migrada devuelve creada/existente", async () => {
    const s = new AbortAwareFakeSession([{ match: /solicitud_pedido_grande_retener/, respond: () => [{ id: "s1", creada: true, property_id: PROP }] }]);
    expect(await new PostgresAutopilotoRepository(s).retenerPedidoGrande(ORG, ORDER, { total: 1 })).toEqual({ estado: "creada", solicitudId: "s1", propertyId: PROP });
    const s2 = new AbortAwareFakeSession([{ match: /solicitud_pedido_grande_retener/, respond: () => [{ id: "s1", creada: false, property_id: PROP }] }]);
    expect((await new PostgresAutopilotoRepository(s2).retenerPedidoGrande(ORG, ORDER, {})).estado).toBe("existente");
  });

  it("resolverSolicitud: base sin migrar => null; migrada => mapea el resultado (aplicado=false en doble clic)", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /solicitud_resolver/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(viejo).resolverSolicitud(ORG, "s1", "aprobar", {})).toBeNull();
    await sesionViva(viejo);
    const fila = { aplicado: false, estado: "resuelta", decision: "aprobar", tipo: "pedido_grande", order_id: ORDER, property_id: PROP, estado_pedido: "pending", codigo_descuento: null, reposicion_order_id: null };
    const nuevo = new AbortAwareFakeSession([{ match: /solicitud_resolver/, respond: () => [fila] }]);
    expect(await new PostgresAutopilotoRepository(nuevo).resolverSolicitud(ORG, "s1", "aprobar", {})).toMatchObject({ aplicado: false, tipo: "pedido_grande", estadoPedido: "pending" });
  });

  it("42501 => AutopilotoAccesoError (403) y 22023 => AutopilotoValidacionError (422), sin dejar la transaccion abortada", async () => {
    const sa = new AbortAwareFakeSession([{ match: /solicitud_resolver/, respond: () => pgError("42501", "sin acceso") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(sa).resolverSolicitud(ORG, "s1", "aprobar", {})).rejects.toBeInstanceOf(AutopilotoAccesoError);
    await sesionViva(sa);
    const sv = new AbortAwareFakeSession([{ match: /solicitud_resolver/, respond: () => pgError("22023", "motivo") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(sv).resolverSolicitud(ORG, "s1", "rechazar", { motivo: "x" })).rejects.toBeInstanceOf(AutopilotoValidacionError);
    await sesionViva(sv);
  });

  it("un error de Postgres NO recuperable se repropaga (no se enmascara como 'no disponible') y la sesion queda viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /autopiloto_candidatos_estados/, respond: () => pgError("57014", "statement timeout") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(s).candidatosEstados(new Date(), 10)).rejects.toThrow("statement timeout");
    await sesionViva(s);
  });

  it("lecturas del tick: sin migrar => vacias y no disponibles; migradas => mapeadas", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /handoffs_devolver_vencidos|solicitudes_por_escalar|agotados_reponer|comandas_para_avance|tiempo_entrega_muestras/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    const repo = new PostgresAutopilotoRepository(viejo);
    expect((await repo.devolverHandoffsVencidos(new Date(), 5)).disponible).toBe(false);
    expect((await repo.solicitudesPorEscalar(new Date(), 5)).disponible).toBe(false);
    expect((await repo.reponerAgotados(new Date())).disponible).toBe(false);
    expect((await repo.comandasParaAvance(5)).disponible).toBe(false);
    expect((await repo.muestrasTiempo(ORG, PROP, "domicilio", new Date())).valor).toEqual({ muestras: [], abiertos: 0 });
    await sesionViva(viejo);
    const nuevo = new AbortAwareFakeSession([
      { match: /tiempo_entrega_muestras/, respond: () => [{ r: { muestras: [30, "40.5"], abiertos: 4 } }] },
      { match: /agotados_reponer/, respond: () => [{ property_id: PROP, product_id: "p1", organization_id: ORG, agotado_hasta: "2026-03-12" }] },
    ]);
    const r2 = new PostgresAutopilotoRepository(nuevo);
    expect((await r2.muestrasTiempo(ORG, PROP, "domicilio", new Date())).valor).toEqual({ muestras: [30, 40.5], abiertos: 4 });
    expect((await r2.reponerAgotados(new Date())).valor).toEqual([{ organizationId: ORG, propertyId: PROP, productId: "p1", agotadoHasta: "2026-03-12" }]);
  });

  it("listarSolicitudes: base sin migrar => lista vacia 'no disponible aun' (nunca un 500)", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.solicitud_aprobacion/, respond: () => pgError("42P01", "relation does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(s).listarSolicitudes(ORG, { propertyIds: null, estado: "pendiente", limite: 20 })).toEqual({ disponible: false, valor: [] });
    await sesionViva(s);
  });

  it("listarSolicitudes: filtra por organizacion y sucursales y mapea el pedido para decidir con un clic", async () => {
    const fila = {
      id: "s1", organization_id: ORG, property_id: PROP, tipo: "pedido_grande", estado: "pendiente", order_id: ORDER, detalle: { total: 4500 }, decision: null, motivo_resolucion: null,
      codigo_descuento: null, solicitada_at: new Date("2026-10-04T12:00:00Z"), escalada_at: null, resuelta_at: null, order_number: "88", total: "4500.00", order_status: "por_aprobar",
      customer_name: "Deb", canal: "domicilio", items: [{ name: "Coca-Cola", quantity: 2 }],
    };
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.solicitud_aprobacion/, respond: () => [fila] }]);
    const r = await new PostgresAutopilotoRepository(s).listarSolicitudes(ORG, { propertyIds: [PROP], estado: "pendiente", limite: 20 });
    expect(r.disponible).toBe(true);
    expect(r.valor[0]).toMatchObject({ id: "s1", tipo: "pedido_grande", pedido: { numero: 88, total: 4500, status: "por_aprobar", renglones: [{ indice: 0, nombre: "Coca-Cola", cantidad: 2 }] } });
  });

  it("estimarTiempoSucursal (GET /tiempo) contra la base SIN migrar: config y muestras fallan con 42883 en la MISMA sesion y cae al texto fijo del dueno, sin 25P02 ni 3B001", async () => {
    const s = new AbortAwareFakeSession([
      { match: /autopiloto_config_leer/, respond: () => pgError("42883", "function does not exist") },
      { match: /tiempo_entrega_muestras/, respond: () => pgError("42883", "function does not exist") },
      SIGUIENTE,
    ]);
    const repo = { findWhatsAppAgentConfig: async () => ({ deliveryTimeText: "35-45 min" }) } as unknown as Parameters<typeof estimarTiempoSucursal>[0]["repo"];
    const r = await estimarTiempoSucursal({ auto: new PostgresAutopilotoRepository(s), repo }, { organizationId: ORG, propertyId: PROP, canal: "domicilio", ahora: new Date("2026-10-04T18:00:00Z") });
    expect(JSON.stringify(r)).toContain("35-45");
    await sesionViva(s);
    expect(s.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(2);
  });
});

describe("PostgresAutopilotoRepository: funciones de la migracion 077 contra la base sin migrar (QA R2 features/viaje)", () => {
  it.each(["42883", "42P01", "42703"])("handoffsPendientesPorEscalar (%s): lista vacia, disponible=false y la sesion sigue viva", async (code) => {
    const s = new AbortAwareFakeSession([{ match: /handoffs_pendientes_por_escalar/, respond: () => pgError(code, "does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(s).handoffsPendientesPorEscalar(new Date(), 50)).toEqual({ disponible: false, valor: [] });
    await sesionViva(s);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("handoffsPendientesPorEscalar: base migrada devuelve las tomas con su canal y minutos", async () => {
    const s = new AbortAwareFakeSession([{ match: /handoffs_pendientes_por_escalar/, respond: () => [{ handoff_id: "h1", organization_id: ORG, property_id: PROP, conversation_id: "c1", canal: "voz", minutos: "22" }] }]);
    const r = await new PostgresAutopilotoRepository(s).handoffsPendientesPorEscalar(new Date(), 50);
    expect(r.disponible).toBe(true);
    expect(r.valor).toEqual([{ handoffId: "h1", organizationId: ORG, propertyId: PROP, conversationId: "c1", canal: "voz", minutos: 22 }]);
  });

  it("diaNegocio: base sin la 077 => null (el panel cae al dia calendario) y la sesion sigue viva; migrada => la fecha", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /dia_negocio_sucursal_actual/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(viejo).diaNegocio(ORG, PROP)).toBeNull();
    await sesionViva(viejo);
    const nuevo = new AbortAwareFakeSession([{ match: /dia_negocio_sucursal_actual/, respond: () => [{ dia: "2026-10-07" }] }]);
    expect(await new PostgresAutopilotoRepository(nuevo).diaNegocio(ORG, PROP)).toBe("2026-10-07");
  });

  it("diaNegocio: 42501 (sucursal ajena o sin alcance) => 403 tipado, sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /dia_negocio_sucursal_actual/, respond: () => pgError("42501", "sin acceso") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(s).diaNegocio(ORG, PROP)).rejects.toBeInstanceOf(AutopilotoAccesoError);
    await sesionViva(s);
  });

  it("registrarTicketImpreso: sin la 077 => no disponible; migrada => registrado; 42501 => 403", async () => {
    const viejo = new AbortAwareFakeSession([{ match: /pedido_ticket_impreso_registrar/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresAutopilotoRepository(viejo).registrarTicketImpreso(ORG, ORDER)).toEqual({ disponible: false, registrado: false });
    await sesionViva(viejo);
    const nuevo = new AbortAwareFakeSession([{ match: /pedido_ticket_impreso_registrar/, respond: () => [{ ok: true }] }]);
    expect(await new PostgresAutopilotoRepository(nuevo).registrarTicketImpreso(ORG, ORDER)).toEqual({ disponible: true, registrado: true });
    const ajeno = new AbortAwareFakeSession([{ match: /pedido_ticket_impreso_registrar/, respond: () => pgError("42501", "fuera de su sucursal") }, SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(ajeno).registrarTicketImpreso(ORG, ORDER)).rejects.toBeInstanceOf(AutopilotoAccesoError);
    await sesionViva(ajeno);
  });
});

describe("marcarAgotado contra la funcion vieja de la 050 (compara con la fecha calendario)", () => {
  /** Sesion que ademas registra los parametros de cada consulta, para comprobar la fecha del reintento. */
  class SesionConParametros extends AbortAwareFakeSession {
    readonly parametros: unknown[][] = [];
    override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      this.parametros.push(params ?? []);
      return super.query<T>(sql, params);
    }
  }
  const vieja = (): FakeSessionHandler => {
    let n = 0;
    return { match: /restaurantes\.agotado_marcar/, respond: () => (++n === 1 ? pgError("22023", "p_hasta debe ser posterior a hoy") : [{ ok: true }]) };
  };

  it("22023 con el dia de negocio igual a hoy en calendario: reintenta con calendario + 1 dentro del savepoint y la sesion sigue viva", async () => {
    // Domingo 00:30 con turno que cruza medianoche: dia de negocio = sabado, hasta = domingo; calendario + 1 = lunes.
    const s = new SesionConParametros([vieja(), SIGUIENTE]);
    const r = await new PostgresAutopilotoRepository(s).marcarAgotado(ORG, PROP, "p1", "2026-03-15", "2026-03-16");
    expect(r).toEqual({ disponible: true, aplicado: true });
    expect(s.parametros.map((p) => p[3])).toEqual(["2026-03-15", "2026-03-16"]);
    await sesionViva(s);
    expect(s.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(1);
  });

  it("sin fecha de respaldo mayor, el 22023 sigue siendo un error de validacion (no reintenta a ciegas)", async () => {
    const s = new SesionConParametros([vieja(), SIGUIENTE]);
    await expect(new PostgresAutopilotoRepository(s).marcarAgotado(ORG, PROP, "p1", "2026-03-15", "2026-03-15")).rejects.toBeInstanceOf(AutopilotoValidacionError);
    expect(s.parametros).toHaveLength(1);
    await sesionViva(s);
  });

  it("con la 076 aplicada (sin error) usa solo el dia de negocio", async () => {
    const s = new SesionConParametros([{ match: /restaurantes\.agotado_marcar/, respond: () => [{ ok: true }] }]);
    await new PostgresAutopilotoRepository(s).marcarAgotado(ORG, PROP, "p1", "2026-03-15", "2026-03-16");
    expect(s.parametros.map((p) => p[3])).toEqual(["2026-03-15"]);
  });
});
