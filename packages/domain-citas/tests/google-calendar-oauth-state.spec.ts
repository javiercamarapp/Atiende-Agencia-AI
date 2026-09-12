import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OAUTH_STATE_TTL_MS, signGoogleCalendarOAuthState, verifyGoogleCalendarOAuthState } from "../src/google-calendar-oauth-state.ts";

describe("firma/verificación del state de OAuth de Google Calendar (Fase 3 §4)", () => {
  const secret = "test-whatsapp-app-secret"; // el mismo secreto de plataforma que meta-signature.ts

  it("un state real firmado y verificado con el mismo secreto devuelve el payload original", () => {
    const organizationId = randomUUID();
    const providerId = randomUUID();
    const propertyId = randomUUID();
    const token = signGoogleCalendarOAuthState({ organizationId, providerId, propertyId }, secret);
    const verified = verifyGoogleCalendarOAuthState(token, secret);
    expect(verified).toEqual({ organizationId, providerId, propertyId, issuedAt: verified!.issuedAt });
  });

  it("rechaza un state firmado con un secreto distinto", () => {
    const token = signGoogleCalendarOAuthState({ organizationId: randomUUID(), providerId: randomUUID(), propertyId: randomUUID() }, secret);
    expect(verifyGoogleCalendarOAuthState(token, "otro-secreto-distinto")).toBeNull();
  });

  it("rechaza un state manipulado (payload alterado sin volver a firmar)", () => {
    const token = signGoogleCalendarOAuthState({ organizationId: randomUUID(), providerId: randomUUID(), propertyId: randomUUID() }, secret);
    const [payloadB64, signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ organizationId: "atacante-org", providerId: "atacante-provider", propertyId: "atacante-property", issuedAt: Date.now() }), "utf8").toString("base64url");
    expect(verifyGoogleCalendarOAuthState(`${tamperedPayload}.${signature}`, secret)).toBeNull();
    void payloadB64;
  });

  it("rechaza basura / formato inválido sin lanzar", () => {
    expect(verifyGoogleCalendarOAuthState("no-es-un-token-valido", secret)).toBeNull();
    expect(verifyGoogleCalendarOAuthState("", secret)).toBeNull();
    expect(verifyGoogleCalendarOAuthState(".", secret)).toBeNull();
  });

  it("expira después de OAUTH_STATE_TTL_MS", () => {
    const issuedAt = new Date("2026-09-11T10:00:00.000Z");
    const token = signGoogleCalendarOAuthState({ organizationId: randomUUID(), providerId: randomUUID(), propertyId: randomUUID() }, secret, issuedAt);
    const justBefore = new Date(issuedAt.getTime() + OAUTH_STATE_TTL_MS - 1000);
    const justAfter = new Date(issuedAt.getTime() + OAUTH_STATE_TTL_MS + 1000);
    expect(verifyGoogleCalendarOAuthState(token, secret, justBefore)).not.toBeNull();
    expect(verifyGoogleCalendarOAuthState(token, secret, justAfter)).toBeNull();
  });
});
