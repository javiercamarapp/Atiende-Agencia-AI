// Rn-P3-09 -- accesos omitidos por falta de correo: aviso in-app una sola vez por reserva (sin PII), la reserva vuelve a ser candidata cuando
// ya tiene contacto, la entrega manual la saca de la liberacion automatica, el mensaje para la OTA y la degradacion contra una base sin migrar.
import { describe, expect, it } from "vitest";
import { InMemoryRentasAccesoRepository, PostgresRentasAccesoRepository, ejecutarLiberacionAcceso, mensajeAccesoParaOta, type LiberacionPendiente, type WithLiberacionTx } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const CORREO = "huesped.privado@example.com";
const OC = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PROP = "33333333-3333-4333-8333-333333333333";

function pendiente(extra: Partial<LiberacionPendiente> = {}): LiberacionPendiente {
  return {
    ocupacionId: OC,
    organizationId: ORG,
    propertyId: PROP,
    checkIn: "2027-03-10",
    checkOut: "2027-03-12",
    unidadNombre: "Casa Mar",
    tenantNombre: "Gestora Demo",
    huespedNombre: "Ana",
    huespedContacto: null,
    tieneInstrucciones: true,
    direccionExacta: "Calle 60 #123",
    codigoAcceso: "9137",
    instrucciones: null,
    ...extra,
  };
}

function montar() {
  const acceso = new InMemoryRentasAccesoRepository();
  const encolados: string[] = [];
  const rentas = {
    async enqueueMessagingOutbox(_p: string, _o: string, _c: "whatsapp" | "email", _e: string, dedupeKey: string): Promise<void> {
      encolados.push(dedupeKey);
    },
  };
  const withTx: WithLiberacionTx = (fn) => fn({ acceso, rentas });
  return { acceso, encolados, withTx };
}

describe("aviso de acceso omitido por falta de correo (liberacion horaria)", () => {
  it("la primera omision emite UN aviso con la organizacion y la reserva; las corridas siguientes de las proximas horas no emiten otro", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente());
    expect(await ejecutarLiberacionAcceso(m.withTx)).toMatchObject({ omitidasSinContacto: 1, liberadas: 0 });
    expect(m.acceso.avisosOmitidaSinContacto).toEqual([{ ocupacionId: OC, organizationId: ORG, propertyId: PROP }]);
    // Corridas cada hora: la bitacora ya tiene el evento (tope de 24 h) -> no se vuelve a avisar.
    for (let i = 0; i < 5; i++) await ejecutarLiberacionAcceso(m.withTx);
    expect(m.acceso.avisosOmitidaSinContacto).toHaveLength(1);
    expect(m.acceso.bitacora.filter((b) => b.evento === "omitida_sin_contacto")).toHaveLength(1);
  });

  it("una reserva con contacto NO genera aviso y se entrega; una omitida por falta de instrucciones tampoco avisa de falta de correo", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente({ ocupacionId: "c1", huespedContacto: CORREO }), pendiente({ ocupacionId: "c2", tieneInstrucciones: false, direccionExacta: null }));
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ liberadas: 1, omitidasSinInstrucciones: 1, omitidasSinContacto: 0 });
    expect(m.acceso.avisosOmitidaSinContacto).toHaveLength(0);
  });

  it("la reserva omitida vuelve a ser candidata cuando ya tiene contacto (lo que captura el pre-check-in) y se entrega por correo sin intervencion", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente());
    await ejecutarLiberacionAcceso(m.withTx);
    expect(m.encolados).toHaveLength(0);
    // El pre-check-in captura el correo: la misma reserva, ahora con contacto, es candidata en la siguiente corrida.
    m.acceso.pendientes[0] = pendiente({ huespedContacto: CORREO });
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ liberadas: 1, omitidasSinContacto: 0 });
    expect(m.encolados).toEqual([`acceso:${OC}`]);
  });

  it("una reserva marcada como entregada a mano ya no la toma la corrida automatica ni aparece como pendiente", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente());
    m.acceso.reservasConocidas.add(OC);
    m.acceso.reservasProximas.push({ ocupacionId: OC, unidadId: "u1", unidadNombre: "Casa Mar", canal: "airbnb", checkIn: "2027-03-10", checkOut: "2027-03-12", huespedNombre: "Ana" });
    await ejecutarLiberacionAcceso(m.withTx);
    const antes = await m.acceso.listarPendientesEntrega(PROP, 10);
    expect(antes.disponible && antes.valor.map((p) => p.ocupacionId)).toEqual([OC]);

    expect(await m.acceso.marcarEntregadaManual(OC, PROP)).toBe("entregada");
    expect(await m.acceso.marcarEntregadaManual(OC, PROP)).toBe("ya_entregada");
    const despues = await m.acceso.listarPendientesEntrega(PROP, 10);
    expect(despues.disponible && despues.valor).toEqual([]);
    expect(m.acceso.bitacora.filter((b) => b.evento === "entregada_manual")).toHaveLength(1);
    expect(await ejecutarLiberacionAcceso(m.withTx)).toMatchObject({ liberadas: 0, omitidasSinContacto: 0 });
    expect(m.encolados).toHaveLength(0);
  });

  it("marcarEntregadaManual de una reserva desconocida es no_encontrada", async () => {
    expect(await new InMemoryRentasAccesoRepository().marcarEntregadaManual(OC, PROP)).toBe("no_encontrada");
  });

  it("marcarEntregadaManual desde la property equivocada es no_encontrada y no registra nada", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente());
    m.acceso.reservasConocidas.add(OC);
    expect(await m.acceso.marcarEntregadaManual(OC, "otra-property")).toBe("no_encontrada");
    expect(m.acceso.bitacora.filter((b) => b.evento === "entregada_manual")).toHaveLength(0);
  });
});

