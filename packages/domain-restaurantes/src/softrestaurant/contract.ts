// Suite de pruebas de CONTRATO de SoftRestaurantPort, reutilizable.
//
// La corre el adaptador falso (tests/softrestaurant-fake-contract.spec.ts) y la DEBE
// correr el adaptador real cuando llegue la API del distribuidor (contra un sandbox
// o contra un POS de prueba), sin cambios en dominio ni rutas:
//
//   import { runSoftRestaurantPortContract } from "@atiende/domain-restaurantes/softrestaurant/contract";
//   runSoftRestaurantPortContract("SoftRestaurantHttpAdapter (sandbox)", async () => ({
//     port: new SoftRestaurantHttpAdapter(...),
//     codigoValido: { producto: "<codigo real de prueba>", modificador: "<opcional>" },
//     // `fallas` solo si el sandbox sabe provocarlas; sin ellas se omiten esas pruebas.
//   }));
//
// Importa `vitest`, asi que SOLO debe cargarse desde archivos de prueba (nunca desde
// codigo de produccion; no esta exportada por el index del paquete).
import { describe, expect, it } from "vitest";
import type { ComandaInput, ComandaResultado, SoftRestaurantPort } from "./types.ts";

export interface ArnesContrato {
  readonly port: SoftRestaurantPort;
  /** Codigos que el POS de prueba SI conoce. */
  readonly codigoValido: { readonly producto: string; readonly modificador?: string };
  /** Sucursal con la que se prueba (default T1). */
  readonly sucursal?: "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8";
  /** Provocadores de fallas del POS. Opcionales: si faltan, se omiten esas pruebas. */
  readonly fallas?: {
    timeout?(): void;
    http5xx?(): void;
    /** El POS crea la comanda pero la respuesta se pierde. */
    duplicado?(): void;
    productoInexistente?(): void;
  };
}

let secuencia = 0;

function llaveUnica(prefijo: string): string {
  secuencia += 1;
  return `contrato-${prefijo}-${secuencia}-${Date.now().toString(36)}`;
}

function comandaBase(arnes: ArnesContrato, parcial: Partial<ComandaInput> = {}): ComandaInput {
  return {
    idempotencyKey: llaveUnica("c"),
    sucursal: arnes.sucursal ?? "T1",
    tipo: "domicilio",
    cliente: { nombre: "Cliente de Contrato", telefono: "9995550101" },
    direccion: { texto: "Calle 60 #123, Centro", colonia: "Centro", referencias: "Porton negro, frente al parque" },
    formaPago: "efectivo",
    items: [{ codigo: arnes.codigoValido.producto, cantidad: 2, modificadores: [] }],
    ...parcial,
  };
}

function esCreada(r: ComandaResultado): r is Extract<ComandaResultado, { status: "creada" }> {
  return r.status === "creada";
}

