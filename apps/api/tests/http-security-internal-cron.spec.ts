// Fase 12 licitaciones (cierre del hallazgo ALTA "sin cron configurado") — test
// unitario real de `internalOrCronSecretMatches` (apps/api/src/http-security.ts):
// el gate combinado que ahora aceptan las 4 rutas internas de licitaciones
// (discover-tenders/deadline-reminders/alert-notifications/email-dispatch) para
// poder ser disparadas tanto a mano (`x-atiende-internal-secret`) como por Vercel
// Cron (`Authorization: Bearer $CRON_SECRET`, la única forma en que Vercel Cron
// puede mandar el secreto — no permite headers custom en su configuración).
import { describe, expect, it } from "vitest";
import { internalOrCronSecretMatches } from "../src/http-security.ts";

const SECRET = "secreto-real-de-prueba";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/internal/licitaciones/alert-notifications", { headers });
}

describe("internalOrCronSecretMatches", () => {
  it("acepta el header manual x-atiende-internal-secret (forma de siempre, curl/tests)", () => {
    expect(internalOrCronSecretMatches(req({ "x-atiende-internal-secret": SECRET }), SECRET)).toBe(true);
  });

  it("acepta Authorization: Bearer <secreto> (forma en que Vercel Cron manda CRON_SECRET)", () => {
    expect(internalOrCronSecretMatches(req({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true);
  });

  it("rechaza sin ningún header", () => {
    expect(internalOrCronSecretMatches(req({}), SECRET)).toBe(false);
  });

  it("rechaza x-atiende-internal-secret con el valor equivocado", () => {
    expect(internalOrCronSecretMatches(req({ "x-atiende-internal-secret": "otro-valor" }), SECRET)).toBe(false);
  });

  it("rechaza Authorization Bearer con el valor equivocado (ej. CRON_SECRET de Vercel sin alinear con INTERNAL_SECRET)", () => {
    expect(internalOrCronSecretMatches(req({ authorization: "Bearer otro-valor" }), SECRET)).toBe(false);
  });

  it("rechaza un esquema Authorization que no sea Bearer", () => {
    expect(internalOrCronSecretMatches(req({ authorization: `Basic ${SECRET}` }), SECRET)).toBe(false);
  });
});
