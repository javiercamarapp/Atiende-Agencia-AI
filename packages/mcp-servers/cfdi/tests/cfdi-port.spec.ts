// Pruebas de contrato de CfdiPort: el mismo comportamiento (idempotencia por folio,
// conflicto ante datos distintos, conmutación dual-PAC, verificación de webhook) se
// exige de CUALQUIER implementación real o simulada — mismo espíritu que
// packages/domain-despachos/tests/reglas-fiscales-avanzadas.spec.ts para el motor
// fiscal. Corre enteramente contra los adaptadores Fake: nunca requiere una API key
// real de Finkok/SW Sapien.
import { describe, expect, it } from "vitest";
import { CfdiFolioConflictError, DualPacCfdiPort, FakeFinkokAdapter, FakeSwSapienAdapter, FinkokAdapter, SwSapienAdapter, PortUnavailableError, type TimbrarInput } from "../src/index.ts";

function timbrarInput(overrides: Partial<TimbrarInput> = {}): TimbrarInput {
  return {
    folio: "folio-test-1:hospedaje",
    rfcEmisor: "HTP850101AB1",
    rfcReceptor: "XAXX010101000",
    subtotal: 1000,
    iva: 160,
    impuestosLocales: { ishTasa: 0.03, ishMonto: 30 },
    total: 1190,
    moneda: "MXN",
    usoCfdi: "S01",
    metodoPago: "PUE",
    ...overrides,
  };
}

describe("FakeFinkokAdapter / FakeSwSapienAdapter — contrato de CfdiPort", () => {
  it("timbrar es idempotente por folio: la misma entrada devuelve el mismo UUID", async () => {
    const pac = new FakeFinkokAdapter();
    const first = await pac.timbrar(timbrarInput());
    const second = await pac.timbrar(timbrarInput());
    expect(second.uuid).toBe(first.uuid);
    expect(second.status).toBe("timbrado");
  });

  it("timbrar el mismo folio con datos DISTINTOS lanza CfdiFolioConflictError", async () => {
    const pac = new FakeFinkokAdapter();
    await pac.timbrar(timbrarInput());
    await expect(pac.timbrar(timbrarInput({ total: 2000 }))).rejects.toBeInstanceOf(CfdiFolioConflictError);
  });

  it("cancelar es idempotente por idempotencyKey", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(timbrarInput());
    const first = await pac.cancelar({ uuid: timbrado.uuid, motivo: "02", idempotencyKey: "cancel-1" });
    const second = await pac.cancelar({ uuid: timbrado.uuid, motivo: "02", idempotencyKey: "cancel-1" });
    expect(second).toEqual(first);
    expect(await pac.consultarEstado(timbrado.uuid)).toBe("cancelado");
  });

  it("verifyAndNormalizeWebhook rechaza una firma inválida y detecta un replay", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(timbrarInput());
    const { rawBody, signature } = pac.signWebhookFixture({
      event_id: "evt-1",
      type: "cfdi.timbrado_confirmado",
      uuid: timbrado.uuid,
      status: "timbrado",
      occurred_at: new Date().toISOString(),
    });

    await expect(pac.verifyAndNormalizeWebhook(rawBody, "sha256=firma-invalida")).rejects.toThrow();

    const normalized = await pac.verifyAndNormalizeWebhook(rawBody, signature);
    expect(normalized.eventId).toBe("evt-1");

    await expect(pac.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toThrow(/replay/);
  });
});

describe("DualPacCfdiPort — conmutación primario/secundario", () => {
  it("timbra con el primario cuando está disponible", async () => {
    const primary = new FakeFinkokAdapter();
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(timbrarInput());
    expect(timbrado.pac).toBe("finkok");
    expect(dual.usedSecondaryFor(timbrarInput().folio)).toBe(false);
  });

  it("conmuta al secundario si el primario falla, sin timbrar dos veces", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(timbrarInput());
    expect(timbrado.pac).toBe("sw-sapien");
    expect(dual.usedSecondaryFor(timbrarInput().folio)).toBe(true);

    // Reintentar el mismo folio no vuelve a llamar a ningún PAC -- responde desde el caché del wrapper.
    const second = await dual.timbrar(timbrarInput());
    expect(second.uuid).toBe(timbrado.uuid);
  });

  it("lanza AggregateError si AMBOS PAC fallan", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    secondary.down = true;
    const dual = new DualPacCfdiPort(primary, secondary);
    await expect(dual.timbrar(timbrarInput())).rejects.toBeInstanceOf(AggregateError);
  });

  it("status() reporta el primario cuando está disponible, y explica la conmutación cuando no", () => {
    const primary = new FakeFinkokAdapter();
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    expect(dual.status().provider).toBe("finkok");

    primary.down = true;
    const status = dual.status();
    expect(status.provider).toBe("sw-sapien");
    expect(status.reason).toMatch(/PAC primario no disponible/);
  });
});

describe("FinkokAdapter / SwSapienAdapter — adaptadores reales, esqueleto honesto", () => {
  it("sin variables de entorno de credenciales, status() reporta unavailable y CUALQUIER llamada falla explícito (nunca inventa un timbrado)", async () => {
    const finkok = new FinkokAdapter();
    expect(finkok.status().available).toBe(false);
    expect(finkok.status().simulated).toBe(false);
    await expect(finkok.timbrar(timbrarInput())).rejects.toBeInstanceOf(PortUnavailableError);
    await expect(finkok.consultarEstado("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(PortUnavailableError);

    const sw = new SwSapienAdapter();
    expect(sw.status().available).toBe(false);
    await expect(sw.timbrar(timbrarInput())).rejects.toBeInstanceOf(PortUnavailableError);
  });
});