export function runSoftRestaurantPortContract(nombreAdaptador: string, crearArnes: () => ArnesContrato | Promise<ArnesContrato>): void {
  describe(`SoftRestaurantPort contrato: ${nombreAdaptador}`, () => {
    it("declara nombre y si es real", async () => {
      const { port } = await crearArnes();
      expect(typeof port.nombre).toBe("string");
      expect(port.nombre.length).toBeGreaterThan(0);
      expect(typeof port.esReal).toBe("boolean");
    });

    it("syncCatalog devuelve items con codigo unico y precio >= 0; solo el falso marca sintetico", async () => {
      const arnes = await crearArnes();
      const cat = await arnes.port.syncCatalog(arnes.sucursal ?? "T1");
      expect(cat.sucursal).toBe(arnes.sucursal ?? "T1");
      expect(cat.items.length).toBeGreaterThan(0);
      const codigos = cat.items.map((i) => i.codigo);
      expect(new Set(codigos).size).toBe(codigos.length);
      for (const item of cat.items) {
        expect(item.codigo.trim()).not.toBe("");
        expect(item.precio).toBeGreaterThanOrEqual(0);
      }
      if (arnes.port.esReal) expect(cat.sintetico).toBe(false);
      expect(() => new Date(cat.generadoEn).toISOString()).not.toThrow();
    });

    it("crearComanda crea la comanda y devuelve folio no vacio, sin duplicada", async () => {
      const arnes = await crearArnes();
      const r = await arnes.port.crearComanda(comandaBase(arnes));
      expect(r.status).toBe("creada");
      if (!esCreada(r)) return;
      expect(r.folio.trim()).not.toBe("");
      expect(r.duplicada).toBe(false);
      expect(typeof r.impresaEnCocina).toBe("boolean");
    });

    it("es idempotente por idempotencyKey: mismo folio, duplicada=true, sin comanda nueva", async () => {
      const arnes = await crearArnes();
      const input = comandaBase(arnes);
      const a = await arnes.port.crearComanda(input);
      const b = await arnes.port.crearComanda(input);
      expect(esCreada(a) && esCreada(b)).toBe(true);
      if (!esCreada(a) || !esCreada(b)) return;
      expect(b.folio).toBe(a.folio);
      expect(b.duplicada).toBe(true);
      const c = await arnes.port.crearComanda(comandaBase(arnes));
      expect(esCreada(c) && c.folio !== a.folio).toBe(true);
    });

    it("NUNCA cobra: la cuenta recien creada no esta cobrada", async () => {
      const arnes = await crearArnes();
      const r = await arnes.port.crearComanda(comandaBase(arnes));
      if (!esCreada(r)) throw new Error("se esperaba creada");
      const estado = await arnes.port.obtenerEstadoComanda({ sucursal: arnes.sucursal ?? "T1", folio: r.folio });
      expect(estado.encontrada).toBe(true);
      if (estado.encontrada) {
        expect(["abierta", "en_preparacion", "lista"]).toContain(estado.estado);
        expect(estado.folio).toBe(r.folio);
      }
    });

    it("acepta recoger sin direccion, tarjeta con propina y modificadores validos", async () => {
      const arnes = await crearArnes();
      const recoger = await arnes.port.crearComanda(comandaBase(arnes, { tipo: "recoger", direccion: undefined }));
      expect(recoger.status).toBe("creada");
      const conPropina = await arnes.port.crearComanda(comandaBase(arnes, { formaPago: "tarjeta", propina: 25 }));
      expect(conPropina.status).toBe("creada");
      if (arnes.codigoValido.modificador) {
        const conMod = await arnes.port.crearComanda(
          comandaBase(arnes, { items: [{ codigo: arnes.codigoValido.producto, cantidad: 1, modificadores: [{ codigo: arnes.codigoValido.modificador }] }] }),
        );
        expect(conMod.status).toBe("creada");
      }
    });

    it("rechaza (sin lanzar) entradas invalidas: domicilio sin direccion, propina con efectivo, cantidad 0, sucursal invalida", async () => {
      const arnes = await crearArnes();
      const sinDireccion = await arnes.port.crearComanda(comandaBase(arnes, { direccion: undefined }));
      expect(sinDireccion).toMatchObject({ status: "rechazada", motivo: "entrada_invalida" });
      const propinaEfectivo = await arnes.port.crearComanda(comandaBase(arnes, { formaPago: "efectivo", propina: 10 }));
      expect(propinaEfectivo).toMatchObject({ status: "rechazada", motivo: "entrada_invalida" });
      const cantidadCero = await arnes.port.crearComanda(comandaBase(arnes, { items: [{ codigo: arnes.codigoValido.producto, cantidad: 0, modificadores: [] }] }));
      expect(cantidadCero).toMatchObject({ status: "rechazada", motivo: "entrada_invalida" });
      const sucursalMala = await arnes.port.crearComanda(comandaBase(arnes, { sucursal: "T99" as never }));
      expect(sucursalMala).toMatchObject({ status: "rechazada", motivo: "sucursal_invalida" });
    });

    it("rechaza un codigo de producto inexistente con producto_inexistente y lista los codigos", async () => {
      const arnes = await crearArnes();
      const r = await arnes.port.crearComanda(comandaBase(arnes, { items: [{ codigo: "NO-EXISTE-XYZ", cantidad: 1, modificadores: [] }] }));
      expect(r.status).toBe("rechazada");
      if (r.status === "rechazada") {
        expect(r.motivo).toBe("producto_inexistente");
        expect(r.codigos).toContain("NO-EXISTE-XYZ");
      }
    });

    it("obtenerEstadoComanda: folio desconocido => encontrada=false", async () => {
      const arnes = await crearArnes();
      const r = await arnes.port.obtenerEstadoComanda({ sucursal: arnes.sucursal ?? "T1", folio: "FOLIO-QUE-NO-EXISTE" });
      expect(r.encontrada).toBe(false);
    });

    it("obtenerHistorialPorTelefono: incluye lo creado, respeta el limite y devuelve [] para un telefono sin pedidos", async () => {
      const arnes = await crearArnes();
      const telefono = `999${String(Date.now()).slice(-7)}`;
      const folios: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await arnes.port.crearComanda(comandaBase(arnes, { cliente: { nombre: "Historial", telefono } }));
        if (esCreada(r)) folios.push(r.folio);
      }
      const hist = await arnes.port.obtenerHistorialPorTelefono({ telefono, limite: 2 });
      expect(hist.length).toBeLessThanOrEqual(2);
      expect(hist.length).toBeGreaterThan(0);
      expect(folios).toContain(hist[0]!.folio);
      const todos = await arnes.port.obtenerHistorialPorTelefono({ telefono, limite: 10 });
      expect(todos.map((h) => h.folio).sort()).toEqual(folios.slice().sort());
      const vacio = await arnes.port.obtenerHistorialPorTelefono({ telefono: "0000000000", limite: 5 });
      expect(vacio).toEqual([]);
    });

    it("salud reporta ok, latencia y fecha", async () => {
      const { port } = await crearArnes();
      const s = await port.salud();
      expect(typeof s.ok).toBe("boolean");
      expect(s.latenciaMs).toBeGreaterThanOrEqual(0);
      expect(() => new Date(s.chequeadoEn).toISOString()).not.toThrow();
    });

    describe("fallas del POS (solo si el arnes sabe provocarlas)", () => {
      it("timeout => no_disponible SIN folio, y el reintento crea la comanda (no duplicada)", async () => {
        const arnes = await crearArnes();
        if (!arnes.fallas?.timeout) return;
        const input = comandaBase(arnes);
        arnes.fallas.timeout();
        const r = await arnes.port.crearComanda(input);
        expect(r.status).toBe("no_disponible");
        expect(JSON.stringify(r)).not.toContain("folio");
        const retry = await arnes.port.crearComanda(input);
        expect(retry.status).toBe("creada");
        if (esCreada(retry)) expect(retry.duplicada).toBe(false);
      });

      it("5xx => no_disponible SIN folio", async () => {
        const arnes = await crearArnes();
        if (!arnes.fallas?.http5xx) return;
        arnes.fallas.http5xx();
        const r = await arnes.port.crearComanda(comandaBase(arnes));
        expect(r.status).toBe("no_disponible");
        expect(JSON.stringify(r)).not.toContain("folio");
      });

      it("respuesta perdida tras crear: el reintento devuelve el MISMO folio con duplicada=true (una sola comanda)", async () => {
        const arnes = await crearArnes();
        if (!arnes.fallas?.duplicado) return;
        const input = comandaBase(arnes, { cliente: { nombre: "Doble", telefono: `998${String(Date.now()).slice(-7)}` } });
        arnes.fallas.duplicado();
        const primero = await arnes.port.crearComanda(input);
        expect(primero.status).toBe("no_disponible");
        const retry = await arnes.port.crearComanda(input);
        expect(retry.status).toBe("creada");
        if (esCreada(retry)) expect(retry.duplicada).toBe(true);
        const hist = await arnes.port.obtenerHistorialPorTelefono({ telefono: input.cliente.telefono, limite: 10 });
        expect(hist.length).toBe(1);
      });

      it("producto inexistente (catalogo desfasado) => rechazada, no no_disponible", async () => {
        const arnes = await crearArnes();
        if (!arnes.fallas?.productoInexistente) return;
        arnes.fallas.productoInexistente();
        const r = await arnes.port.crearComanda(comandaBase(arnes));
        expect(r.status).toBe("rechazada");
        if (r.status === "rechazada") expect(r.motivo).toBe("producto_inexistente");
      });
    });
  });
}
