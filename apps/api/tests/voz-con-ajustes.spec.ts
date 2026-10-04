// El decorador del proveedor de voz aplica los ajustes de la organizacion a la sesion de vista previa sin tocar las rutas.
import { describe, expect, it } from "vitest";
import { FakeVoiceProvider, AJUSTES_AGENTE_POR_DEFECTO } from "@atiende/domain-restaurantes";
import type { VozSesionPreviewEntrada } from "@atiende/voice-core";
import { conAjustesDeVoz } from "../src/production/voz-con-ajustes.ts";

const ENTRADA: VozSesionPreviewEntrada = { organizationId: "org-1", propertyId: "p1", sessionId: "s1", voiceId: "Kore", comportamiento: "REGLAS DURAS: siempre de usted.", mensajeInicial: "Hola", ttlSegundos: 300, vertical: "restaurantes" };

class Espia extends FakeVoiceProvider {
  entradas: VozSesionPreviewEntrada[] = [];
  override async emitirSesionPreview(entrada: VozSesionPreviewEntrada) {
    this.entradas.push(entrada);
    return super.emitirSesionPreview(entrada);
  }
}

describe("conAjustesDeVoz", () => {
  it("hoteles, citas o una entrada sin vertical pasan directo: no consulta ajustes ni toca instruccion ni temperatura", async () => {
    for (const vertical of ["hoteles", "citas", undefined]) {
      const inner = new Espia();
      let consultas = 0;
      const p = conAjustesDeVoz(inner, async () => { consultas += 1; return { ajustes: { ...AJUSTES_AGENTE_POR_DEFECTO, vozTemperatura: 0.4 }, conocimientoTexto: "X" }; });
      await p.emitirSesionPreview({ ...ENTRADA, vertical });
      expect(consultas).toBe(0);
      expect(inner.entradas[0]!.comportamiento).toBe(ENTRADA.comportamiento);
      expect(inner.entradas[0]!.temperatura).toBeUndefined();
    }
  });

  it("anexa conocimiento (antes), reglas (despues) y habla (al final) y manda la temperatura", async () => {
    const inner = new Espia();
    const p = conAjustesDeVoz(inner, async () => ({ ajustes: { ...AJUSTES_AGENTE_POR_DEFECTO, vozTemperatura: 0.4, vozRitmo: "pausado", vozEstilo: "calido" }, conocimientoTexto: "CONOCIMIENTO DEL NEGOCIO: abrimos a las 12." }));
    await p.emitirSesionPreview(ENTRADA);
    const e = inner.entradas[0]!;
    expect(e.temperatura).toBe(0.4);
    expect(e.comportamiento.indexOf("CONOCIMIENTO DEL NEGOCIO")).toBeLessThan(e.comportamiento.indexOf("REGLAS DURAS"));
    expect(e.comportamiento.indexOf("REGLAS DURAS")).toBeLessThan(e.comportamiento.indexOf("ESTILO DE HABLA"));
    expect(e.voiceId).toBe("Kore");
    expect(e.mensajeInicial).toBe("Hola");
  });

  it("con los ajustes por omision y sin conocimiento la sesion sale igual de siempre (temperatura null = la del proveedor)", async () => {
    const inner = new Espia();
    await conAjustesDeVoz(inner, async () => ({ ajustes: AJUSTES_AGENTE_POR_DEFECTO, conocimientoTexto: "" })).emitirSesionPreview(ENTRADA);
    expect(inner.entradas[0]).toMatchObject({ comportamiento: ENTRADA.comportamiento, temperatura: null });
  });

  it("si el resolver falla o devuelve null, la sesion sale tal como la pidio la ruta (nunca se cae por esto)", async () => {
    const inner = new Espia();
    await conAjustesDeVoz(inner, async () => Promise.reject(new Error("db"))).emitirSesionPreview(ENTRADA);
    await conAjustesDeVoz(inner, async () => null).emitirSesionPreview(ENTRADA);
    expect(inner.entradas).toEqual([ENTRADA, ENTRADA]);
  });

  it("delega id, catalogo, salud y abrirLlamada; resuelve con la organizacion de la sesion", async () => {
    const inner = new Espia();
    const orgs: string[] = [];
    const p = conAjustesDeVoz(inner, async (org) => (orgs.push(org), null));
    expect(p.id).toBe(inner.id);
    expect(p.catalogoVoces()).toBe(inner.catalogoVoces());
    expect(await p.salud()).toEqual(await inner.salud());
    await p.emitirSesionPreview(ENTRADA);
    expect(orgs).toEqual(["org-1"]);
  });
});
