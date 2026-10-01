// Scrub de PII/secretos (PL-10): telefonos, correos, tarjetas, tokens, JWT. Puro, sin red.
// Los valores con forma de secreto se arman en runtime: ningun literal sensible vive en el repo.
import { describe, expect, it } from "vitest";
import { MARCA_REDACTADO, OPCIONES_LOGS, redactarDatosDePago, scrubError, scrubTexto, scrubValor } from "../src/index.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtFalso = `${b64({ alg: "HS256" })}.${b64({ sub: "123" })}.firma_abcdefgh`;
const llaveFalsa = ["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_");

describe("scrubTexto", () => {
  it("redacta telefonos con distintos formatos (+52, espacios, guiones, parentesis)", () => {
    for (const tel of ["+52 55 1234 5678", "5512345678", "(55) 1234-5678", "+1 (415) 555-2671", "52-55-1234-5678"]) {
      const limpio = scrubTexto(`cliente ${tel} pidio factura`);
      expect(limpio, tel).toContain("[telefono]");
      expect(limpio, tel).not.toMatch(/1234|2671|5678/);
      expect(limpio).toContain("pidio factura");
    }
  });

  it("redacta correos", () => {
    const limpio = scrubTexto('duplicate key (email)=(maria.lopez+pedidos@gmail.com) ya existe');
    expect(limpio).not.toContain("maria.lopez");
    expect(limpio).toContain("[correo]");
  });

  it("redacta tarjetas con espacios, guiones y pegadas, sin dejar digitos", () => {
    for (const pan of ["4242 4242 4242 4242", "4242-4242-4242-4242", "4242424242424242", "378282246310005"]) {
      const limpio = scrubTexto(`pago con ${pan} rechazado`);
      expect(limpio, pan).not.toMatch(/\d{4}/);
      expect(limpio).toContain("rechazado");
    }
  });

  it("redacta JWT, bearer, llaves con prefijo y URIs con credenciales", () => {
    const limpio = scrubTexto(
      [`jwt ${jwtFalso}`, "Authorization: Bearer abcdef1234567890abcdef", `key ${llaveFalsa}`, "db postgres://admin:sup3rS3cret@db.example.com:5432/app"].join(" | "),
    );
    expect(limpio).not.toContain(jwtFalso.slice(0, 12));
    expect(limpio).not.toContain("abcdef1234567890abcdef");
    expect(limpio).not.toContain(llaveFalsa);
    expect(limpio).not.toContain("sup3rS3cret");
    expect(limpio).toContain("db.example.com");
  });

  it("redacta clave=valor sensible y tokens largos hex/base64, no palabras largas sin digitos", () => {
    const limpio = scrubTexto("fallo con password=hunter2 y api_key: ZZZ999 en el job");
    expect(limpio).not.toContain("hunter2");
    expect(limpio).not.toContain("ZZZ999");
    const hex = "a".repeat(8) + "1".repeat(8) + "b".repeat(8) + "2".repeat(12);
    expect(scrubTexto(`token ${hex} fin`)).not.toContain(hex);
    const larga = "internal-superadmin-resumen-diario-persistencia";
    expect(scrubTexto(larga)).toBe(larga);
  });

  it("conserva fechas ISO y rutas operativas", () => {
    const limpio = scrubTexto("corrida 2026-09-30T12:34:56.789Z cron /internal/hoteles/identidad-purga");
    expect(limpio).toContain("2026-09-30T12:34:56.789Z");
    expect(limpio).toContain("/internal/hoteles/identidad-purga");
  });

  it("preservarUuid deja intactos los UUID (incluso con segmentos numericos) y sigue redactando el resto", () => {
    const uuid = "00000000-0000-0000-0000-0000000000a1";
    const texto = `org ${uuid} fallo para ana@example.com`;
    // sin la opcion, un UUID con segmentos numericos se confunde con un telefono.
    expect(scrubTexto(`org ${uuid}`)).not.toContain(uuid);
    const limpio = scrubTexto(texto, { preservarUuid: true });
    expect(limpio).toContain(uuid);
    expect(limpio).not.toContain("ana@example.com");
  });

  it("trunca con maxLargo", () => {
    const limpio = scrubTexto("x".repeat(100) + " fin", { maxLargo: 20 });
    expect(limpio.length).toBe(20);
    expect(limpio.endsWith("…")).toBe(true);
  });
});

