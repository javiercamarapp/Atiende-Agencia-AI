// Token de la encuesta post-entrega (R-41): firmado, ligado a organizacion + pedido, con vencimiento y sin cruce con otros tokens.
import { describe, expect, it } from "vitest";
import { ENCUESTA_TOKEN_TTL_SECONDS, encuestaTokenKey, issueEncuestaToken, signEncuestaToken, verifyEncuestaToken } from "../src/encuesta-token.ts";
import { issueStorefrontTrackingToken, storefrontTrackingKey, verifyStorefrontTrackingToken } from "../src/storefront-tracking-token.ts";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ORD = "00000000-0000-4000-8000-0000000000b1";
const key = encuestaTokenKey("secreto-de-prueba");

describe("token de encuesta", () => {
  it("emite y verifica: devuelve organizacion y pedido, y vence a los 14 dias", () => {
    const t = issueEncuestaToken(key, ORG, ORD, 1_000_000);
    const v = verifyEncuestaToken(key, t, 1_000_000 + 1000);
    expect(v).toMatchObject({ ok: true, claims: { org: ORG, ord: ORD } });
    expect(verifyEncuestaToken(key, t, 1_000_000 + ENCUESTA_TOKEN_TTL_SECONDS * 1000 + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("no contiene datos personales (solo ids y tiempos)", () => {
    const t = issueEncuestaToken(key, ORG, ORD);
    const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "ord", "org"]);
  });

  it("rechaza una firma alterada, otro secreto y formatos rotos", () => {
    const t = issueEncuestaToken(key, ORG, ORD);
    const [p, payload, sig] = t.split(".");
    expect(verifyEncuestaToken(key, `${p}.${payload}.${sig!.slice(0, -2)}AA`)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyEncuestaToken(encuestaTokenKey("otro"), t)).toMatchObject({ ok: false, reason: "bad_signature" });
    for (const malo of ["", "e1.solo", "e2.a.b", `${t}.extra`, "x".repeat(700)]) expect(verifyEncuestaToken(key, malo).ok).toBe(false);
  });

  it("un payload con otro pedido (firma de otro mensaje) no valida", () => {
    const t = issueEncuestaToken(key, ORG, ORD);
    const forjado = signEncuestaToken(encuestaTokenKey("otro"), { org: ORG, ord: "00000000-0000-4000-8000-0000000000b2", iat: 1, exp: 9_999_999_999 });
    expect(verifyEncuestaToken(key, forjado).ok).toBe(false);
    expect(verifyEncuestaToken(key, t).ok).toBe(true);
  });

  it("un token de rastreo del storefront NO valida como encuesta y al reves", () => {
    const rastreo = issueStorefrontTrackingToken(storefrontTrackingKey("secreto-de-prueba"), ORG, ORD);
    expect(verifyEncuestaToken(key, rastreo).ok).toBe(false);
    const encuesta = issueEncuestaToken(key, ORG, ORD);
    expect(verifyStorefrontTrackingToken(storefrontTrackingKey("secreto-de-prueba"), encuesta).ok).toBe(false);
  });
});
