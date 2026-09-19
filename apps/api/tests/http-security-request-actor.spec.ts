// Hallazgo de revisión real (ronda r5, bloqueante 1 del PR #167): `requestActor`
// confiaba PRIMERO en `cf-connecting-ip` -- un header que CUALQUIER cliente puede
// escribir libremente y que Vercel (sin Cloudflare real delante, ver vercel.json)
// deja pasar intacto hasta el handler. Contra un rate-limit evaluado ANTES de
// verificar cualquier firma (`routes/billing.ts`), eso permitía (a) evadir el
// límite rotando el header en cada request, y (b) escribir la IP de un tercero
// para agotarle su cupo (denegación de servicio dirigida). Este spec prueba
// directamente la función, sin pasar por una ruta HTTP completa.
import { describe, expect, it } from "vitest";
import { requestActor } from "../src/http-security.ts";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/billing/webhook", { headers });
}

describe("requestActor", () => {
  it("nunca confía en cf-connecting-ip por defecto -- un valor arbitrario no cambia el actor", () => {
    const sinHeader = requestActor(req({ "x-forwarded-for": "203.0.113.9" }));
    const conHeaderArbitrario = requestActor(req({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "1.2.3.4" }));
    expect(conHeaderArbitrario).toBe(sinHeader);
  });

  it("rotar cf-connecting-ip en cada request no fabrica un bucket nuevo (mismo x-forwarded-for real)", () => {
    const intento1 = requestActor(req({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "1.1.1.1" }));
    const intento2 = requestActor(req({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "9.9.9.9" }));
    expect(intento1).toBe(intento2);
  });

  it("escribir la IP pública de un tercero en cf-connecting-ip no envenena su bucket real", () => {
    // Simula el ataque descrito en el hallazgo: alguien sin credenciales pone
    // `cf-connecting-ip: <IP publicada de Stripe>` para gastar el cupo de esa IP.
    const actorDelAtacante = requestActor(req({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "3.18.12.63" }));
    const actorRealDeStripe = requestActor(req({ "x-forwarded-for": "3.18.12.63" }));
    expect(actorDelAtacante).not.toBe(actorRealDeStripe);
  });

  it("usa el ÚLTIMO salto de x-forwarded-for (el que Vercel agrega, no un prefijo que el caller puede fabricar)", () => {
    const actor = requestActor(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" }));
    expect(actor).toBe(requestActor(req({ "x-forwarded-for": "203.0.113.9" })));
  });

  it("cae a x-real-ip cuando no hay x-forwarded-for", () => {
    expect(requestActor(req({ "x-real-ip": "203.0.113.9" }))).toBe(requestActor(req({ "x-forwarded-for": "203.0.113.9" })));
  });

  it("cae a 'unknown' sin ningún header de IP", () => {
    expect(requestActor(req({}))).toBe("unknown:");
  });

  it("el discriminador 'secondary' se preserva junto con el actor derivado", () => {
    expect(requestActor(req({ "x-forwarded-for": "203.0.113.9" }), "stripe-billing")).toBe("203.0.113.9:stripe-billing");
  });
});
