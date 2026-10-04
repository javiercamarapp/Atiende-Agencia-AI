// QA restaurantes, ronda 1 (lote storefront / dinero / idempotencia): regresion de QA-restaurantes-R1-caos-20. El correo de
// confirmacion y la comanda al POS son efectos EXTERNOS: deben ocurrir DESPUES del COMMIT del pedido, no dentro de la transaccion.
// El motor en memoria no falla en el COMMIT, asi que se envuelve `withAppSession` para registrar el orden de los eventos y para
// simular un COMMIT que no llega (la sesion lanza despues de que el callback termino).
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, MapaProductoCodigo, crearResolverSucursalPos, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const ORIGIN = { origin: "http://localhost:5173" };

function falsoComoReal(fake: FakeSoftRestaurantAdapter): SoftRestaurantPort {
  return new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
}

async function setup(opciones: { fallaElCommitEn?: number } = {}) {
  const base = await buildTestDeps();
  const store = new InMemoryComandaOutboxStore();
  store.ponerModo(base.organizationId, "activo");
  const fake = new FakeSoftRestaurantAdapter();
  const eventos: string[] = [];
  // El POS registra EN QUE MOMENTO lo llamaron respecto a las transacciones.
  const posVisible = new Proxy(falsoComoReal(fake), {
    get: (t, p, r) => {
      if (p === "crearComanda") return (input: unknown) => (eventos.push("pos"), (t as unknown as FakeSoftRestaurantAdapter).crearComanda(input as never));
      return Reflect.get(t, p, r);
    },
  }) as SoftRestaurantPort;
  let sesiones = 0;
  const motor = new Proxy(base.deps.engine, {
    get: (t, p, r) => {
      if (p !== "withAppSession") return Reflect.get(t, p, r);
      return async (ctx: unknown, fn: unknown) => {
        const n = ++sesiones;
        eventos.push(`abre${n}`);
        const salida = await (t.withAppSession as (...a: unknown[]) => Promise<unknown>).call(t, ctx, fn);
        // COMMIT: aqui termina la transaccion `n`. Si "falla el commit" de esa sesion, lanza y el cliente recibe un 5xx.
        if (opciones.fallaElCommitEn === n) {
          eventos.push(`commit-fallido${n}`);
          throw new Error("COMMIT no llego (simulado)");
        }
        eventos.push(`commit${n}`);
        return salida;
      };
    },
  });
  const deps: AppDeps = {
    ...base.deps,
    engine: motor as AppDeps["engine"],
    softRestaurantStore: () => store,
    softRestaurantPort: posVisible,
    softRestaurantMapeo: {
      resolverCodigos: new MapaProductoCodigo([{ productId: base.products.cocaCola!, codigo: "FAKE-003" }]),
      resolverSucursal: crearResolverSucursalPos({ [base.propertyId]: "T2" }),
    },
  };
  const app = buildApp(deps);
  const cuerpoLegado = { branch_slug: "fco-montejo", customer_name: "Cliente Web", customer_phone: "9991234567", customer_email: "ana@example.com", canal: "recoger", payment_method: "efectivo", items: [{ product_id: base.products.cocaCola, requested_quantity: 2 }], source: "web" };
  return { base, store, fake, eventos, app, cuerpoLegado };
}

