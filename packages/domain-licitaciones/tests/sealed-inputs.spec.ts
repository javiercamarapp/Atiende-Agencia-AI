// EX-EXP-17 del origen: `PackageAssembler.buildManifest`/`approveExpediente`
// NUNCA deben aceptar un hash de insumos calculado a mano -- solo un
// `HashedInputs` sellado por este módulo, verificado en runtime.
import { describe, expect, it } from "vitest";
import { computeInputsHash, InvalidInputsHashError, requireValidHashedInputs, sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";

const INPUTS: ExpedienteInputs = {
  tenderVersionHash: "hash-bases-v1",
  companyProfileHash: "hash-perfil-v1",
  companyDocuments: [{ documentId: "doc-1", hash: "hash-doc-1", vigenteHasta: "2026-12-31T23:59:59-06:00" }],
  rates: [{ concept: "consultoria_hora", hash: "hash-rate-1" }],
  templates: [],
};

describe("computeInputsHash", () => {
  it("es determinista para el mismo ExpedienteInputs", () => {
    expect(computeInputsHash(INPUTS)).toBe(computeInputsHash({ ...INPUTS }));
  });

  it("cambia si cualquier insumo cambia", () => {
    const changed: ExpedienteInputs = { ...INPUTS, rates: [{ concept: "consultoria_hora", hash: "hash-rate-DISTINTO" }] };
    expect(computeInputsHash(changed)).not.toBe(computeInputsHash(INPUTS));
  });

  it("es insensible al orden de inserción de arreglos (documentos/tarifas se ordenan canónicamente)", () => {
    const a: ExpedienteInputs = { ...INPUTS, rates: [{ concept: "b", hash: "hb" }, { concept: "a", hash: "ha" }] };
    const b: ExpedienteInputs = { ...INPUTS, rates: [{ concept: "a", hash: "ha" }, { concept: "b", hash: "hb" }] };
    expect(computeInputsHash(a)).toBe(computeInputsHash(b));
  });

  it("exige las 5 categorías -- un insumo omitido (no solo vacío) lanza", () => {
    const broken: Partial<ExpedienteInputs> = { tenderVersionHash: INPUTS.tenderVersionHash, companyProfileHash: INPUTS.companyProfileHash, companyDocuments: INPUTS.companyDocuments, templates: INPUTS.templates };
    expect(() => computeInputsHash(broken as ExpedienteInputs)).toThrow();
  });
});

describe("sealInputs / requireValidHashedInputs -- EX-EXP-17", () => {
  it("un HashedInputs sellado por sealInputs pasa la verificación", () => {
    const sealed = sealInputs(INPUTS);
    expect(() => requireValidHashedInputs(sealed, "test")).not.toThrow();
    expect(requireValidHashedInputs(sealed, "test").hash).toBe(sealed.hash);
  });

  it("rechaza un string plano (incluso si es el hash 'correcto' calculado por fuera)", () => {
    const correctHashCalculatedByHand = computeInputsHash(INPUTS);
    expect(() => requireValidHashedInputs(correctHashCalculatedByHand, "test")).toThrow(InvalidInputsHashError);
  });

  it("rechaza un objeto forjado a mano que imita la forma {inputs, hash} sin el sello interno", () => {
    const forged = { inputs: INPUTS, hash: computeInputsHash(INPUTS) };
    expect(() => requireValidHashedInputs(forged, "test")).toThrow(InvalidInputsHashError);
  });

  it("rechaza un HashedInputs cuyos insumos fueron MUTADOS después de sellarse", () => {
    const mutableInputs: ExpedienteInputs = { ...INPUTS, rates: [...INPUTS.rates] };
    const sealed = sealInputs(mutableInputs);
    // Mutación directa del objeto `inputs` referenciado por el sellado.
    (sealed.inputs.rates as { concept: string; hash: string }[]).push({ concept: "extra", hash: "x" });
    expect(() => requireValidHashedInputs(sealed, "test")).toThrow(/MUTADOS después de sellarse/);
  });

  it("rechaza un objeto que solo HEREDA el símbolo privado vía prototipo (nunca pasó por sealInputs)", () => {
    const legit = sealInputs(INPUTS);
    const inherited = Object.create(legit) as { inputs: ExpedienteInputs; hash: unknown };
    // Aunque `inherited` "es" un HashedInputs por herencia de prototipo, no
    // es la instancia devuelta por sealInputs -- debe rechazarse igual.
    expect(() => requireValidHashedInputs(inherited, "test")).toThrow(InvalidInputsHashError);
  });
});
