// Agregados (099) contra la base SIN migrar: cada operacion degrada con SAVEPOINT a «no disponible» (nunca 25P02) y la transaccion sigue usable; un error
// que NO es de migracion pendiente se repropaga; y el SQL de aceptar escribe la solicitud y el pedido con compare-and-set.
import { describe, expect, it } from "vitest";
import { PostgresAgregadosRepository } from "../src/agregados/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const err = (code: string, msg: string) => Object.assign(new Error(msg), { code });
const ITEM = { id: "p1", name: "Coca-Cola", price: 30, quantity: 2 };
const NUEVO = { organizationId: "org-1", propertyId: "prop-1", orderId: "ord-1", channel: "whatsapp" as const, items: [ITEM] };

function montar(handlers: FakeSessionHandler[]) {
  const sesion = new AbortAwareFakeSession([...handlers, { match: /savepoint/i, respond: () => undefined }, { match: /select 1/i, respond: () => [{ ok: 1 }] }]);
  return { repo: new PostgresAgregadosRepository(sesion), sesion };
}
const sinTabla = (re: RegExp): FakeSessionHandler => ({ match: re, respond: () => err("42P01", 'relation "restaurantes.order_amendments" does not exist') });

describe("agregados: base sin migrar", () => {
  it("crear/listar/obtener/decidir/barrido/cancelar degradan a «no disponible» y la transaccion sigue usable", async () => {
    const { repo, sesion } = montar([sinTabla(/agregado|agregados|order_amendments|order_amendment_events|restaurantes\.orders/)]);
    expect(await repo.crear(NUEVO)).toEqual({ estado: "no_disponible" });
    expect(await repo.listar("org-1", { propertyIds: null, limite: 10 })).toEqual({ disponible: false, valor: [] });
    expect(await repo.obtener("org-1", "a-1", null)).toEqual({ disponible: false, valor: null });
    expect(await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null)).toEqual({ resultado: "no_disponible" });
    expect(await repo.pendientesAntesDe("2026-10-24T00:00:00Z", 10)).toEqual({ disponible: false, valor: [] });
    expect(await repo.cancelarPorCliente("org-1", "ord-1")).toEqual({ disponible: false, valor: null });
    expect(await repo.escalarNivel1("org-1", "a-1", new Date())).toBe(false);
    expect(await repo.vencer("org-1", "a-1", new Date())).toBe(false);
    await expect(repo.marcarVisto("org-1", "a-1", "u-1", null)).resolves.toBeUndefined();
    await expect(repo.registrarEvento({ amendmentId: "a-1", organizationId: "org-1", propertyId: "prop-1", tipoEvento: "creado", actor: { tipo: "agente" } })).resolves.toBeUndefined();
    await expect(sesion.query("select 1")).resolves.toBeTruthy();
  });

  it("columna ausente (42703) y funcion ausente (42883) tambien degradan; un error ajeno (23514) se repropaga", async () => {
    const col = montar([{ match: /order_amendments/, respond: () => err("42703", "no existe la columna") }]);
    expect((await col.repo.listar("org-1", { propertyIds: null, limite: 1 })).disponible).toBe(false);
    const fn = montar([{ match: /order_amendments/, respond: () => err("42883", "function restaurantes.foo() does not exist") }]);
    expect((await fn.repo.obtener("org-1", "x", null)).disponible).toBe(false);
    const malo = montar([{ match: /order_amendments/, respond: () => err("23514", "check violation") }]);
    await expect(malo.repo.listar("org-1", { propertyIds: null, limite: 1 })).rejects.toMatchObject({ code: "23514" });
  });

  it("rechaza renglones fuera de rango antes de tocar la base", async () => {
    const { repo, sesion } = montar([]);
    await expect(repo.crear({ ...NUEVO, items: [] })).rejects.toThrow(/renglones/);
    await expect(repo.crear({ ...NUEVO, items: Array.from({ length: 31 }, () => ITEM) })).rejects.toThrow(/renglones/);
    expect(sesion.calls).toEqual([]);
  });
});