describe("mensajeAccesoParaOta", () => {
  it("arma el texto con nombre, estancia, direccion, codigo e indicaciones", () => {
    const t = mensajeAccesoParaOta({ unidadNombre: "Casa Mar", checkIn: "2027-03-10", checkOut: "2027-03-12", huespedNombre: " Ana " }, { direccionExacta: "Calle 60 #123", codigoAcceso: "9137", instrucciones: "Caja junto a la puerta" });
    expect(t).toContain("Hola Ana,");
    expect(t).toContain("Casa Mar");
    expect(t).toContain("10 de marzo de 2027");
    expect(t).toContain("12 de marzo de 2027");
    expect(t).toContain("Direccion: Calle 60 #123");
    expect(t).toContain("Codigo de acceso: 9137");
    expect(t).toContain("Caja junto a la puerta");
  });

  it("sin nombre, codigo ni indicaciones omite esas lineas", () => {
    const t = mensajeAccesoParaOta({ unidadNombre: "Casa Mar", checkIn: "2027-03-10", checkOut: "2027-03-12", huespedNombre: null }, { direccionExacta: "Calle 60", codigoAcceso: null, instrucciones: null });
    expect(t.startsWith("Hola,")).toBe(true);
    expect(t).not.toContain("Codigo de acceso");
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresRentasAccesoRepository -- Rn-P3-09", () => {
  it("avisarOmitidaSinContacto emite core.emit_notification con el evento del catalogo, clave = id de la reserva, sin PII ni parametros", async () => {
    const llamadas: unknown[][] = [];
    const db = {
      async query(sql: string, params?: unknown[]) {
        if (/core\.emit_notification/.test(sql)) {
          llamadas.push(params ?? []);
          return { rows: [{ emit_notification: 2 }] };
        }
        return { rows: [] };
      },
      async exec() {},
    };
    const repo = new PostgresRentasAccesoRepository(db as never);
    expect(await repo.avisarOmitidaSinContacto(OC, ORG, PROP)).toBe(true);
    expect(llamadas).toHaveLength(1);
    const p = llamadas[0]!;
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe(PROP);
    expect(p[2]).toBe("rentas.acceso.omitido_sin_contacto");
    expect(p[10]).toBe(`rentas.acceso.omitido_sin_contacto:${OC}`);
    expect(p[11]).toEqual(["admin_gestora", "operador:acceso_total"]);
    const texto = JSON.stringify(p);
    expect(texto).not.toMatch(/@|Ana|Calle|9137/);
  });

  it("avisarOmitidaSinContacto contra una base sin core.emit_notification (42883) devuelve false sin abortar la transaccion de la reserva", async () => {
    const db = new AbortAwareFakeSession([
      { match: /core\.emit_notification/, respond: () => pgError("42883", "function core.emit_notification(uuid, uuid, text) does not exist") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresRentasAccesoRepository(db);
    expect(await repo.avisarOmitidaSinContacto(OC, ORG, PROP)).toBe(false);
    await expect(db.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
  });

  it("marcarEntregadaManual: true -> entregada, false -> ya_entregada, P0002 -> no_encontrada, 42883 -> no_disponible; la sesion sigue utilizable", async () => {
    const mk = (respond: () => unknown, propia = true) => new AbortAwareFakeSession([{ match: /from rentas\.ocupacion where id/, respond: () => (propia ? [{ "?column?": 1 }] : []) }, { match: /acceso_marcar_entregada_manual/, respond }, { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] }]);
    expect(await new PostgresRentasAccesoRepository(mk(() => [{ nueva: true }])).marcarEntregadaManual(OC, PROP)).toBe("entregada");
    expect(await new PostgresRentasAccesoRepository(mk(() => [{ nueva: false }])).marcarEntregadaManual(OC, PROP)).toBe("ya_entregada");
    const noExiste = mk(() => pgError("P0002", "reserva no encontrada"));
    expect(await new PostgresRentasAccesoRepository(noExiste).marcarEntregadaManual(OC, PROP)).toBe("no_encontrada");
    await expect(noExiste.query("select 1 as vivo")).resolves.toBeDefined();
    // Reserva de otra property (no es la de la ruta): no_encontrada sin llamar a la funcion que escribe.
    expect(await new PostgresRentasAccesoRepository(mk(() => [{ nueva: true }], false)).marcarEntregadaManual(OC, "otra-property")).toBe("no_encontrada");
    const sinMigrar = mk(() => pgError("42883", "function rentas.acceso_marcar_entregada_manual(uuid) does not exist"));
    expect(await new PostgresRentasAccesoRepository(sinMigrar).marcarEntregadaManual(OC, PROP)).toBe("no_disponible");
  });

  it("listarPendientesEntrega y obtenerReservaParaMensaje degradan contra una base sin migrar y mapean las filas", async () => {
    const sinMigrar = new AbortAwareFakeSession([{ match: /from rentas\.ocupacion/, respond: () => pgError("42P01", "relation does not exist") }]);
    const repoViejo = new PostgresRentasAccesoRepository(sinMigrar);
    expect(await repoViejo.listarPendientesEntrega(PROP, 10)).toEqual({ disponible: false });
    expect(await repoViejo.obtenerReservaParaMensaje(PROP, OC)).toEqual({ disponible: false });

    const ok = new AbortAwareFakeSession([
      { match: /acceso_bitacora b where b\.ocupacion_id = o\.id and b\.evento = 'omitida_sin_contacto'\)::text/, respond: () => [{ id: OC, unidad_id: "u1", unidad_nombre: "Casa Mar", canal: "airbnb", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: null, omitida_en: "2027-03-09 10:10:00+00" }] },
      { match: /to_char\(lower\(o\.rango\)/, respond: () => [{ id: OC, unidad_id: "u1", unidad_nombre: "Casa Mar", check_in: "2027-03-10", check_out: "2027-03-12", huesped_nombre: "Ana" }] },
    ]);
    const repo = new PostgresRentasAccesoRepository(ok);
    const lista = await repo.listarPendientesEntrega(PROP, 10);
    expect(lista).toEqual({ disponible: true, valor: [{ ocupacionId: OC, unidadId: "u1", unidadNombre: "Casa Mar", canal: "airbnb", checkIn: "2027-03-10", checkOut: "2027-03-12", huespedNombre: null, omitidaEn: "2027-03-09 10:10:00+00" }] });
  });
});
