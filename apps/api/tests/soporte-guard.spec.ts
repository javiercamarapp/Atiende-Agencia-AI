// Política pura de la guarda de sesiones de soporte (apps/api/src/soporte/guard.ts::evaluarPeticionSoporte): sin red ni reloj.
import { describe, expect, it } from "vitest";
import { ACCIONES_SIEMPRE_BLOQUEADAS, POST_DE_SOLO_LECTURA, evaluarPeticionSoporte } from "../src/soporte/guard.ts";

const PROP = "/v1/restaurantes/11111111-1111-1111-1111-111111111111";

function dec(method: string, path: string, elevado = false) {
  return evaluarPeticionSoporte({ method, path, elevado });
}

describe("evaluarPeticionSoporte -- solo lectura por defecto", () => {
  it("GET, HEAD y OPTIONS se permiten", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(dec(m, `${PROP}/admin/orders`).permitido).toBe(true);
    }
  });

  it("POST, PUT y PATCH sobre datos del cliente se bloquean con soporte_solo_lectura", () => {
    for (const m of ["POST", "PUT", "PATCH"]) {
      const d = dec(m, `${PROP}/admin/products/abc`);
      expect(d.permitido).toBe(false);
      if (!d.permitido) {
        expect(d.code).toBe("soporte_solo_lectura");
        expect(d.message).toContain("Permitir edición");
      }
    }
  });

  it("DELETE se bloquea SIEMPRE, aun con edición habilitada", () => {
    for (const elevado of [false, true]) {
      const d = dec("DELETE", `${PROP}/admin/customers/1/addresses/2`, elevado);
      expect(d.permitido).toBe(false);
      if (!d.permitido) expect(d.code).toBe("soporte_accion_bloqueada");
    }
  });

  it("la ruta con barra final o mayúsculas se evalúa igual", () => {
    expect(dec("PATCH", `${PROP}/Admin/Products/abc/`).permitido).toBe(false);
  });
});

describe("evaluarPeticionSoporte -- elevación", () => {
  it("con el token elevado se permiten las escrituras comunes", () => {
    for (const m of ["POST", "PUT", "PATCH"]) {
      expect(dec(m, `${PROP}/admin/products/abc`, true).permitido).toBe(true);
    }
    expect(dec("PATCH", `${PROP}/admin/orders/9/status`, true).permitido).toBe(true);
  });

  it("aun elevado, las acciones sensibles siguen bloqueadas (lista cerrada)", () => {
    const sensibles: Array<[string, string]> = [
      ["POST", "/auth/change-password"],
      ["POST", "/auth/2fa/disable"],
      ["POST", "/auth/revoke-sessions"],
      ["POST", "/billing/checkout"],
      ["POST", "/billing/portal"],
      ["POST", `${PROP}/pagos/reembolso`],
      ["POST", "/v1/privacidad/avisos"],
      ["PUT", "/v1/privacidad/retencion/pedidos"],
      ["POST", `${PROP}/admin/customers/9/borrar-memoria`],
      ["POST", `${PROP}/conversaciones/5/responder`],
      ["POST", `${PROP}/admin/marketing/campanas`],
      ["POST", "/v1/restaurantes/los-taquitos/callbacks"],
      ["POST", `${PROP}/admin/customers/import`],
      ["POST", `${PROP}/voice/call-token`],
      ["POST", `${PROP}/admin/staff/invitaciones`],
      ["PUT", `${PROP}/admin/voice-secret`],
    ];
    for (const [m, p] of sensibles) {
      const d = dec(m, p, true);
      expect(d.permitido, `${m} ${p}`).toBe(false);
      if (!d.permitido) expect(d.code).toBe("soporte_accion_bloqueada");
    }
    expect(ACCIONES_SIEMPRE_BLOQUEADAS.length).toBeGreaterThanOrEqual(8);
  });

  it("los GET sensibles (lectura) siguen permitidos: ver no es modificar", () => {
    expect(dec("GET", "/auth/me").permitido).toBe(true);
    expect(dec("GET", `${PROP}/conversaciones`).permitido).toBe(true);
    expect(dec("GET", "/billing/estado").permitido).toBe(true);
  });
});

describe("evaluarPeticionSoporte -- lista cerrada de POST de lectura y rutas propias", () => {
  it("el chat de datos y las vistas previas/exportaciones del CFO funcionan en solo lectura", () => {
    expect(dec("POST", `${PROP}/admin/chat-datos`).permitido).toBe(true);
    expect(dec("POST", `${PROP}/cfo/exportaciones`).permitido).toBe(true);
    expect(dec("POST", `${PROP}/cfo/softrestaurant/importar/vista-previa`).permitido).toBe(true);
    expect(dec("POST", `${PROP}/admin/customers/import/preview`).permitido).toBe(true);
    expect(POST_DE_SOLO_LECTURA.length).toBe(4);
  });

  it("importar de verdad (no la vista previa) sigue bloqueado", () => {
    expect(dec("POST", `${PROP}/cfo/softrestaurant/importar`, true).permitido).toBe(false);
  });

  it("estado, elevar y salir son propios de la sesión y siempre pasan la política", () => {
    expect(dec("GET", "/soporte/estado").permitido).toBe(true);
    expect(dec("POST", "/soporte/elevar").permitido).toBe(true);
    expect(dec("POST", "/soporte/salir").permitido).toBe(true);
    // pero no por otro método ni otra ruta de /soporte
    expect(dec("DELETE", "/soporte/salir").permitido).toBe(false);
    expect(dec("POST", "/soporte/otra").permitido).toBe(false);
  });

  it("la consola de plataforma no se usa desde una sesión de cliente, ni leyendo", () => {
    for (const m of ["GET", "POST"]) {
      const d = dec(m, "/superadmin/organizations", true);
      expect(d.permitido).toBe(false);
      if (!d.permitido) expect(d.code).toBe("soporte_ruta_bloqueada");
    }
  });
});