describe("caos-20: correo y comanda al POS despues del COMMIT del pedido", () => {
  it("checkout legado: la comanda se manda al POS DESPUES del commit de la transaccion que creo el pedido; el cliente ve el folio", async () => {
    const t = await setup();
    const res = await t.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(t.cuerpoLegado, ORIGIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { id: string }; comanda: { estado: string; folio: string } };
    expect(body.comanda).toMatchObject({ estado: "confirmada", folio: t.fake.comandas[0]!.folio });
    // sesion 1 = tope por IP (transaccion propia, QA R1 seguridad-09); sesion 2 = la que crea el pedido.
    expect(t.eventos.indexOf("pos")).toBeGreaterThan(t.eventos.indexOf("commit2"));
    expect(t.eventos.filter((e) => e === "pos")).toHaveLength(1);
  });

  it("checkout legado: si el COMMIT no llega, NO se manda la comanda al POS ni se drena el correo (no hay pedido que avisar)", async () => {
    const t = await setup({ fallaElCommitEn: 2 }); // la 1 es el tope por IP (seguridad-09); la 2 crea el pedido
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await t.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(t.cuerpoLegado, ORIGIN));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(t.fake.llamadasCrear).toHaveLength(0);
    expect(t.eventos).not.toContain("pos");
    expect(t.eventos).toEqual(["abre1", "commit1", "abre2", "commit-fallido2"]); // ninguna sesion posterior (ni correo ni POS)
  });

  it("storefront: igual (comanda al POS despues del commit; sin commit, ningun efecto externo)", async () => {
    const t = await setup();
    const sesion = "efectos-post-commit-0001";
    const body = { session_id: sesion, items: [{ product_id: t.base.products.cocaCola, requested_quantity: 2 }], canal: "recoger", payment_method: "efectivo" };
    const post = (path: string, b: object) => t.app.request(`/v1/restaurantes/${ORG}/storefront/fco-montejo${path}`, jsonRequestInit(b, { ...ORIGIN, "x-forwarded-for": "10.9.9.9" }));
    const q = (await (await post("/quote", body)).json()) as { quote_hash: string };
    await post("/confirm", { session_id: sesion, quote_hash: q.quote_hash });
    t.eventos.length = 0;
    const res = await post("/orders", { ...body, quote_hash: q.quote_hash, customer_name: "Ana", customer_phone: "9991234567" });
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as { comanda: { estado: string; folio: string } | null };
    expect(cuerpo.comanda).toMatchObject({ estado: "confirmada" });
    // cada peticion abre antes su tope por IP en una transaccion propia (seguridad-09). Sesiones: 1-2 cotizar, 3-4 confirmar,
    // 5 tope del pedido, 6 crear (transaccion del pedido), 7 efectos posteriores al commit
    expect(t.eventos.indexOf("pos")).toBeGreaterThan(t.eventos.indexOf("commit6"));
    expect(t.eventos.indexOf("abre7")).toBeGreaterThan(t.eventos.indexOf("commit6"));
  });

  it("storefront: si el COMMIT de la transaccion que crea el pedido no llega, no sale la comanda al POS", async () => {
    const t = await setup({ fallaElCommitEn: 6 }); // ver numeracion de sesiones arriba: la 6 crea el pedido
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sesion = "efectos-post-commit-0002";
    const body = { session_id: sesion, items: [{ product_id: t.base.products.cocaCola, requested_quantity: 2 }], canal: "recoger", payment_method: "efectivo" };
    const post = (path: string, b: object) => t.app.request(`/v1/restaurantes/${ORG}/storefront/fco-montejo${path}`, jsonRequestInit(b, { ...ORIGIN, "x-forwarded-for": "10.9.9.8" }));
    const q = (await (await post("/quote", body)).json()) as { quote_hash: string };
    await post("/confirm", { session_id: sesion, quote_hash: q.quote_hash });
    const res = await post("/orders", { ...body, quote_hash: q.quote_hash, customer_name: "Ana", customer_phone: "9991234567" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(t.fake.llamadasCrear).toHaveLength(0);
    expect(t.eventos).not.toContain("pos");
    expect(t.eventos).not.toContain("abre7");
  });

  it("POS caido: el pedido sigue siendo 200 con 'pendiente de confirmar' y la comanda queda para el despachador", async () => {
    const t = await setup();
    t.fake.inyectarFalla("crearComanda", { tipo: "timeout" });
    const res = await t.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(t.cuerpoLegado, ORIGIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comanda: { estado: string; folio: string | null } };
    expect(body.comanda).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(t.store.todas()[0]).toMatchObject({ estado: "fallida" });
  });
});
