// Redacción del resumen diario -- ver ../src/resumen-diario/redaccion.ts.
// Tres garantías DURAS a probar: (1) sin gateway -- SIEMPRE la plantilla
// determinista; (2) un gateway que lanza, o que tarda más que el timeout --
// SIEMPRE cae a la plantilla determinista, nunca revienta; (3) lo que se le
// manda al LLM (`construirPromptLlm`) NUNCA contiene un campo personal --
// verificado con un fixture que SÍ trae datos personales en la entrada
// cruda, para confirmar que el agregador (no la redacción) ya los excluyó
// antes de llegar aquí.
import { describe, expect, it } from "vitest";
import type { LlmCompletionResult, LlmGateway } from "@atiende/agent-core";
import { combinarDiarioAgregados, type DiarioAgregados, type FuentesDiarias } from "../src/resumen-diario/motor.ts";
import { construirPromptLlm, generarNarrativaLlm, redactarPlantillaDeterminista, redactarResumenDiario } from "../src/resumen-diario/redaccion.ts";

function fuentesVacias(overrides: Partial<FuentesDiarias> = {}): FuentesDiarias {
  return {
    fecha: "2026-01-15",
    crons: [],
    colas: [],
    licitacionesFuentes: [],
    llmPlatformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
    gastoLlmHoy: { costoMicroUsd: 0, tokensIn: 0, tokensOut: 0, llamadas: 0 },
    topOrganizacionesGastoLlm: [],
    organizacionesStaffNuevos: { organizacionesNuevas: 1, nombresOrganizacionesNuevas: ["Los Taquitos de PM"], staffNuevos: 2 },
    prospectos: { altas: 3, cambiosEstado: 1, sinMovimiento: 0 },
    facturacion: { altas: 1, bajas: 0, morososNuevos: 0, activasTotal: 5, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 },
    breakGlassAbiertos: 0,
    ...overrides,
  };
}

function agregadosDeMuestra(overrides: Partial<FuentesDiarias> = {}): DiarioAgregados {
  return combinarDiarioAgregados(fuentesVacias(overrides), null);
}

/** Doble mínimo de `LlmGateway` -- solo implementa `complete`, que es lo
 *  único que `generarNarrativaLlm` invoca. Cast a `LlmGateway` porque el
 *  tipo real trae más miembros privados que este doble no necesita simular. */
function gatewayFake(complete: LlmGateway["complete"]): LlmGateway {
  return { complete } as unknown as LlmGateway;
}

interface ResultadoLlmCompleto extends LlmCompletionResult {
  readonly providerId: string;
  readonly fallbackUsed: boolean;
  readonly attempts: never[];
}

function resultadoLlm(texto: string, overrides: Partial<ResultadoLlmCompleto> = {}): ResultadoLlmCompleto {
  return { text: texto, model: "modelo-de-prueba", tokensIn: 100, tokensOut: 50, costUsd: 0.002, providerId: "fake-provider", fallbackUsed: false, attempts: [], ...overrides };
}

describe("redactarPlantillaDeterminista", () => {
  it("SIEMPRE produce texto, incluso con todas las secciones en null", () => {
    const agregados = combinarDiarioAgregados(
      fuentesVacias({ crons: null, colas: null, licitacionesFuentes: null, llmPlatformBudget: null, gastoLlmHoy: null, organizacionesStaffNuevos: null, prospectos: null, facturacion: null, breakGlassAbiertos: null }),
      null,
    );
    const texto = redactarPlantillaDeterminista(agregados);
    expect(texto.length).toBeGreaterThan(0);
    expect(texto).toContain("no se pudo leer");
  });

  it("menciona la fecha y los números reales cuando SÍ hay datos", () => {
    const texto = redactarPlantillaDeterminista(agregadosDeMuestra());
    expect(texto).toContain("2026-01-15");
    expect(texto).toContain("Los Taquitos de PM");
  });
});

describe("redactarResumenDiario -- SIN gateway", () => {
  it("sin gateway (undefined) -> SIEMPRE la plantilla determinista, generadoPor='determinista', sin costo", async () => {
    const resultado = await redactarResumenDiario(undefined, agregadosDeMuestra());
    expect(resultado.generadoPor).toBe("determinista");
    expect(resultado.narrativa).toBe(redactarPlantillaDeterminista(agregadosDeMuestra()));
    expect(resultado.costoLlmMicroUsd).toBeNull();
    expect(resultado.modeloLlm).toBeNull();
    expect(resultado.proveedorLlm).toBeNull();
  });
});

