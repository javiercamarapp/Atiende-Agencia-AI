// REGLA DURA de compatibilidad con la base SIN migrar (migracion 023, modelo PM): mergear
// despliega el codigo al instante y la migracion NO se aplica sola. Todo lo que el repositorio
// lee/escribe de las tablas/columnas nuevas corre DENTRO de la transaccion unica de un request
// (cotizar/crear pedido, turno de WhatsApp): un error 42P01/42703 dejaria la transaccion
// abortada (25P02) y el COMMIT seria un ROLLBACK silencioso. `AbortAwareFakeSession`
// reproduce ese estado; cada caso verifica (1) el camino anterior / vacio honesto y (2) que
// la MISMA sesion sigue utilizable despues (la siguiente query del request resuelve).
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { WhatsappNumberInUseError } from "../src/errors.ts";
import { EMPTY_BRANCH_POLICY } from "../src/types.ts";
import { quoteOrder } from "../src/orders.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinTabla = (tabla: string) => pgError("42P01", `relation "restaurantes.${tabla}" does not exist`);
const sinColumna = (columna: string) => pgError("42703", `column "${columna}" does not exist`);

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("politica por sucursal (branch_policy)", () => {
  it("lee horario, minimos y propina; el horario persistido corrupto se trata como 'sin horario'", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from restaurantes\.branch_policy where property_id/i,
        respond: () => [{ horario: [{ dias: [1], abre: "12:00", cierra: "01:00" }], pedido_minimo_domicilio: "200.00", pedido_minimo_recoger: null, propina_politica: "solo_tarjeta" }],
      },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.findBranchPolicy(PROPERTY_ID)).toEqual({
      horario: [{ dias: [1], abre: "12:00", cierra: "01:00" }],
      pedidoMinimoDomicilio: 200,
      pedidoMinimoRecoger: null,
      propinaPolitica: "solo_tarjeta",
      // Migracion 057: sin esas columnas en la fila, valores por omision (comportamiento anterior).
      visibleEnDirectorio: null,
      aceptaDomicilio: true,
      diasDomicilio: null,
      deTemporada: false,
    });

    const corrupto = new AbortAwareFakeSession([
      { match: /from restaurantes\.branch_policy where property_id/i, respond: () => [{ horario: "basura", pedido_minimo_domicilio: null, pedido_minimo_recoger: null, propina_politica: "otra" }] },
    ]);
    expect(await new PostgresRestaurantesRepository(corrupto).findBranchPolicy(PROPERTY_ID)).toEqual(EMPTY_BRANCH_POLICY);
  });

  it("sin fila: politica vacia (no bloquea nada)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_policy where property_id/i, respond: () => [] }]);
    expect(await new PostgresRestaurantesRepository(session).findBranchPolicy(PROPERTY_ID)).toEqual(EMPTY_BRANCH_POLICY);
  });

  it("base SIN migrar (42P01): lectura degrada a politica vacia y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_policy where property_id/i, respond: () => sinTabla("branch_policy") }, SIGUIENTE]);
    expect(await new PostgresRepo(session).findBranchPolicy(PROPERTY_ID)).toEqual(EMPTY_BRANCH_POLICY);
    await sesionSigueViva(session);
  });

  it("base SIN migrar: la escritura lanza RestaurantesConfigUnavailableError (503 honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into restaurantes\.branch_policy/i, respond: () => sinTabla("branch_policy") }, SIGUIENTE]);
    await expect(new PostgresRepo(session).upsertBranchPolicy(ORG_ID, PROPERTY_ID, EMPTY_BRANCH_POLICY)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("escribe horario como jsonb y devuelve lo persistido", async () => {
    let params: unknown[] | undefined;
    const session = new AbortAwareFakeSession([
      {
        match: /insert into restaurantes\.branch_policy/i,
        respond: () => [{ horario: [{ dias: [1], abre: "12:00", cierra: "01:00" }], pedido_minimo_domicilio: "200", pedido_minimo_recoger: null, propina_politica: "solo_tarjeta" }],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p;
      return original(sql, p);
    }) as typeof session.query;
    const result = await new PostgresRepo(session).upsertBranchPolicy(ORG_ID, PROPERTY_ID, {
      horario: [{ dias: [1], abre: "12:00", cierra: "01:00" }],
      pedidoMinimoDomicilio: 200,
      pedidoMinimoRecoger: null,
      propinaPolitica: "solo_tarjeta",
    });
    expect(result.pedidoMinimoDomicilio).toBe(200);
    expect(params?.[2]).toBe(JSON.stringify([{ dias: [1], abre: "12:00", cierra: "01:00" }]));
  });

  it("un error real de Postgres (no de compatibilidad) se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_policy where property_id/i, respond: () => pgError("57P01", "connection terminated") }]);
    await expect(new PostgresRepo(session).findBranchPolicy(PROPERTY_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("cobertura de entrega (branch_delivery_zone)", () => {
  it("base SIN migrar: lista vacia (sin restriccion) y sesion viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_delivery_zone/i, respond: () => sinTabla("branch_delivery_zone") }, SIGUIENTE]);
    expect(await new PostgresRepo(session).listBranchDeliveryZoneIds(PROPERTY_ID)).toEqual([]);
    await sesionSigueViva(session);
  });

  it("base SIN migrar: reemplazar cobertura lanza Unavailable", async () => {
    const session = new AbortAwareFakeSession([{ match: /delete from restaurantes\.branch_delivery_zone/i, respond: () => sinTabla("branch_delivery_zone") }, SIGUIENTE]);
    await expect(new PostgresRepo(session).replaceBranchDeliveryZones(ORG_ID, PROPERTY_ID, ["z1"])).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("reemplazar borra y reinserta sin duplicados", async () => {
    const session = new AbortAwareFakeSession([
      { match: /delete from restaurantes\.branch_delivery_zone/i, respond: () => [] },
      { match: /insert into restaurantes\.branch_delivery_zone/i, respond: () => [] },
    ]);
    expect(await new PostgresRepo(session).replaceBranchDeliveryZones(ORG_ID, PROPERTY_ID, ["z1", "z1", "z2"])).toEqual(["z1", "z2"]);
    expect(session.calls.filter((c) => c.startsWith("insert into restaurantes.branch_delivery_zone"))).toHaveLength(2);
  });
});

describe("catalogo con no_domicilio", () => {
  const PRODUCT_ROW = { id: "p1", name: "Sol", description: null, category_name: "Cervezas", search_keywords: [], price: "66", is_available: true };

  it("base migrada: marca noDomicilio del producto o de su categoria", async () => {
    const session = new AbortAwareFakeSession([{ match: /no_domicilio/i, respond: () => [{ ...PRODUCT_ROW, no_domicilio: true }] }]);
    const [producto] = await new PostgresRepo(session).listAvailableProductsForBranch(PROPERTY_ID);
    expect(producto!.noDomicilio).toBe(true);
  });

  it("base SIN migrar (42703): cae al SELECT anterior con SAVEPOINT; el producto queda sin restriccion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /no_domicilio/i, respond: () => sinColumna("no_domicilio") },
      { match: /from restaurantes\.branch_products bp/i, respond: () => [PRODUCT_ROW] },
    ]);
    const productos = await new PostgresRepo(session).listAvailableProductsForBranch(PROPERTY_ID);
    expect(productos).toHaveLength(1);
    expect(productos[0]!.noDomicilio).toBe(false);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("base SIN migrar: quoteOrder sigue cotizando en la MISMA transaccion (nunca 25P02)", async () => {
    const branchRow = { property_id: PROPERTY_ID, organization_id: ORG_ID, name: "Sucursal", slug: "suc", status: "active", phone: null, address: null, lat: null, lng: null };
    const session = new AbortAwareFakeSession([
      { match: /no_domicilio/i, respond: () => sinColumna("no_domicilio") },
      { match: /from restaurantes\.branch_products bp/i, respond: () => [{ ...PRODUCT_ROW, id: "00000000-0000-4000-8000-0000000000c1", name: "Coca-Cola", category_name: "Bebidas", price: "45" }] },
      { match: /from restaurantes\.branch_policy where property_id/i, respond: () => sinTabla("branch_policy") },
      { match: /from restaurantes\.branch_delivery_zone/i, respond: () => sinTabla("branch_delivery_zone") },
      // Migracion 031 (puentes y promociones automaticas): tampoco existen en la base sin migrar.
      { match: /from restaurantes\.branch_hours_exception/i, respond: () => sinTabla("branch_hours_exception") },
      { match: /auto_apply/i, respond: () => sinColumna("auto_apply") },
      { match: /from restaurantes\.branch_detail|core\.property|join core\.property/i, respond: () => [branchRow] },
    ]);
    const quote = await quoteOrder(new PostgresRepo(session), {
      organizationId: ORG_ID,
      branchSlug: "suc",
      items: [{ productId: "00000000-0000-4000-8000-0000000000c1", requestedQuantity: 2 }],
    });
    expect(quote.total).toBe(90);
    expect(quote.pedidoMinimo).toBeNull();
    expect(quote.abiertoAhora).toBeNull();
    // Sin la migracion 031: ninguna promocion automatica, sin descuento, y el total no cambia.
    expect(quote.promocionAplicada).toBeNull();
    expect(quote.promocionesSugeridas).toEqual([]);
    expect(quote.descuento).toBe(0);
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(5);
  });

  it("marcas no_domicilio: lectura degrada a vacio y escritura lanza Unavailable", async () => {
    const lectura = new AbortAwareFakeSession([{ match: /no_domicilio/i, respond: () => sinColumna("no_domicilio") }, SIGUIENTE]);
    expect(await new PostgresRepo(lectura).listNoDomicilioMarks(ORG_ID)).toEqual({ productIds: [], categoryIds: [] });
    await sesionSigueViva(lectura);

    const escritura = new AbortAwareFakeSession([{ match: /update restaurantes\.categories set no_domicilio/i, respond: () => sinColumna("no_domicilio") }, SIGUIENTE]);
    await expect(new PostgresRepo(escritura).setCategoryNoDomicilio(ORG_ID, "c1", true)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(escritura);
  });
});

describe("WhatsApp por sucursal (whatsapp_branch_channel)", () => {
  it("el numero de una sucursal resuelve organizacion Y sucursal", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_branch_channel where phone_number_id/i, respond: () => [{ organization_id: ORG_ID, property_id: PROPERTY_ID }] }]);
    expect(await new PostgresRepo(session).resolveWhatsAppChannel("pn-1")).toEqual({ organizationId: ORG_ID, propertyId: PROPERTY_ID });
  });

  it("numero sin sucursal: cae al numero por defecto de la organizacion (propertyId null)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.whatsapp_branch_channel where phone_number_id/i, respond: () => [] },
      { match: /from restaurantes\.whatsapp_channel_config where phone_number_id/i, respond: () => [{ organization_id: ORG_ID }] },
    ]);
    expect(await new PostgresRepo(session).resolveWhatsAppChannel("pn-org")).toEqual({ organizationId: ORG_ID, propertyId: null });
  });

  it("numero desconocido: null (ack silencioso en la ruta)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.whatsapp_branch_channel where phone_number_id/i, respond: () => [] },
      { match: /from restaurantes\.whatsapp_channel_config where phone_number_id/i, respond: () => [] },
    ]);
    expect(await new PostgresRepo(session).resolveWhatsAppChannel("pn-x")).toBeNull();
  });

  it("base SIN migrar (42P01): el webhook sigue resolviendo por el numero de la organizacion, en la MISMA transaccion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.whatsapp_branch_channel where phone_number_id/i, respond: () => sinTabla("whatsapp_branch_channel") },
      { match: /from restaurantes\.whatsapp_channel_config where phone_number_id/i, respond: () => [{ organization_id: ORG_ID }] },
    ]);
    expect(await new PostgresRepo(session).resolveWhatsAppChannel("pn-org")).toEqual({ organizationId: ORG_ID, propertyId: null });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("listar numeros por sucursal degrada a vacio sin migrar", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_branch_channel where organization_id/i, respond: () => sinTabla("whatsapp_branch_channel") }, SIGUIENTE]);
    expect(await new PostgresRepo(session).listWhatsappBranchChannels(ORG_ID)).toEqual([]);
    await sesionSigueViva(session);
  });

  it("conectar numero: sin migrar -> Unavailable; numero ya en uso (23505) -> WhatsappNumberInUseError; ambos dejan la sesion viva", async () => {
    const sinMigrar = new AbortAwareFakeSession([{ match: /insert into restaurantes\.whatsapp_branch_channel/i, respond: () => sinTabla("whatsapp_branch_channel") }, SIGUIENTE]);
    await expect(new PostgresRepo(sinMigrar).upsertWhatsappBranchChannel(ORG_ID, PROPERTY_ID, "pn-1")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(sinMigrar);

    const enUso = new AbortAwareFakeSession([{ match: /insert into restaurantes\.whatsapp_branch_channel/i, respond: () => pgError("23505", "restaurantes_whatsapp_phone_number_id_en_uso") }, SIGUIENTE]);
    await expect(new PostgresRepo(enUso).upsertWhatsappBranchChannel(ORG_ID, PROPERTY_ID, "pn-1")).rejects.toBeInstanceOf(WhatsappNumberInUseError);
    await sesionSigueViva(enUso);
  });

  it("el numero por defecto de la organizacion tambien traduce 23505 (unicidad cruzada) a WhatsappNumberInUseError", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into restaurantes\.whatsapp_channel_config/i, respond: () => pgError("23505", "duplicate") }, SIGUIENTE]);
    await expect(new PostgresRepo(session).upsertWhatsappChannelConfig(ORG_ID, "pn-1")).rejects.toBeInstanceOf(WhatsappNumberInUseError);
    await sesionSigueViva(session);
  });

  it("numero SALIENTE: base SIN migrar cae al numero por defecto de la organizacion dentro de la misma transaccion; con sucursal migrada usa su numero", async () => {
    const sinMigrar = new AbortAwareFakeSession([
      { match: /from restaurantes\.whatsapp_branch_channel where organization_id = \$1 and property_id/i, respond: () => sinTabla("whatsapp_branch_channel") },
      { match: /from restaurantes\.whatsapp_channel_config where organization_id/i, respond: () => [{ phone_number_id: "pn-org" }] },
    ]);
    expect(await new PostgresRepo(sinMigrar).resolveActiveWhatsAppPhoneNumberId(ORG_ID, PROPERTY_ID)).toBe("pn-org");
    expect(sinMigrar.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);

    const migrada = new AbortAwareFakeSession([
      { match: /from restaurantes\.whatsapp_branch_channel where organization_id = \$1 and property_id/i, respond: () => [{ phone_number_id: "pn-suc" }] },
    ]);
    expect(await new PostgresRepo(migrada).resolveActiveWhatsAppPhoneNumberId(ORG_ID, PROPERTY_ID)).toBe("pn-suc");
  });

  it("desconectar: sin migrar -> Unavailable", async () => {
    const session = new AbortAwareFakeSession([{ match: /delete from restaurantes\.whatsapp_branch_channel/i, respond: () => sinTabla("whatsapp_branch_channel") }, SIGUIENTE]);
    await expect(new PostgresRepo(session).deleteWhatsappBranchChannel(ORG_ID, PROPERTY_ID)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });
});

// Alias corto para no repetir el nombre de la clase en cada caso.
const PostgresRepo = PostgresRestaurantesRepository;
