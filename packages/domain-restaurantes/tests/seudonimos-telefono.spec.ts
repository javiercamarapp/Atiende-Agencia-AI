// QA R1 seguridad-08/10 -- seudonimos de telefono: HMAC con la llave del servidor (no reversible por fuerza bruta sin la llave) y las
// variantes de formato de un mismo titular (WhatsApp +521..., voz +52..., pedidos 10 digitos).
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorHash, legacyActorHash } from "../src/rate-limit.ts";
import { seudonimosDeTelefono, variantesDeDigitos } from "../src/privacidad/telefono-hash.ts";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

describe("actorHash", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("con ACTOR_HASH_KEY es un HMAC-SHA256: distinto del sha256 plano y imposible de recalcular sin la llave", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "llave-de-prueba-0123456789");
    const esperado = createHmac("sha256", "llave-de-prueba-0123456789").update("5219981234567").digest("hex");
    expect(actorHash("5219981234567")).toBe(esperado);
    expect(actorHash("5219981234567")).not.toBe(sha256("5219981234567"));
    expect(actorHash("5219981234567")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dos llaves distintas dan seudonimos distintos para el mismo telefono", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "llave-numero-uno-0123456");
    const a = actorHash("9981234567");
    vi.stubEnv("ACTOR_HASH_KEY", "llave-numero-dos-0123456");
    expect(actorHash("9981234567")).not.toBe(a);
  });

  it("sin llave (o con una demasiado corta) conserva el sha256 plano de antes: nada guardado se invalida", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "");
    expect(actorHash("9981234567")).toBe(sha256("9981234567"));
    vi.stubEnv("ACTOR_HASH_KEY", "corta");
    expect(actorHash("9981234567")).toBe(sha256("9981234567"));
  });

  it("legacyActorHash siempre es el sha256 plano", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "llave-de-prueba-0123456789");
    expect(legacyActorHash("9981234567")).toBe(sha256("9981234567"));
  });
});

describe("seudonimosDeTelefono", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("variantesDeDigitos: completo, 10 nacionales, +52 y +521; nada si hay menos de 7 digitos", () => {
    expect(variantesDeDigitos("+52 1 998 123 4567").sort()).toEqual(["5219981234567", "529981234567", "9981234567"].sort());
    expect(variantesDeDigitos("12345")).toEqual([]);
  });

  it("WhatsApp (+521...) y voz (+52...) del mismo titular comparten seudonimos: una solicitud por un canal protege el otro", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "llave-de-prueba-0123456789");
    const whatsapp = new Set(seudonimosDeTelefono("+5219981234567"));
    const voz = seudonimosDeTelefono("+529981234567");
    // El identificador de llamada +52... (12 digitos) esta entre las variantes del numero de WhatsApp.
    expect(whatsapp.has(actorHash("529981234567"))).toBe(true);
    expect(voz.some((h) => whatsapp.has(h))).toBe(true);
  });

  it("incluye tambien los sha256 planos de antes de la llave (filas ya guardadas)", () => {
    vi.stubEnv("ACTOR_HASH_KEY", "llave-de-prueba-0123456789");
    const hashes = seudonimosDeTelefono("+5219981234567");
    expect(hashes).toContain(sha256("529981234567"));
    expect(hashes).toContain(actorHash("529981234567"));
  });
});
