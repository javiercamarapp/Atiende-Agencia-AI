import { describe, expect, it } from "vitest";
import { menuPdfBaseDeEntorno, urlFacturacionDeEntorno } from "../src/production/deps.ts";

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

describe("menuPdfBaseDeEntorno", () => {
  it("solo acepta https sin credenciales ni query; sin variable o con basura el agente comparte el enlace oficial en vez de un PDF", () => {
    expect(menuPdfBaseDeEntorno({ PM_MENU_PDF_BASE_URL: " https://menus.ejemplo.test/pm/ " } as NodeJS.ProcessEnv)).toBe("https://menus.ejemplo.test/pm");
    expect(menuPdfBaseDeEntorno({} as NodeJS.ProcessEnv)).toBeNull();
    expect(menuPdfBaseDeEntorno({ PM_MENU_PDF_BASE_URL: "http://menus.ejemplo.test" } as NodeJS.ProcessEnv)).toBeNull();
    expect(menuPdfBaseDeEntorno({ PM_MENU_PDF_BASE_URL: "https://u:p@menus.ejemplo.test" } as NodeJS.ProcessEnv)).toBeNull();
    expect(menuPdfBaseDeEntorno({ PM_MENU_PDF_BASE_URL: "https://menus.ejemplo.test/?t=1" } as NodeJS.ProcessEnv)).toBeNull();
    expect(menuPdfBaseDeEntorno({ PM_MENU_PDF_BASE_URL: "no es una url" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
