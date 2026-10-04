// R-PM-15: el sumidero de produccion de eventos por turno de WhatsApp pasa por el scrub de PII y firma el
// telefono con una llave derivada del secreto del servidor (nunca el numero en claro).
import { afterEach, describe, expect, it, vi } from "vitest";
import { observabilidadTurnosRestaurantes } from "../src/production/deps.ts";

afterEach(() => vi.restoreAllMocks());

const evento = (extra: Record<string, unknown> = {}) => ({
  evento: "whatsapp_turno" as const, correlationId: "c-1", organizationId: "org-1", propertyId: null, rolModelo: "default", rolesUsados: ["default"],
  vueltas: 1, latenciaTotalMs: 12, tools: [], resultado: "ok" as const, motivoEscalacion: null, motivoEscaladaDeRol: null, telefonoHash: null, ...extra,
});

describe("observabilidadTurnosRestaurantes", () => {
  it("emite una linea JSON con ts y level y limpia un PAN o un telefono que se colara en un campo", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const obs = observabilidadTurnosRestaurantes("secreto-app");
    obs.emitir(evento({ motivoEscalacion: "tarjeta 4111 1111 1111 1111 y cel 999 123 4567" }));
    expect(log).toHaveBeenCalledTimes(1);
    const linea = String(log.mock.calls[0]![0]);
    expect(linea).not.toContain("4111");
    expect(linea).not.toContain("999 123 4567");
    const parsed = JSON.parse(linea) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "info", evento: "whatsapp_turno", correlationId: "c-1" });
    expect(typeof parsed.ts).toBe("string");
  });

  it("el hash del telefono depende del secreto y no revela el numero; sin secreto el telefono se omite", () => {
    const a = observabilidadTurnosRestaurantes("secreto-a").hashTelefono!("+5219991234567");
    const b = observabilidadTurnosRestaurantes("secreto-b").hashTelefono!("+5219991234567");
    expect(a).toMatch(/^tel_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("9991234567");
    expect(observabilidadTurnosRestaurantes("").hashTelefono!("+5219991234567")).toBeNull();
    expect(observabilidadTurnosRestaurantes(null).hashTelefono!("+5219991234567")).toBeNull();
  });
});
