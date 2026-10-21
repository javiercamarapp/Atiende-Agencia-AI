// PAQUETE A (PM): gancho de cliente recurrente («¿lo de siempre?»). Solo diseño: sin datos reales. S20 y S21 sintéticos.
import { describe, expect, it } from "vitest";
import { esLoDeSiempre, planReconocimientoRecurrente, proveedorClientesSinDatos } from "../src/cliente-360/reconocer-recurrente.ts";

describe("esLoDeSiempre", () => {
  it.each(["Lo mismo de siempre, cambio de 500", "lo de siempre", "Lo mismo", "repite mi último pedido", "igual que la vez pasada"])("sí: %s", (t) => {
    expect(esLoDeSiempre(t)).toBe(true);
  });
  it.each(["quiero 3 tacos", "siempre me mandan frío", "hola"])("no: %s", (t) => {
    expect(esLoDeSiempre(t)).toBe(false);
  });
});

describe("planReconocimientoRecurrente", () => {
  const base = { telefono: "9990000000", texto: "lo mismo de siempre" };
  it("el proveedor vacío (sin base de clientes) devuelve null y nunca inventa", async () => {
    expect(await proveedorClientesSinDatos.buscarPorTelefono("9990000000")).toBeNull();
  });
  it("S21: número no registrado + «lo mismo» -> no inventa historial, pide pedido completo y registra nuevo", () => {
    const p = planReconocimientoRecurrente({ ...base, cliente: null });
    expect(p.accion).toBe("pedir_pedido_completo");
    expect(p.registrarClienteNuevo).toBe(true);
    expect(p.mensajeGuia).toMatch(/no tengo registrado/i);
    expect(p.recotizarConMenuVigente).toBe(false);
  });
  it("S20: cliente con pedido anterior -> propone, recotiza con menú vigente y confirma antes de cocina", () => {
    const p = planReconocimientoRecurrente({
      ...base,
      cliente: { direccionGuardada: "Calle Ficticia 1, Colonia Ejemplo", ultimoPedido: { items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 1 }] } },
    });
    expect(p.accion).toBe("proponer_lo_de_siempre");
    expect(p.recotizarConMenuVigente).toBe(true);
    expect(p.confirmarAntesDeCocina).toBe(true);
    expect(p.confirmarDireccion).toBe("Calle Ficticia 1, Colonia Ejemplo");
    expect(p.mensajeGuia).not.toMatch(/\$\d/);
  });
  it("cliente conocido sin pedido anterior: no hay «de siempre»", () => {
    const p = planReconocimientoRecurrente({ ...base, cliente: { direccionGuardada: "Calle Ficticia 1", ultimoPedido: null } });
    expect(p.accion).toBe("pedir_pedido_completo");
    expect(p.registrarClienteNuevo).toBe(false);
  });
  it("sin la frase y cliente conocido: confirma dirección guardada", () => {
    const p = planReconocimientoRecurrente({ telefono: "9990000000", texto: "hola", cliente: { direccionGuardada: "Calle Ficticia 1", ultimoPedido: null } });
    expect(p.accion).toBe("confirmar_direccion");
  });
  it("sin teléfono: lo primero es pedirlo", () => {
    expect(planReconocimientoRecurrente({ telefono: null, texto: "hola", cliente: null }).accion).toBe("preguntar_telefono");
  });
});
