import { describe, expect, it } from "vitest";
import { resumirErrorResend } from "../src/resend-error.ts";

describe("resumirErrorResend", () => {
  it("conserva estado y el `name` de Resend cuando es un identificador", () => {
    expect(resumirErrorResend(429, JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests for a@b.mx" }))).toEqual({
      status: 429,
      codigo: "rate_limit_exceeded",
    });
  });

  it("descarta `message`, cuerpos no JSON y `name` con texto libre", () => {
    expect(resumirErrorResend(502, "<html>a@b.mx</html>")).toEqual({ status: 502, codigo: "desconocido" });
    expect(resumirErrorResend(400, JSON.stringify({ name: "fallo para a@b.mx" }))).toEqual({ status: 400, codigo: "desconocido" });
    expect(resumirErrorResend(400, JSON.stringify(["validation_error"]))).toEqual({ status: 400, codigo: "desconocido" });
    expect(resumirErrorResend(500, "")).toEqual({ status: 500, codigo: "desconocido" });
  });
});