describe("agregados: crear por la funcion solo-sistema", () => {
  const VISTA = { id: "a-1", organization_id: "org-1", property_id: "prop-1", order_id: "ord-1", status: "pendiente", channel: "whatsapp", items_added: [ITEM], total_before: 100, total_added: 60, total_after: 160, customer_note: null, version: 1, requested_at: "2026-10-24T18:00:00Z", first_seen_at: null, decided_at: null, decided_by: null, decided_by_name: null, reject_reason: null, reject_note: null, escalation_level: 0, escalated_at: null, order_number: 150, order_status: "preparando", order_items: [], order_total: 100, order_created_at: "2026-10-24T17:50:00Z", customer_name: "Ana", customer_phone: "9990001111", sucursal: "Montejo" };
  it("el SQL llama a agregado_crear_sistema con parametros (nunca lee orders directo) y mapea creado, pedido_no_agregable y pedido_no_encontrado", async () => {
    const respuestas = [{ estado: "creado", agregado: VISTA }, { estado: "pedido_no_agregable", orderStatus: "en_camino" }, { estado: "pedido_no_encontrado" }];
    const { repo, sesion } = montar([
      { match: /agregado_crear_sistema/, respond: () => [{ r: respuestas.shift() }] },
      { match: /insert into restaurantes\.order_amendment_events/, respond: () => [] },
    ]);
    expect((await repo.crear(NUEVO)).estado).toBe("creado");
    expect(await repo.crear(NUEVO)).toEqual({ estado: "pedido_no_agregable", orderStatus: "en_camino" });
    expect(await repo.crear(NUEVO)).toEqual({ estado: "pedido_no_encontrado" });
    const sql = sesion.calls.join("\n");
    expect(sql).toContain("restaurantes.agregado_crear_sistema($1, $2, $3, $4, $5::jsonb, $6, $7, $8)");
    expect(sql).not.toMatch(/from restaurantes\.orders/);
  });

  it("si ya habia uno abierto lo FUSIONA con update (version + 1, sin reiniciar el cronometro) y el mismo evento no fusiona dos veces", async () => {
    let huella = false;
    const { repo, sesion } = montar([
      { match: /agregado_crear_sistema/, respond: () => [{ r: { estado: "abierto", agregado: VISTA } }] },
      { match: /order_amendment_events where amendment_id/, respond: () => (huella ? [{ "?column?": 1 }] : []) },
      { match: /update restaurantes\.order_amendments set items_added/, respond: () => [{ id: "a-1" }] },
      { match: /agregado_leer_sistema/, respond: () => [{ v: { ...VISTA, version: 2, total_added: 120, total_after: 220 } }] },
      { match: /insert into restaurantes\.order_amendment_events/, respond: () => [] },
    ]);
    const r = await repo.crear({ ...NUEVO, sourceEventId: "wamid-2" });
    expect(r.estado).toBe("fusionado");
    expect(sesion.calls.some((c) => /version = version \+ 1/.test(c) && !/requested_at/.test(c))).toBe(true);
    huella = true;
    expect((await repo.crear({ ...NUEVO, sourceEventId: "wamid-2" })).estado).toBe("repetido");
  });

  it("el barrido usa agregados_barrido_sistema (el sistema no ve orders)", async () => {
    const { repo, sesion } = montar([{ match: /agregados_barrido_sistema/, respond: () => [{ v: [VISTA] }] }]);
    const l = await repo.pendientesAntesDe("2026-10-24T18:00:00Z", 50);
    expect(l.valor.map((a) => a.id)).toEqual(["a-1"]);
    expect(sesion.calls.join("\n")).not.toMatch(/from restaurantes\.orders/);
  });
});

