// Compatibilidad con la base SIN la migracion 030: cada operacion degrada con SAVEPOINT
// (AbortAwareFakeSession reproduce 25P02: una sesion falsa plana NO detectaria un catch sin savepoint).
import { describe, expect, it } from "vitest";
import { PostgresWhatsAppRepository, WhatsAppNotAvailableError, createLicitacionesMessagingOutboxPort } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const ORG = "00000000-0000-0000-0000-0000000000d1";
const USER = "00000000-0000-0000-0000-0000000000c5";

describe("PostgresWhatsAppRepository -- base sin migracion 030", () => {
  it("42P01 al leer el contacto: lanza WhatsAppNotAvailableError con la sesion ya recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from licitaciones\.whatsapp_contact/, respond: () => pgError("42P01", 'relation "licitaciones.whatsapp_contact" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresWhatsAppRepository(session);
    await expect(repo.getContact(ORG, USER)).rejects.toBeInstanceOf(WhatsAppNotAvailableError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // la transaccion NO quedo abortada: la consulta de respaldo / el COMMIT funcionan
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("42883 (funcion inexistente) al consumir un token: mismo degradado, sesion sana", async () => {
    const session = new AbortAwareFakeSession([
      { match: /whatsapp_consume_action_token/, respond: () => pgError("42883", "function licitaciones.whatsapp_consume_action_token(text, text, text) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresWhatsAppRepository(session).consumeActionToken("a".repeat(64), "+525500000000", "wamid.1")).rejects.toBeInstanceOf(WhatsAppNotAvailableError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("otro error de Postgres (p. ej. permiso) NO se disfraza de 'no disponible': se repropaga, tambien con la sesion sana", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_whatsapp_confirm_opt_in/, respond: () => pgError("42501", "solo para la sesion de sistema") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresWhatsAppRepository(session).confirmOptIn("+525500000000")).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("el puerto del dispatcher devuelve vacio (no lanza) con la base sin migrar y la sesion sana", async () => {
    const session = new AbortAwareFakeSession([
      { match: /claim_whatsapp_outbox_batch/, respond: () => pgError("42883", "function licitaciones.claim_whatsapp_outbox_batch(integer, integer) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const port = createLicitacionesMessagingOutboxPort(new PostgresWhatsAppRepository(session), "123456");
    await expect(port.claimBatch(5, 60)).resolves.toEqual([]);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("base migrada: el puerto inyecta el remitente de la plataforma y no confia en uno del payload", async () => {
    const session = new AbortAwareFakeSession([
      { match: /claim_whatsapp_outbox_batch/, respond: () => [{ id: "o1", attempts: 0, payload: { to: "+525500000000", body: "hola", phoneNumberId: "atacante" } }] },
    ]);
    const [item] = await createLicitacionesMessagingOutboxPort(new PostgresWhatsAppRepository(session), "123456").claimBatch(5, 60);
    expect((item!.payload as { phoneNumberId: string }).phoneNumberId).toBe("123456");
  });

  it("el consumo normaliza la fila de la funcion SQL", async () => {
    const session = new AbortAwareFakeSession([
      { match: /whatsapp_consume_action_token/, respond: () => [{ resultado: "ok", convocatoria_id: "t1", accion: "go", rol: "analyst" }] },
    ]);
    await expect(new PostgresWhatsAppRepository(session).consumeActionToken("a".repeat(64), "+525500000000", "m")).resolves.toEqual({ result: "ok", tenderId: "t1", action: "go", role: "analyst" });
  });
});
