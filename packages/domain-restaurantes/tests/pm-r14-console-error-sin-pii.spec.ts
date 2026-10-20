// PM-R14 (privacidad): los console.error de las rutas del agente de restaurantes imprimian `err.message` (hasta 300 caracteres) y los mensajes de Postgres traen
// valores de la fila (telefonos, nombres, direcciones) que acaban en los logs de Vercel. Ahora solo salen la clase y el codigo del error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { intentarCancelacionConAutopiloto, registrarQuejaConAutopiloto } from "../src/whatsapp/autopiloto-turno.ts";
import type { AutopilotoTurnoHooks } from "../src/whatsapp/autopiloto-turno.ts";
import { encolarComandaDelTurno } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PII = "Nora Privada 9991234567 Calle Secreta 123 sk-or-v1-LLAVE-FALSA";
const errorConPii = () => Object.assign(new Error(`duplicate key value violates unique constraint: Key (customer_phone)=(${PII}) already exists`), { code: "23505" });

let salida: string;
beforeEach(() => {
  salida = "";
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    salida += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a as object)))).join(" ")}\n`;
  });
});
afterEach(() => vi.restoreAllMocks());

const sinPii = () => {
  for (const prohibido of ["Nora Privada", "9991234567", "Calle Secreta", "LLAVE-FALSA", "duplicate key", "customer_phone"]) expect(salida, prohibido).not.toContain(prohibido);
};

describe("console.error de las rutas del agente: clase y codigo, nunca el mensaje", () => {
  it("falla interna de una herramienta (registry): loguea clase + codigo, sin el mensaje ni argumentos", async () => {
    const f = buildRestaurantFixture();
    (f.repo as unknown as { runWithRowSavepoint: () => Promise<never> }).runWithRowSavepoint = async () => { throw errorConPii(); };
    const r = await executeAgentToolSafely(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234567" }, "registrar_contacto", { customer_name: "Nora Privada", telefono: "9991234567" });
    expect(r.fallaSistema).toBe(true);
    expect(salida).toContain("registrar_contacto");
    expect(salida).toContain("23505");
    expect(salida).toContain("Error");
    sinPii();
  });

  it("autopiloto: cancelacion que falla", async () => {
    const hooks = { cancelacionActiva: async () => true, solicitarCancelacion: async () => { throw errorConPii(); } } as unknown as AutopilotoTurnoHooks;
    const repo = { runWithRowSavepoint: <T>(fn: () => Promise<T>) => fn() };
    const r = await intentarCancelacionConAutopiloto(repo, hooks, { organizationId: "o", phone: "9991234567", ahora: new Date(), texto: "quiero cancelar mi pedido" });
    expect(r).toBeNull();
    expect(salida).toContain("23505");
    sinPii();
  });

  it("autopiloto: ligar la queja que falla", async () => {
    const hooks = { registrarQueja: async () => { throw errorConPii(); } } as unknown as AutopilotoTurnoHooks;
    const repo = { runWithRowSavepoint: <T>(fn: () => Promise<T>) => fn() };
    await registrarQuejaConAutopiloto(repo, hooks, { organizationId: "o", phone: "9991234567", texto: "llego frio", ahora: new Date() });
    expect(salida).toContain("23505");
    sinPii();
  });

  it("comanda de SoftRestaurant que falla al encolar", async () => {
    const r = await encolarComandaDelTurno(async () => { throw errorConPii(); }, { id: "x" } as never, { canal: "recoger" });
    expect(r).toBeNull();
    expect(salida).toContain("23505");
    sinPii();
  });
});

import { descripcionSeguraDeError } from "../src/log-seguro.ts";

describe("descripcionSeguraDeError: endurecido", () => {
  it("name con PII no se imprime", () => {
    const e = Object.assign(new Error("x"), { name: "Nora Privada 9991234567 Calle Secreta" });
    expect(descripcionSeguraDeError(e)).toBe("Error");
  });
  it("name no-string o ausente no lanza", () => {
    const e = new Error("x");
    Object.defineProperty(e, "name", { value: undefined });
    expect(() => descripcionSeguraDeError(e)).not.toThrow();
    expect(descripcionSeguraDeError(e)).toBe("Error");
    const e2 = new Error("x");
    Object.defineProperty(e2, "name", { value: 42 });
    expect(descripcionSeguraDeError(e2)).toBe("Error");
  });
  it("un getter que lanza devuelve 'error' sin lanzar", () => {
    const e = new Error("x");
    Object.defineProperty(e, "code", { get() { throw new Error("boom"); } });
    expect(descripcionSeguraDeError(e)).toBe("error");
    expect(descripcionSeguraDeError(Object.create(null, { name: { get() { throw new Error("boom"); } } }))).toBe("error");
  });
  it("un code solo de digitos (telefono) no se imprime", () => {
    expect(descripcionSeguraDeError(Object.assign(new Error("x"), { code: "9991234567" }))).toBe("Error");
  });
  it("SQLSTATE y codigos de Node validos se conservan", () => {
    expect(descripcionSeguraDeError(Object.assign(new Error("x"), { code: "23505" }))).toBe("Error code=23505");
    expect(descripcionSeguraDeError(Object.assign(new Error("x"), { code: "42P01" }))).toBe("Error code=42P01");
    expect(descripcionSeguraDeError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("Error code=ECONNRESET");
    expect(descripcionSeguraDeError(Object.assign(new Error("x"), { code: "ERR_INVALID_ARG_TYPE" }))).toBe("Error code=ERR_INVALID_ARG_TYPE");
  });
  it("valores que no son Error", () => {
    expect(descripcionSeguraDeError("Nora Privada")).toBe("string");
    expect(descripcionSeguraDeError(null)).toBe("object");
  });
});
