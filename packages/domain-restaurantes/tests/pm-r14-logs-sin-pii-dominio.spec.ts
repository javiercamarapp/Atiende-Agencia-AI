// PM-R14 (privacidad), segunda tanda: los console.error de efectos best-effort del dominio de restaurantes (bitacora, avisos, autopiloto, comandas POS) imprimian el
// error entero o su `message`. Un error de Postgres trae valores de la fila (nombre, direccion, platillo, telefono) en `message` y en `detail`, y el scrub de logs
// de la API solo tapa telefonos, correos, tarjetas, JWT y llaves. Ahora solo salen clase y codigo (`descripcionSeguraDeError`). Mismos retornos: ninguna de estas
// rutas relanza ni cambia su resultado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avisarProgramadosPromovidos } from "../src/pedidos-programados-avisos.ts";
import {
  tryNotifyCustomerOnOrderStatusChange,
  tryNotifyCustomerOrderConfirmationEmail,
  tryNotifyStaffNewOrder,
  tryNotifyStaffOrderProblem,
  tryNotifyStaffRepartidorAssigned,
} from "../src/order-notifications.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { aplicarAvancesPos, aplicarEstadosSinClic, consultarEstadosPos, resolverSolicitudAprobacion } from "../src/autopiloto/servicio.ts";
import { encolarComandaParaPedido } from "../src/softrestaurant/outbox-service.ts";
import type { Order } from "../src/types.ts";

const PII = "Nora Privada, Calle Secreta 123 Col. Centro, 2 tacos de cochinita, 9991234567";
const errorConPii = () =>
  Object.assign(new Error(`duplicate key value violates unique constraint: Key (customer_name)=(${PII}) already exists`), {
    code: "23505",
    detail: `Key (customer_name, customer_address)=(${PII}) already exists.`,
  });

