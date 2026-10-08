// Regresion V07 / G_SIN_PII_LOG intermitente: `eventoSinPII` pasaba por `redactarPII` los UUID aleatorios de propertyId/organizationId y,
// si traian digitos con forma de telefono, los mutilaba ("a412bc9e-5b[TELEFONO]-ef6ee24343c4"). Un UUID no es PII: sale intacto. Solo se
// exime un UUID estricto completo en claves de id; todo lo demas sigue redactado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logContieneSensible } from "../src/simulador/graders-voz.ts";
import { eventoSinPII, type SumideroLog } from "../src/llamada/log-sin-pii.ts";

const UUID_CON_DIGITOS = "a412bc9e-5b12-4345-8678-ef6ee24343c4";

function campos(entrada: Record<string, unknown>): Record<string, string | number | boolean> {
  let salida: Record<string, string | number | boolean> = {};
  const sumidero: SumideroLog = (l) => { salida = { ...l.campos }; };
  eventoSinPII(sumidero, "evento", entrada);
  return salida;
}

describe("log sin PII y UUID (reloj fijo)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("REGRESION V07-uuid-mutilado: un UUID con digitos de forma telefonica en propertyId/organizationId sale intacto y el grader no da falso positivo", () => {
    const c = campos({ propertyId: UUID_CON_DIGITOS, organizationId: UUID_CON_DIGITOS });
    expect(c.propertyId).toBe(UUID_CON_DIGITOS);
    expect(c.organizationId).toBe(UUID_CON_DIGITOS);
    expect(JSON.stringify(c)).not.toContain("[TELEFONO]");
    expect(logContieneSensible(JSON.stringify(c), "412")).toBe(false);
  });

  it("negativo: un telefono real en un campo de texto libre sigue redactado", () => {
    const c = campos({ motivo: "llama al 999 123 4567", mensaje: "9991234567", razon: "+52 999 123 4567" });
    expect(JSON.stringify(c)).not.toMatch(/999 123|9991234567/);
    expect(c.motivo).toContain("[TELEFONO]");
  });

  it("negativo: un id que NO es UUID valido y tiene forma de telefono sigue redactado", () => {
    expect(campos({ propertyId: "999 123 4567" }).propertyId).toBe("[TELEFONO]");
    expect(campos({ propertyId: "9991234567" }).propertyId).toBe("[TELEFONO]");
    // UUID con version/variante invalidas (no es un UUID bien formado): no se exime.
    expect(campos({ organizationId: "a412bc9e-5b12-0345-8678-ef6ee24343c4" }).organizationId).not.toBe("a412bc9e-5b12-0345-8678-ef6ee24343c4");
  });

  it("negativo: un string con un UUID mas texto (o un telefono pegado) sigue pasando por la redaccion", () => {
    const c = campos({ propertyId: `${UUID_CON_DIGITOS} llama al 999 123 4567`, organizationId: `${UUID_CON_DIGITOS}\n9991234567` });
    expect(JSON.stringify(c)).not.toMatch(/999 123 4567|9991234567/);
  });

  it("negativo: un UUID valido en una clave que NO es de id (texto libre) sigue redactado", () => {
    const c = campos({ mensaje: UUID_CON_DIGITOS, motivo: UUID_CON_DIGITOS });
    expect(c.mensaje).toContain("[TELEFONO]");
    expect(c.motivo).toContain("[TELEFONO]");
  });
});
