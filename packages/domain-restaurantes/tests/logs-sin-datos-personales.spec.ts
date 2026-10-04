// QA R1 seguridad-12 -- los intentos best-effort registran solo el nombre y el SQLSTATE del error de Postgres, nunca su `detail`
// (que en una violacion de restriccion trae la fila o el valor, p. ej. un telefono) ni el objeto completo.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describirErrorSeguro } from "../src/log-seguro.ts";
import { createOrder } from "../src/orders.ts";
import { tryNotifyCustomerOnOrderStatusChange } from "../src/order-notifications.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const TELEFONO = "+5219981234567";

function pgConDatosPersonales(): Error & { code: string; detail: string; where: string } {
  const err = new Error(`duplicate key value violates unique constraint "customers_organization_id_phone_key"`) as Error & { code: string; detail: string; where: string };
  err.name = "error";
  err.code = "23505";
  err.detail = `Key (organization_id, phone)=(org-1, ${TELEFONO}) already exists. Failing row contains (Titular QA, ${TELEFONO}).`;
  err.where = `SQL statement "insert into restaurantes.messaging_outbox ... ${TELEFONO}"`;
  return err;
}

describe("describirErrorSeguro", () => {
  it("devuelve solo el nombre y el SQLSTATE: el detalle con datos personales nunca aparece", () => {
    const texto = describirErrorSeguro(pgConDatosPersonales());
    expect(texto).toBe("error code=23505");
    expect(texto).not.toContain(TELEFONO);
    expect(texto).not.toContain("Titular");
  });

  it("tolera valores que no son un error de Postgres", () => {
    expect(describirErrorSeguro(new Error("x"))).toBe("Error");
    expect(describirErrorSeguro("texto con 5219981234567")).toBe("error no estandar (string)");
    expect(describirErrorSeguro(null)).toBe("error desconocido");
    expect(describirErrorSeguro({ code: "no un sqlstate; con espacios y datos" })).toBe("Error");
  });
});

describe("best-effort de notificaciones: el log no lleva datos personales", () => {
  afterEach(() => vi.restoreAllMocks());

  it("un fallo con `detail` y `where` (telefono) se registra solo como nombre + SQLSTATE", async () => {
    const fixture = buildRestaurantFixture();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Titular QA",
      customerPhone: "9981234567",
      customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "preparando");
    vi.spyOn(fixture.repo, "resolveActiveWhatsAppPhoneNumberId").mockRejectedValue(pgConDatosPersonales());
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tryNotifyCustomerOnOrderStatusChange(fixture.repo, preparando!)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    const volcado = spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ")).join("\n");
    expect(volcado).toContain("code=23505");
    expect(volcado).not.toContain(TELEFONO);
    expect(volcado).not.toContain("Titular QA");
    expect(volcado).not.toContain("already exists");
  });
});