describe("redactarResumenDiario -- gateway que falla o tarda -- SIEMPRE cae a la plantilla", () => {
  it("el gateway lanza -> plantilla determinista, nunca revienta la generación del resumen", async () => {
    const gateway = gatewayFake(async () => {
      throw new Error("proveedor caído");
    });
    const resultado = await redactarResumenDiario(gateway, agregadosDeMuestra());
    expect(resultado.generadoPor).toBe("determinista");
    expect(resultado.costoLlmMicroUsd).toBeNull();
  });

  it("el gateway tarda más que el timeout -> plantilla determinista (nunca espera indefinidamente)", async () => {
    const gateway = gatewayFake(() => new Promise((resolve) => setTimeout(() => resolve(resultadoLlm("tarde")), 200)));
    const inicio = Date.now();
    const resultado = await redactarResumenDiario(gateway, agregadosDeMuestra(), 20);
    const duracionMs = Date.now() - inicio;
    expect(resultado.generadoPor).toBe("determinista");
    expect(duracionMs).toBeLessThan(150);
  });

  it("el gateway responde texto vacío -> se trata igual que un fallo, plantilla determinista", async () => {
    const gateway = gatewayFake(async () => resultadoLlm("   "));
    const resultado = await redactarResumenDiario(gateway, agregadosDeMuestra());
    expect(resultado.generadoPor).toBe("determinista");
  });
});

describe("generarNarrativaLlm -- caso feliz", () => {
  it("el gateway responde a tiempo -> usa ese texto, generadoPor='llm', con costo/modelo/proveedor reales", async () => {
    const gateway = gatewayFake(async () => resultadoLlm("Todo tranquilo hoy en la plataforma.", { costUsd: 0.0034, model: "claude-x", providerId: "anthropic" }));
    const resultado = await generarNarrativaLlm(gateway, agregadosDeMuestra());
    expect(resultado).not.toBeNull();
    expect(resultado!.narrativa).toBe("Todo tranquilo hoy en la plataforma.");
    expect(resultado!.generadoPor).toBe("llm");
    expect(resultado!.costoLlmMicroUsd).toBe(3_400);
    expect(resultado!.modeloLlm).toBe("claude-x");
    expect(resultado!.proveedorLlm).toBe("anthropic");
  });

  it("pasa maxOutputTokens/rol/lane consistentes en la llamada (defensa de presupuesto)", async () => {
    let optsVistos: Parameters<LlmGateway["complete"]>[0] | undefined;
    const gateway = gatewayFake(async (opts) => {
      optsVistos = opts;
      return resultadoLlm("ok");
    });
    await generarNarrativaLlm(gateway, agregadosDeMuestra());
    expect(optsVistos?.role).toBe("plataforma:resumen_diario");
    expect(optsVistos?.lane).toBe("background");
    expect(optsVistos?.request.maxOutputTokens).toBeLessThanOrEqual(400);
  });
});

describe("construirPromptLlm -- NUNCA contiene datos personales", () => {
  it("el prompt no trae ningún campo de contacto/nombre de PERSONA -- aunque la fuente cruda (antes del agregador) sí los tuviera", () => {
    // Fixture deliberado con forma de dato personal en la entrada CRUDA (como si
    // una lectura de fuente, por error, hubiera incluido de más) -- el motor puro
    // (combinarDiarioAgregados) NUNCA copia estos campos a DiarioAgregados, así
    // que el prompt tampoco puede contenerlos. Este test falla si algún día
    // alguien agrega un campo con datos de contacto a FuentesDiarias/
    // DiarioAgregados sin darse cuenta de que eso rompe la regla.
    const fuentesConDatoPersonalFiltrado = fuentesVacias({
      // @ts-expect-error -- deliberado: simula una fuga de campos que
      // FuentesDiarias NUNCA debería tener (nombre/teléfono/correo de una
      // persona real), para que TS marque la intención explícita de este
      // fixture (y el test igual compila/corre). TS reporta las 3
      // propiedades excedentes como un solo diagnóstico anclado aquí.
      prospectoContactoNombre: "Juan Pérez",
      huespedTelefono: "+52 999 123 4567",
      huespedCorreo: "juan.perez@example.com",
    });
    const agregados = combinarDiarioAgregados(fuentesConDatoPersonalFiltrado, null);
    const prompt = construirPromptLlm(agregados);

    expect(prompt).not.toContain("Juan Pérez");
    expect(prompt).not.toContain("+52 999 123 4567");
    expect(prompt).not.toContain("juan.perez@example.com");
    // El nombre de ORGANIZACIÓN sí está permitido y sí debe llegar (dato de
    // negocio, no personal, ver el comentario de cabecera de la migración).
    expect(prompt).toContain("Los Taquitos de PM");
  });

  it("el prompt es exactamente el JSON de DiarioAgregados, sin envoltura ni texto adicional", () => {
    const agregados = agregadosDeMuestra();
    const prompt = construirPromptLlm(agregados);
    expect(JSON.parse(prompt)).toEqual(agregados);
  });
});