describe("redactarDatosDePago (mensajes de WhatsApp antes de persistir)", () => {
  it("redacta tarjeta, CVV y vencimiento con las etiquetas que ya afirman los tests de cada vertical", () => {
    expect(redactarDatosDePago("mi tarjeta es 4242 4242 4242 4242 cvv 123 vence 12/27")).toBe("mi tarjeta es [tarjeta oculta] [cvv oculto] vence [vencimiento oculto]");
  });

  it("no se come el separador final: tarjeta seguida de CVV queda separada", () => {
    expect(redactarDatosDePago("4242 4242 4242 4242 CVV: 999")).toBe("[tarjeta oculta] [cvv oculto]");
  });

  it("no toca fracciones de platillo ni cantidades normales", () => {
    const msg = "quiero 1/2 orden de tacos y 1/4 de kilo, mesa para 4";
    expect(redactarDatosDePago(msg)).toBe(msg);
  });
});

describe("scrubValor", () => {
  it("redacta por clave sensible sin mirar el contenido, y por patron dentro de los textos", () => {
    const limpio = scrubValor({ password: "hunter2", nota: "llamar a +52 55 1234 5678", anidado: { authorization: "algo", ok: "texto" } }) as { password: string; nota: string; anidado: { authorization: string; ok: string } };
    expect(limpio.password).toBe(MARCA_REDACTADO);
    expect(limpio.nota).toContain("[telefono]");
    expect(limpio.anidado.authorization).toBe(MARCA_REDACTADO);
    expect(limpio.anidado.ok).toBe("texto");
  });

  it("claveSensibleSoloTexto conserva numeros/booleanos aunque la clave suene sensible (inputTokens)", () => {
    const limpio = scrubValor({ inputTokens: 300, token: "abc", firmado: true }, OPCIONES_LOGS) as Record<string, unknown>;
    expect(limpio.inputTokens).toBe(300);
    expect(limpio.token).toBe(MARCA_REDACTADO);
    expect(limpio.firmado).toBe(true);
  });

  it("respeta topes de profundidad y de elementos, y no lanza con ciclos", () => {
    const ciclo: Record<string, unknown> = { a: 1 };
    ciclo.yo = ciclo;
    expect(() => scrubValor(ciclo)).not.toThrow();
    const arr = scrubValor(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(arr.length).toBe(20);
  });

  it("errores: 'mensaje' reduce a texto; 'detallado' conserva nombre, code y detail redactado", () => {
    const err = Object.assign(new Error("duplicate key para ana@example.com"), { code: "23505", detail: "Key (email)=(ana@example.com) already exists." });
    expect(scrubValor(err, { errores: "mensaje" })).toBe("duplicate key para [correo]");
    const detallado = scrubValor(err, OPCIONES_LOGS) as { name: string; code: string };
    expect(detallado.name).toBe("Error");
    expect(detallado.code).toBe("23505");
    expect(JSON.stringify(detallado)).not.toContain("ana@example.com");
  });

  it("Date -> ISO, bigint -> texto", () => {
    expect(scrubValor(new Date("2026-09-30T00:00:00.000Z"))).toBe("2026-09-30T00:00:00.000Z");
    expect(scrubValor(10n)).toBe("10");
  });
});

describe("scrubError", () => {
  it("redacta mensaje y stack", () => {
    const err = new Error(`fallo con ${jwtFalso}`);
    const d = scrubError(err);
    expect(JSON.stringify(d)).not.toContain(jwtFalso.slice(0, 12));
  });
});
