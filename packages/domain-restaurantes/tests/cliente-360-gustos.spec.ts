// Cliente 360: gustos derivados de pedidos CONFIRMADOS (no de lo que supone el modelo) y propuestos de forma explicable.
import { describe, expect, it } from "vitest";
import { describirGusto, extraerDomicilio, extraerObservaciones, MIN_VECES_PARA_PROPONER, proponerGustos } from "../src/cliente-360/gustos.ts";
import type { CustomerPreference, PreferenceKind } from "../src/cliente-360/types.ts";

function pref(kind: PreferenceKind, value: string, timesSeen: number, lastSeenAt: string, extra: Partial<CustomerPreference> = {}): CustomerPreference {
  return { id: `${kind}-${value}`, kind, value, source: "pedido", timesSeen, firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt, status: "activa", ...extra };
}

describe("extraerObservaciones", () => {
  it("toma tortilla, salsas, omisiones, nota corta, pago, propina, canal y sucursal de lo que el cliente pidio", () => {
    const obs = extraerObservaciones({
      items: [
        { id: "a", name: "Tacos", price: 100, quantity: 1, tortilla: "harina" },
        { id: "b", name: "Coca", price: 40, quantity: 1 },
      ],
      input: { requestedComplements: ["salsa_habanero"], doubleSalsas: ["salsa_verde"], omitDefaultComplements: ["cebolla"], notes: "Sin cebolla, por favor", paymentMethod: "tarjeta", canal: "domicilio", propina: 20 },
      branchName: "Francisco de Montejo",
    });
    const claves = obs.map((o) => `${o.kind}:${o.value}`).sort();
    expect(claves).toEqual(
      [
        "canal:domicilio",
        "nota:sin cebolla, por favor",
        "omision:cebolla_cilantro",
        "pago:tarjeta",
        "propina:20",
        "salsa:salsa_habanero",
        "salsa:salsa_verde",
        "sucursal:francisco de montejo",
        "tortilla:harina",
      ].sort(),
    );
  });

  it("una nota larga (un parrafo) no es un gusto y un pedido sin nada especial solo aporta lo estable", () => {
    const obs = extraerObservaciones({ items: [{ id: "b", name: "Coca", price: 40, quantity: 1 }], input: { notes: "x".repeat(150), paymentMethod: "efectivo" }, branchName: null });
    expect(obs.map((o) => o.kind)).toEqual(["pago"]);
  });
});

describe("extraerDomicilio", () => {
  it("sin direccion (recoger) no hay domicilio que guardar", () => {
    expect(extraerDomicilio({ customerAddress: undefined }, "p1")).toBeNull();
  });

  it("descarta un link de Maps que no es https y conserva etiqueta, referencias, colonia y sucursal", () => {
    const sinLink = extraerDomicilio({ customerAddress: "Calle 1 #2", mapsUrl: "http://inseguro.example.com/x", addressLabel: "casa", accessNotes: "porton verde", colonia: "Centro" }, "p1");
    expect(sinLink).toEqual({ address: "Calle 1 #2", label: "casa", accessNotes: "porton verde", colonia: "Centro", propertyId: "p1" });
    const conLink = extraerDomicilio({ customerAddress: "Calle 1 #2", mapsUrl: "https://maps.example.com/x" }, null);
    expect(conLink?.mapsUrl).toBe("https://maps.example.com/x");
  });
});

describe("proponerGustos", () => {
  it("una sola vez no es un gusto: no se propone", () => {
    expect(proponerGustos([pref("tortilla", "harina", 1, "2026-03-01T00:00:00Z")])).toEqual([]);
  });

  it("propone lo visto 2 o mas veces, con su fuente y conteo", () => {
    const [p] = proponerGustos([pref("tortilla", "maiz", MIN_VECES_PARA_PROPONER, "2026-03-01T00:00:00Z")]);
    expect(p).toMatchObject({ kind: "tortilla", value: "maiz", veces: 2, fuente: "pedido" });
    expect(describirGusto(p!)).toBe("tortilla: maiz (2 veces)");
  });

  it("gusto cambiado: gana el mas reciente cuando ya lo confirmo 2 veces, aunque el viejo se haya visto mas", () => {
    const props = proponerGustos([pref("tortilla", "maiz", 5, "2026-02-01T00:00:00Z"), pref("tortilla", "harina", 2, "2026-03-05T00:00:00Z")]);
    expect(props.map((p) => p.value)).toEqual(["harina"]);
  });

  it("si lo nuevo solo se vio una vez, sigue ganando el de siempre (el agente pregunta, no supone)", () => {
    const props = proponerGustos([pref("tortilla", "maiz", 5, "2026-02-01T00:00:00Z"), pref("tortilla", "harina", 1, "2026-03-05T00:00:00Z")]);
    expect(props.map((p) => p.value)).toEqual(["maiz"]);
  });

  it("nunca propone un gusto descartado y siempre propone el que escribio el staff", () => {
    const props = proponerGustos([
      pref("salsa", "salsa_verde", 4, "2026-03-01T00:00:00Z", { status: "descartada" }),
      pref("nota", "sin cebolla", 1, "2026-03-01T00:00:00Z", { source: "staff" }),
    ]);
    expect(props.map((p) => `${p.kind}:${p.value}:${p.fuente}`)).toEqual(["nota:sin cebolla:staff"]);
    expect(describirGusto(props[0]!)).toBe("nota: sin cebolla (anotado por el restaurante)");
  });

  it("de varias salsas propone como maximo 3, las mas vistas", () => {
    const salsas = ["a", "b", "c", "d", "e"].map((v, i) => pref("salsa", `salsa_${v}`, 2 + i, "2026-03-01T00:00:00Z"));
    const props = proponerGustos(salsas);
    expect(props).toHaveLength(3);
    expect(props[0]!.value).toBe("salsa_e");
  });
});