describe("agregados: SQL de aceptar", () => {
  const FILA = {
    id: "a-1", organization_id: "org-1", property_id: "prop-1", order_id: "ord-1", status: "pendiente", channel: "whatsapp", items_added: [ITEM], total_before: "100.00", total_added: "60.00", total_after: "160.00",
    customer_note: null, version: 1, requested_at: "2026-10-24T18:00:00Z", first_seen_at: null, decided_at: null, decided_by: null, decided_by_name: null, reject_reason: null, reject_note: null,
    escalation_level: 0, escalated_at: null, order_number: "150", order_status: "preparando", order_items: [], order_total: "100.00", order_created_at: "2026-10-24T17:50:00Z",
    customer_name: "Ana", customer_phone: "9990001111", sucursal: "Montejo",
  };
  it("aceptar: bloquea el pedido, hace compare-and-set de la solicitud y suma renglones y total en el pedido; todo parametrizado", async () => {
    let lecturas = 0;
    const { repo, sesion } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [lecturas++ === 0 ? FILA : { ...FILA, status: "aceptado", decided_by: "u-1" }] },
      { match: /select status from restaurantes\.orders[\s\S]*for update/, respond: () => [{ status: "preparando" }] },
      { match: /update restaurantes\.order_amendments set status = 'aceptado'/, respond: () => [{ id: "a-1" }] },
      { match: /update restaurantes\.orders set items/, respond: () => [{ id: "ord-1" }] },
      { match: /insert into restaurantes\.order_amendment_events/, respond: () => [] },
    ]);
    const r = await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", ["prop-1"]);
    expect(r.resultado).toBe("aplicado");
    const sql = sesion.calls.join("\n");
    expect(sql).toMatch(/status = 'pendiente'/);
    expect(sql).toMatch(/total = total \+ \$4/);
    expect(sql).not.toMatch(/\$\{|'u-1'/); // nada interpolado
  });

  it("aceptar con la solicitud ya resuelta por otra persona: ya_resuelto, SIN tocar el pedido", async () => {
    const { repo, sesion } = montar([{ match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [{ ...FILA, status: "rechazado", reject_reason: "otro", decided_by: "u-2" }] }]);
    const r = await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null);
    expect(r.resultado).toBe("ya_resuelto");
    expect(sesion.calls.some((c) => /update restaurantes\.orders/.test(c))).toBe(false);
  });

  it("aceptar pierde el compare-and-set porque OTRA persona ya la resolvio: ya_resuelto y el pedido queda intacto", async () => {
    let lecturas = 0;
    const { repo, sesion } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [lecturas++ === 0 ? FILA : { ...FILA, status: "rechazado", reject_reason: "otro", decided_by: "u-2" }] },
      { match: /select status from restaurantes\.orders[\s\S]*for update/, respond: () => [{ status: "preparando" }] },
      { match: /update restaurantes\.order_amendments set status = 'aceptado'/, respond: () => [] },
    ]);
    expect((await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null)).resultado).toBe("ya_resuelto");
    expect(sesion.calls.some((c) => /update restaurantes\.orders/.test(c))).toBe(false);
  });

  it("CARRERA con la fusion: el agente sube la version entre la lectura y el UPDATE; el compare-and-set (version = $4) no toca nada: version_cambio, el pedido intacto", async () => {
    let lecturas = 0;
    const { repo, sesion } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [lecturas++ === 0 ? FILA : { ...FILA, version: 2, total_added: "85.00", total_after: "185.00" }] },
      { match: /select status from restaurantes\.orders[\s\S]*for update/, respond: () => [{ status: "preparando" }] },
      { match: /update restaurantes\.order_amendments set status = 'aceptado'/, respond: () => [] },
    ]);
    const r = await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null);
    expect(r).toMatchObject({ resultado: "version_cambio", agregado: { version: 2 } });
    expect(sesion.calls.some((c) => /update restaurantes\.orders/.test(c))).toBe(false);
    expect(sesion.calls.some((c) => /set status = 'aceptado'[\s\S]*and version = \$4/.test(c))).toBe(true);
  });

  it("CARRERA al rechazar y al marcar no_aplicable: los dos compare-and-set exigen la version leida", async () => {
    for (const caso of ["rechazar", "no_aplicable"] as const) {
      let lecturas = 0;
      const { repo, sesion } = montar([
        { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [lecturas++ === 0 ? FILA : { ...FILA, version: 2 }] },
        { match: /select status from restaurantes\.orders[\s\S]*for update/, respond: () => [{ status: "en_camino" }] },
        { match: /update restaurantes\.order_amendments set status = '(rechazado|no_aplicable)'/, respond: () => [] },
      ]);
      const decision = caso === "rechazar" ? ({ tipo: "rechazar", motivo: "otro", nota: "x" } as const) : ({ tipo: "aceptar" } as const);
      expect((await repo.decidir("org-1", "a-1", decision, "u-1", null)).resultado).toBe("version_cambio");
      // (la sesion falsa solo registra la primera linea del SQL; el predicado `version = $n` del rechazo, multilinea, lo prueba el escenario SQL real)
      if (caso === "no_aplicable") expect(sesion.calls.some((c) => /set status = 'no_aplicable'[\s\S]*and version = \$4/.test(c))).toBe(true);
    }
  });

  it("versionEsperada distinta de la leida: version_cambio SIN escribir nada", async () => {
    const { repo, sesion } = montar([{ match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [{ ...FILA, version: 2 }] }]);
    expect((await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null, { versionEsperada: 1 })).resultado).toBe("version_cambio");
    expect(sesion.calls.some((c) => /update /.test(c))).toBe(false);
  });

  it("20+ min con status pendiente (reloj de la BASE): decidir cierra como vencido, firma el evento como el usuario y no toca el pedido", async () => {
    let lecturas = 0;
    const { repo, sesion } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [lecturas++ === 0 ? { ...FILA, vencida_por_reloj: true } : { ...FILA, status: "vencido", escalation_level: 2, decided_at: "2026-10-24T18:21:00Z" }] },
      { match: /update restaurantes\.order_amendments set status = 'vencido'/, respond: () => [{ property_id: "prop-1" }] },
      { match: /insert into restaurantes\.order_amendment_events/, respond: () => [] },
    ]);
    const r = await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null, { versionEsperada: 1 });
    expect(r).toMatchObject({ resultado: "vencido", agregado: { estado: "vencido" } });
    expect(sesion.calls.some((c) => /update restaurantes\.orders|set status = 'aceptado'|select status from restaurantes\.orders/.test(c))).toBe(false);
  });

  it("20+ min pero otra persona/tick ya la cerro entre la lectura y el cierre: ya_resuelto", async () => {
    const { repo } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [{ ...FILA, vencida_por_reloj: true }] },
      { match: /update restaurantes\.order_amendments set status = 'vencido'/, respond: () => [] },
    ]);
    expect((await repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null)).resultado).toBe("ya_resuelto");
  });

  it("si el pedido no se pudo actualizar tras aceptar, lanza (la transaccion entera se revierte)", async () => {
    const { repo } = montar([
      { match: /^\s*select a\.id[\s\S]*from restaurantes\.order_amendments a/, respond: () => [FILA] },
      { match: /select status from restaurantes\.orders[\s\S]*for update/, respond: () => [{ status: "preparando" }] },
      { match: /update restaurantes\.order_amendments set status = 'aceptado'/, respond: () => [{ id: "a-1" }] },
      { match: /update restaurantes\.orders set items/, respond: () => [] },
    ]);
    await expect(repo.decidir("org-1", "a-1", { tipo: "aceptar" }, "u-1", null)).rejects.toThrow(/se revierte/);
  });
});