let salida: string;
beforeEach(() => {
  salida = "";
  const captura = (...args: unknown[]) => {
    salida += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a as object)))).join(" ")}\n`;
  };
  vi.spyOn(console, "error").mockImplementation(captura);
  vi.spyOn(console, "warn").mockImplementation(captura);
});
afterEach(() => vi.restoreAllMocks());

const sinPii = () => {
  for (const prohibido of ["Nora Privada", "Calle Secreta", "cochinita", "9991234567", "customer_name", "duplicate key"]) expect(salida, prohibido).not.toContain(prohibido);
};
/** Repositorio cuyo cualquier metodo lanza el error con PII. */
const repoQueFalla = () => new Proxy({}, { get: () => () => { throw errorConPii(); } }) as never;
const order = { id: "o1", organizationId: "org", propertyId: "p1", customerName: "Nora Privada", customerPhone: "9991234567", status: "pending", branch: "X", total: 10 } as unknown as Order;

describe("bitacora (registrarAuditoria / recordVoiceToolAudit)", () => {
  const entrada = { organizationId: "org", action: "x", entityType: "t", entityId: "e", campo: null, antes: null, despues: null } as never;

  it("no se pudo abrir el SAVEPOINT", async () => {
    const repo = new PostgresRestaurantesRepository({ exec: async () => { throw errorConPii(); }, query: async () => ({ rows: [] }) } as never);
    await expect(repo.registrarAuditoria(entrada)).resolves.toBeUndefined();
    expect(salida).toContain("23505");
    sinPii();
  });
  it("fallo inesperado al escribir y al recuperar el SAVEPOINT: no se relanza", async () => {
    const repo = new PostgresRestaurantesRepository({
      exec: async (sql: string) => { if (/ROLLBACK TO/.test(sql)) throw errorConPii(); },
      query: async () => { throw errorConPii(); },
    } as never);
    await expect(repo.registrarAuditoria(entrada)).resolves.toBeUndefined();
    expect(salida).toContain("23505");
    sinPii();
  });
  it("fallo inesperado al escribir (recuperacion bien)", async () => {
    const repo = new PostgresRestaurantesRepository({ exec: async () => undefined, query: async () => { throw errorConPii(); } } as never);
    await expect(repo.registrarAuditoria(entrada)).resolves.toBeUndefined();
    expect(salida).toContain("23505");
    sinPii();
  });
  it("recordVoiceToolAudit: error inesperado best-effort", async () => {
    const repo = new PostgresRestaurantesRepository({ exec: async () => undefined, query: async () => { throw errorConPii(); } } as never);
    await expect(repo.recordVoiceToolAudit({ organizationId: "org", propertyId: "p", callId: "c", tool: "t", outcome: "ok", phoneHash: null, detail: null } as never)).resolves.toBeUndefined();
    expect(salida).toContain("23505");
    sinPii();
  });
  it("recordVoiceToolAudit: ni el SAVEPOINT abre", async () => {
    const repo = new PostgresRestaurantesRepository({ exec: async () => { throw errorConPii(); }, query: async () => { throw errorConPii(); } } as never);
    await expect(repo.recordVoiceToolAudit({ organizationId: "org", propertyId: "p", callId: "c", tool: "t", outcome: "ok", phoneHash: null, detail: null } as never)).resolves.toBeUndefined();
    sinPii();
  });
});

describe("avisos al staff y al cliente (order-notifications)", () => {
  it("staff pedido nuevo / repartidor asignado / correo de confirmacion", async () => {
    await tryNotifyStaffNewOrder(repoQueFalla(), order);
    await tryNotifyStaffRepartidorAssigned(repoQueFalla(), order);
    await tryNotifyCustomerOrderConfirmationEmail(repoQueFalla(), order);
    expect(salida.match(/23505/g)?.length).toBe(3);
    sinPii();
  });
  it("WhatsApp al cliente e incidencia al staff, con y sin SAVEPOINT (incluida la recuperacion fallida)", async () => {
    await tryNotifyCustomerOnOrderStatusChange(repoQueFalla(), order);
    await tryNotifyStaffOrderProblem(repoQueFalla(), order);
    const db = { exec: async () => { throw errorConPii(); }, query: async () => ({ rows: [] }) } as never;
    await tryNotifyCustomerOnOrderStatusChange(repoQueFalla(), order, db);
    await tryNotifyStaffOrderProblem(repoQueFalla(), order, db);
    expect(salida).toContain("23505");
    sinPii();
  });
});

describe("pedidos programados: bandeja del staff", () => {
  it("no se pudo registrar: se cuenta el error y no se imprime el mensaje", async () => {
    const db = { exec: async () => undefined, query: async () => { throw errorConPii(); } } as never;
    const r = await avisarProgramadosPromovidos(repoQueFalla(), db, [order]);
    expect(r.errores).toBeGreaterThanOrEqual(1);
    expect(salida).toContain("23505");
    sinPii();
  });
});

describe("autopiloto (servicio)", () => {
  const repo = { runWithRowSavepoint: <T>(fn: () => Promise<T>) => fn(), findOrderById: async () => order };
  it("transicion sin clic que falla", async () => {
    const deps = {
      repo,
      db: {},
      auto: {
        candidatosEstados: async () => ({ disponible: true, valor: [{ organizationId: "org", orderId: "o1", desde: "pending", hacia: "preparando", motivo: "m" }] }),
        aplicarTransicion: async () => { throw errorConPii(); },
      },
    } as never;
    const r = await aplicarEstadosSinClic(deps, new Date());
    expect(r.omitidos).toBe(1);
    expect(salida).toContain("23505");
    sinPii();
  });
  it("consulta al POS que falla", async () => {
    const port = { obtenerEstadoComanda: async () => { throw errorConPii(); } } as never;
    const r = await consultarEstadosPos([{ organizationId: "org", orderId: "o1", propertyId: "p1", folio: "F1", status: "pending", canal: "recoger" } as never], port, () => ({}) as never);
    expect(r.consultadas).toBe(1);
    expect(salida).toContain("23505");
    sinPii();
  });
  it("avance desde el POS que falla", async () => {
    const deps = { repo, db: {}, auto: { aplicarTransicion: async () => { throw errorConPii(); } } } as never;
    const n = await aplicarAvancesPos(deps, [{ comanda: { organizationId: "org", orderId: "o1", status: "pending", canal: "recoger" } as never, estadoPos: "en_preparacion" }]);
    expect(n).toBe(0);
    expect(salida).toContain("23505");
    sinPii();
  });
  it("efecto secundario de una decision que falla (la decision ya quedo guardada)", async () => {
    const deps = {
      repo,
      db: {},
      auto: { resolverSolicitud: async () => ({ aplicado: true, orderId: "o1", estadoPedido: "cancelado", tipo: "cancelacion" }) },
      cortarComandaCancelado: async () => { throw errorConPii(); },
    } as never;
    const r = await resolverSolicitudAprobacion(deps, { organizationId: "org", solicitudId: "s1", decision: "cancelar" });
    expect(r?.efectos).toEqual([]);
    expect(salida).toContain("23505");
    sinPii();
  });
});

describe("comandas del POS (outbox-service, nivel medio)", () => {
  it("no se pudo leer la bandera: se asume apagado y no se imprime el error entero", async () => {
    const deps = { store: { leerModo: async () => { throw errorConPii(); } } } as never;
    const r = await encolarComandaParaPedido(deps, { order, input: {} } as never);
    expect(r.modo).toBe("apagado");
    expect(salida).toContain("23505");
    sinPii();
  });
});
