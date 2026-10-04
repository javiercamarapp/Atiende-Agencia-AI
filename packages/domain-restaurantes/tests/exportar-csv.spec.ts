// R-17: formato del CSV de exportacion (BOM, separador, escapes, zona horaria, dinero plano, defensa contra formulas) y sus columnas.
import { describe, expect, it } from "vitest";
import { COLUMNAS_CLIENTES, COLUMNAS_HISTORIAL, CSV_BOM, celdaCsv, csvDesdeFilas, dineroPlano, fechaHoraLocal } from "../src/exportar/index.ts";
import type { FilaHistorial } from "../src/exportar/index.ts";
import type { Customer, Order } from "../src/types.ts";

function pedido(parcial: Partial<Order> = {}): Order {
  return {
    id: "a1b2c3d4-0000-4000-8000-000000000001", organizationId: "o", propertyId: "p", customerId: null, customerName: "Marisol Pech", customerPhone: "9991234567", customerAddress: null, customerEmail: null,
    branch: "Centro", total: 150.5, status: "entregado", items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", callTranscript: null, callRecordingUrl: null,
    dedupeFingerprint: null, idempotencyKey: null, createdAt: "2026-10-04T05:30:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, ...parcial,
  };
}

describe("celdaCsv", () => {
  it("entrecomilla coma, comilla, salto de linea y espacios en los extremos; duplica comillas", () => {
    expect(celdaCsv("Pech, Marisol")).toBe('"Pech, Marisol"');
    expect(celdaCsv('Dijo "hola"')).toBe('"Dijo ""hola"""');
    expect(celdaCsv("a\nb")).toBe('"a\nb"');
    expect(celdaCsv(" x ")).toBe('" x "');
    expect(celdaCsv("simple")).toBe("simple");
    expect(celdaCsv(null)).toBe("");
    expect(celdaCsv(undefined)).toBe("");
  });
  it("numeros sin simbolo ni separador de miles; no finitos vacios", () => {
    expect(celdaCsv(1234567.5)).toBe("1234567.5");
    expect(celdaCsv(Number.NaN)).toBe("");
  });
  it.each(["=SUM(A1:A9)", "+52 cmd", "-1+1", "@usuario", "\tx", "\rx"])("defensa contra formulas: %j se antepone con apostrofo", (t) => {
    expect(celdaCsv(t).replace(/^"|"$/g, "")).toMatch(/^'/);
  });
  it("un telefono con + inicial NO lleva apostrofo; un texto con + que no es telefono si", () => {
    expect(celdaCsv("+52 999 123 4567", { telefono: true })).toBe("+52 999 123 4567");
    expect(celdaCsv("+cmd|' /C calc'!A0", { telefono: true })).toMatch(/^"?'\+/);
    expect(celdaCsv("+52 (999) 123-4567", { telefono: true })).toBe("'+52 (999) 123-4567");
  });
  it("un numero con signo en columna numerica no se altera", () => {
    expect(celdaCsv("-5.00", { numerica: true })).toBe("-5.00");
    expect(celdaCsv("-5.00")).toBe("'-5.00");
  });
});

describe("csvDesdeFilas", () => {
  it("empieza con BOM UTF-8, usa coma y CRLF, y termina con salto de linea", () => {
    const csv = csvDesdeFilas(COLUMNAS_CLIENTES, [{ id: "1", organizationId: "o", phone: "9991234567", name: "Ñandú, José", orderCount: 3 } satisfies Customer]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}Nombre,Teléfono,Pedidos\r\n"Ñandú, José",9991234567,3\r\n`);
    const bytes = new TextEncoder().encode(csv);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it("sin filas: solo el encabezado", () => {
    expect(csvDesdeFilas(COLUMNAS_CLIENTES, [])).toBe(`${CSV_BOM}Nombre,Teléfono,Pedidos\r\n`);
  });
});

describe("fechas y dinero", () => {
  it("la fecha sale en la zona de la sucursal: 05:30Z es 23:30 del dia anterior en Mexico y ya es 18:30 en Auckland (+13)", () => {
    expect(fechaHoraLocal("2026-10-04T05:30:00.000Z", "America/Mexico_City")).toBe("2026-10-03 23:30");
    expect(fechaHoraLocal("2026-10-04T05:30:00.000Z", "Pacific/Auckland")).toBe("2026-10-04 18:30");
  });
  it("medianoche local se escribe 00:xx y no 24:xx", () => {
    expect(fechaHoraLocal("2026-10-04T06:05:00.000Z", "America/Mexico_City")).toBe("2026-10-04 00:05");
  });
  it("zona invalida cae a UTC; fecha invalida queda vacia", () => {
    expect(fechaHoraLocal("2026-10-04T05:30:00.000Z", "No/Existe")).toBe("2026-10-04 05:30");
    expect(fechaHoraLocal("no es fecha", "UTC")).toBe("");
  });
  it("dinero plano con dos decimales, sin simbolo ni miles", () => {
    expect(dineroPlano(150.5)).toBe("150.50");
    expect(dineroPlano(1234567.891)).toBe("1234567.89");
    expect(dineroPlano(0)).toBe("0.00");
  });
});

describe("columnas del Historial", () => {
  it("una fila completa: id corto, fecha local, etiquetas en espanol, telefono completo y total plano", () => {
    const fila: FilaHistorial = { order: pedido(), zonaHoraria: "America/Mexico_City", sucursal: "Centro" };
    const csv = csvDesdeFilas(COLUMNAS_HISTORIAL, [fila]);
    expect(csv.split("\r\n")[0]).toBe(`${CSV_BOM}Pedido,Fecha,Sucursal,Cliente,Teléfono,Canal,Estado,Pago,Total`);
    expect(csv.split("\r\n")[1]).toBe("A1B2C3D4,2026-10-03 23:30,Centro,Marisol Pech,9991234567,WhatsApp,Entregado,Efectivo,150.50");
  });
  it("un cliente que escribe una formula como nombre sale neutralizado", () => {
    const fila: FilaHistorial = { order: pedido({ customerName: '=HYPERLINK("http://x","clic")' }), zonaHoraria: "UTC", sucursal: "" };
    expect(csvDesdeFilas(COLUMNAS_HISTORIAL, [fila])).toContain(`"'=HYPERLINK(""http://x"",""clic"")"`);
  });
  it("pago sin metodo registrado sale vacio (no inventa)", () => {
    const csv = csvDesdeFilas(COLUMNAS_HISTORIAL, [{ order: pedido({ paymentMethod: null }), zonaHoraria: "UTC", sucursal: "" }]);
    expect(csv.split("\r\n")[1]).toContain(",Entregado,,150.50");
  });
});
