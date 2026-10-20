// PM-R14 (privacidad), segunda tanda, capa API: el tick de /internal/restaurantes/promover-programados y el aviso «Recibimos su pedido» registraban `err.message`.
// `logEvent` solo hace scrub de telefonos, correos, tarjetas, JWT y llaves: NO de nombres, direcciones ni platillos, que un error de Postgres trae en `message`.
// Ahora solo viajan clase y codigo (`descripcionSeguraDeError`). El tick sigue respondiendo 200 y el aviso sigue devolviendo `{ enviado: false, motivo: "error" }`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { Order } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { avisarPedidoRecibido } from "../src/routes/verticals/restaurantes/autopiloto-recibido.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const PII = "Nora Privada, Calle Secreta 123 Col. Centro, 2 tacos de cochinita";
const errorConPii = () => Object.assign(new Error(`duplicate key value violates unique constraint: Key (customer_name)=(${PII}) already exists`), { code: "23505" });

let salida: string;
beforeEach(() => {
  salida = "";
  const captura = (...args: unknown[]) => {
    salida += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a as object)))).join(" ")}\n`;
  };
  vi.spyOn(console, "error").mockImplementation(captura);
  vi.spyOn(console, "log").mockImplementation(captura);
  vi.spyOn(console, "warn").mockImplementation(captura);
});
afterEach(() => vi.restoreAllMocks());

const sinPii = () => {
  for (const prohibido of ["Nora Privada", "Calle Secreta", "cochinita", "customer_name", "duplicate key"]) expect(salida, prohibido).not.toContain(prohibido);
};

describe("tick de promover-programados: las unidades que fallan loguean clase y codigo", () => {
  it("tras la promocion todas las sesiones siguientes fallan con PII en el mensaje: 200 y log sin PII", async () => {
    const base = await buildTestDeps();
    let llamadas = 0;
    const engine: TenancyEngine = {
      withAppSession: (claims, fn) => {
        llamadas += 1;
        if (llamadas === 1) return base.deps.engine.withAppSession(claims, fn);
        return Promise.reject(errorConPii());
      },
    };
    const app = buildApp({ ...base.deps, engine });
    const r = await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(r.status).toBeLessThan(600);
    for (const evento of ["restaurantes_programados_reconciliacion_fallida", "restaurantes_avisos_operativos_fallidos", "restaurantes_marketing_borradores_fallidos", "restaurantes_whatsapp_silencio_fallido"]) {
      expect(salida, evento).toContain(evento);
    }
    expect(salida).toContain("23505");
    sinPii();
  });
});

describe("«Recibimos su pedido»: el fallo no imprime el mensaje", () => {
  it("devuelve el motivo error y el log solo lleva clase y codigo", async () => {
    const t = await buildTestDeps();
    const deps = { ...t.deps, env: { ...t.deps.env, whatsappApprovedTemplates: ["pedido_recibido"] } };
    const repo = new Proxy(t.restaurantesRepo, {
      get: (obj, prop) => (prop === "runWithRowSavepoint" ? () => Promise.reject(errorConPii()) : Reflect.get(obj, prop)),
    });
    const order = { id: "o1", organizationId: t.organizationId, propertyId: t.propertyId, customerName: "Nora Privada", customerPhone: "9991234567", branch: "X", total: 10, status: "pending", source: "voice" } as unknown as Order;
    const sesion: TenantDbSession = { query: async <T>() => ({ rows: [] as T[] }), exec: async () => undefined };
    const r = await avisarPedidoRecibido(deps, sesion, repo, order);
    expect(r).toEqual({ enviado: false, motivo: "error" });
    expect(salida).toContain("23505");
    sinPii();
  });
});
