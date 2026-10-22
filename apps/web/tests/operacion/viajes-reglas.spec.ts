import { describe, expect, it } from "vitest";
import { alternarSeleccion, choferInicial, depurarSeleccion, desdeEstadoDe, etiquetaChofer, MAX_LOTE, mensajesLote, resumirLote, textoBotonSalio, textoEstadoCambio } from "../../src/verticals/restaurantes/lib/viajes.ts";
import { MAX_PEDIDOS_POR_VIAJE } from "@atiende/domain-restaurantes/operacion";

const chofer = (id: string, extra = {}) => ({ id, nombre: id, activos: 0, disponible: true, sugerido: false, ...extra });

describe("reglas de Viajes", () => {
  it("el lote coincide con el contrato y topa en 6", () => {
    expect(MAX_LOTE).toBe(MAX_PEDIDOS_POR_VIAJE);
    let sel: readonly string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) sel = alternarSeleccion(sel, id);
    expect(sel).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(alternarSeleccion(sel, "c")).toEqual(["a", "b", "d", "e", "f"]);
  });
  it("depura lo que ya no esta por salir sin cambiar la referencia si nada cambia", () => {
    const sel = ["a", "b"];
    expect(depurarSeleccion(sel, ["a", "b", "z"])).toBe(sel);
    expect(depurarSeleccion(sel, ["b"])).toEqual(["b"]);
  });
  it("chofer inicial: sugerido y disponible, luego primero disponible, luego nadie", () => {
    expect(choferInicial([chofer("x"), chofer("y", { sugerido: true })])).toBe("y");
    expect(choferInicial([chofer("x", { disponible: false }), chofer("y")])).toBe("y");
    expect(choferInicial([chofer("x", { disponible: false })])).toBeNull();
    expect(choferInicial([])).toBeNull();
  });
  it("etiquetas", () => {
    expect(etiquetaChofer(chofer("Luis", { activos: 2, sugerido: true }))).toBe("Luis (2 activos) · sugerido");
    expect(etiquetaChofer(chofer("Pedro", { activos: 1, disponible: false }))).toContain("fuera de turno");
    expect(textoBotonSalio(1)).toBe("Salió (1 pedido)");
    expect(textoBotonSalio(3)).toBe("Salió (3 pedidos)");
  });

  const lote = [
    { id: "a", numero: 146, estado: "preparando" },
    { id: "b", numero: 147, estado: "preparando" },
    { id: "c", numero: 148, estado: "preparando" },
  ];
  it("resumen del lote: solo cuenta como «salio» lo que vino despachado; lo que falta se nombra", () => {
    const r = resumirLote(lote, [
      { pedidoId: "a", resultado: "despachado", aviso: "encolado" },
      { pedidoId: "b", resultado: "ya_aplicado", aviso: "ya_enviado" },
    ]);
    expect(r).toMatchObject({ salieron: [146], yaEstaban: [147], sinRespuesta: [148], sinAviso: 0 });
    const m = mensajesLote(r, "Luis");
    expect(m.exito).toBe("El pedido #146 salió con Luis.");
    expect(m.atencion.join(" ")).toContain("#148");
    expect(m.atencion.join(" ")).toContain("#147 ya estaba en camino con Luis");
  });
  it("contar sin aviso solo de los que salieron y reasignados", () => {
    const r = resumirLote(lote, [
      { pedidoId: "a", resultado: "despachado", aviso: "omitido:sin_consentimiento" },
      { pedidoId: "b", resultado: "reasignado", aviso: "omitido:sin_consentimiento" },
      { pedidoId: "c", resultado: "despachado", aviso: "encolado" },
    ]);
    expect(r.sinAviso).toBe(1);
    expect(r.reasignados).toEqual([147]);
    expect(mensajesLote(r, "Luis").exito).toContain("#146, #148");
  });
  it("sin ningun despachado no hay mensaje de exito", () => {
    expect(mensajesLote(resumirLote(lote, []), "Luis").exito).toBeNull();
  });
  it("409: nombra el pedido que cambio si el servidor lo dice", () => {
    expect(textoEstadoCambio(lote, { pedidoId: "b" })).toContain("#147");
    expect(textoEstadoCambio(lote, null)).toContain("Alguno de los pedidos");
  });
  it("desdeEstado usa el estado real: si alguno no esta preparando no se manda", () => {
    expect(desdeEstadoDe(lote)).toBe("preparando");
    expect(desdeEstadoDe([...lote, { id: "d", numero: 149, estado: "pending" }])).toBeUndefined();
    expect(desdeEstadoDe([])).toBeUndefined();
  });
});
