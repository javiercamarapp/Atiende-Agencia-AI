// P0-1/P1-4: el gate Postgres distingue «no aplica» (base sin la 101) de un error real (p. ej. 42501 por un GRANT mal puesto): el real se LOGUEA con su SQLSTATE
// (sin PII) y se repropaga para que el eco falle y Meta reintente; nunca se traga para que el asistente «nunca calle» sin que nadie se entere.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresHandoffAgentGate } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const pgError = (code: string, m: string) => Object.assign(new Error(m), { code });
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/, respond: () => [{ ok: true }] };
const input = { organizationId: ORG, propertyId: PROP, phone: "+5219991234567", atMs: 1_800_000_000_000 };

afterEach(() => vi.restoreAllMocks());

describe("PostgresHandoffAgentGate.tomarPorEcoDeApp", () => {
  it("42501 (GRANT/rol): lo loguea sin PII, repropaga y deja la sesion viva", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = new AbortAwareFakeSession([{ match: /handoff_eco_app/, respond: () => pgError("42501", "permission denied") }, SIGUIENTE]);
    await expect(new PostgresHandoffAgentGate(s).tomarPorEcoDeApp(input)).rejects.toMatchObject({ code: "42501" });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("tomarPorEcoDeApp"), "42501");
    expect(JSON.stringify(err.mock.calls)).not.toContain("5219991234567");
    await expect(s.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("base sin la 101 (42883): «no aplica» -> null, sin error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = new AbortAwareFakeSession([{ match: /handoff_eco_app/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresHandoffAgentGate(s).tomarPorEcoDeApp(input)).toBeNull();
  });

  it("tomaPorEcoDeApp con 42501 degrada a false pero LO LOGUEA", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = new AbortAwareFakeSession([{ match: /handoff_whatsapp_toma_por_app/, respond: () => pgError("42501", "permission denied") }, SIGUIENTE]);
    expect(await new PostgresHandoffAgentGate(s).tomaPorEcoDeApp(ORG, "+5219991234567")).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("tomaPorEcoDeApp"), "42501");
  });
});
