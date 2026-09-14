// Fase 8 — SR-14: un 200 con cuerpo de bloqueo nunca se confunde con "0 registros".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertLegitimateCsvBody } from "../../src/connectors/response-classifier.ts";
import { CaptchaDetectedError, InterfaceChangedError } from "../../src/connector-registry.ts";

const ACCESS_DENIED_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/compras-mx-historico-access-denied.html", import.meta.url));

describe("assertLegitimateCsvBody", () => {
  it("no lanza ante texto con forma de CSV real", () => {
    expect(() => assertLegitimateCsvBody("codigo_contrato,titulo_contrato\nABC-1,Un contrato\n", { url: "https://ejemplo.mx/x.csv" })).not.toThrow();
  });

  it("lanza CaptchaDetectedError ante el HTML de bloqueo REAL capturado en vivo el 2026-09-14 contra la fuente real (ver connector-registry.ts)", () => {
    const realBlockedBody = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    expect(() => assertLegitimateCsvBody(realBlockedBody, { url: "https://repodatos.atdt.gob.mx/x.csv" })).toThrow(CaptchaDetectedError);
  });

  it("lanza InterfaceChangedError ante HTML sin ningún marcador de bloqueo reconocido (cambio de formato inesperado, no un bloqueo)", () => {
    const unexpectedHtml = "<html><body><h1>Bienvenido al nuevo portal</h1></body></html>";
    expect(() => assertLegitimateCsvBody(unexpectedHtml, { url: "https://ejemplo.mx/x.csv" })).toThrow(InterfaceChangedError);
  });

  it("no lanza ante un cuerpo vacío que NO empieza como HTML (se deja pasar al parser CSV, que reportará 0 filas de datos explícitamente)", () => {
    expect(() => assertLegitimateCsvBody("", { url: "https://ejemplo.mx/x.csv" })).not.toThrow();
  });
});
