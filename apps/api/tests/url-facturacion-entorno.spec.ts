import { describe, expect, it } from "vitest";
import { urlFacturacionDeEntorno } from "../src/production/deps.ts";

describe("urlFacturacionDeEntorno", () => {
  it("solo acepta https; sin variable, con otro protocolo o con basura devuelve null (el agente no inventa un enlace)", () => {
    expect(urlFacturacionDeEntorno({ PM_URL_FACTURACION: " https://facturas.ejemplo.test/pm " } as NodeJS.ProcessEnv)).toBe("https://facturas.ejemplo.test/pm");
    expect(urlFacturacionDeEntorno({} as NodeJS.ProcessEnv)).toBeNull();
    expect(urlFacturacionDeEntorno({ PM_URL_FACTURACION: "http://facturas.ejemplo.test" } as NodeJS.ProcessEnv)).toBeNull();
    expect(urlFacturacionDeEntorno({ PM_URL_FACTURACION: "javascript:alert(1)" } as NodeJS.ProcessEnv)).toBeNull();
    expect(urlFacturacionDeEntorno({ PM_URL_FACTURACION: "no es una url" } as NodeJS.ProcessEnv)).toBeNull();
    expect(urlFacturacionDeEntorno({ PM_URL_FACTURACION: `https://x.test/${"a".repeat(400)}` } as NodeJS.ProcessEnv)).toBeNull();
  });
});
