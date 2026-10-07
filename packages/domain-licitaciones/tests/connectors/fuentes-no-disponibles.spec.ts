// Fuentes externas no disponibles (cron discover-tenders, 7-oct-2026): cada caso reproduce la forma REAL observada
// contra la fuente (403 Akamai de repodatos.atdt.gob.mx, certificado vencido de contratacionesabiertas.guadalajara.gob.mx:3000,
// connect timeout de datos.cdmx.gob.mx desde el egress de Vercel). Un 500 u otro fallo genérico NO se degrada.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createComprasMxHistoricoConnector } from "../../src/connectors/compras-mx-historico.ts";
import { createCdmxOcdsConnector } from "../../src/connectors/ocds/cdmx-ocds-connector.ts";
import { createGuadalajaraOcdsConnector } from "../../src/connectors/ocds/contratacionesabiertas-connector.ts";
import { SourceUnavailableError } from "../../src/connector-errors.ts";
import { classifySourceFailure } from "../../src/source-run.ts";

const ACCESS_DENIED_HTML = readFileSync(fileURLToPath(new URL("../fixtures/compras-mx-historico-access-denied.html", import.meta.url)), "utf8");

/** Forma real de undici: `TypeError("fetch failed")` con la causa en `.cause.code`. */
function undiciFetchFailed(code: string, message: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause: unknown }).cause = Object.assign(new Error(message), { code });
  return err;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("fuentes no disponibles se clasifican, no se ocultan", () => {
  it("compras_mx_historico: 403 Access Denied del WAF -> SourceUnavailableError(blocked), state down + unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(ACCESS_DENIED_HTML, { status: 403, headers: { "content-type": "text/html" } }));
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await drain(connector.discover({ limit: 5 }, {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe("blocked");
    expect((err as Error).message).toContain("403");
    expect(classifySourceFailure(err)).toMatchObject({ state: "down", unavailable: true });
  });

  it("guadalajara_ocds: certificado TLS vencido -> SourceUnavailableError(tls_invalid) con la causa real en el mensaje; no se desactiva la verificación", async () => {
    const fetchImpl = vi.fn(async () => {
      throw undiciFetchFailed("CERT_HAS_EXPIRED", "certificate has expired");
    });
    const connector = createGuadalajaraOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await drain(connector.discover({}, { now: () => new Date("2026-10-07T00:00:00Z") })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe("tls_invalid");
    expect((err as Error).message).toContain("CERT_HAS_EXPIRED");
    expect(classifySourceFailure(err).unavailable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("guadalajara_ocds: /edca/fiscalYears 404 y 500 son fallos REALES (la URL es constante del repo)", async () => {
    const make = (status: number) => createGuadalajaraOcdsConnector({ fetchImpl: (async () => new Response("{}", { status })) as unknown as typeof fetch });
    const gone = await drain(make(404).discover({}, { now: () => new Date("2026-10-07T00:00:00Z") })).catch((e: unknown) => e);
    expect(gone).not.toBeInstanceOf(SourceUnavailableError);
    expect(classifySourceFailure(gone).unavailable).toBeUndefined();
    const broken = await drain(make(500).discover({}, { now: () => new Date("2026-10-07T00:00:00Z") })).catch((e: unknown) => e);
    expect(broken).not.toBeInstanceOf(SourceUnavailableError);
    expect(classifySourceFailure(broken)).toEqual({ state: "down", message: expect.stringContaining("500") });
  });

  it("cdmx_ocds: connect timeout desde el egress -> SourceUnavailableError(unreachable) con el código real, no el opaco 'fetch failed'", async () => {
    const fetchImpl = vi.fn(async () => {
      throw undiciFetchFailed("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error");
    });
    const connector = createCdmxOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await drain(connector.discover({}, {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe("unreachable");
    expect((err as Error).message).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("cdmx_ocds: un fallo de transporte desconocido (sin código conocido) NO se degrada", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const connector = createCdmxOcdsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await drain(connector.discover({}, {})).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SourceUnavailableError);
    expect(classifySourceFailure(err).unavailable).toBeUndefined();
  });
});
