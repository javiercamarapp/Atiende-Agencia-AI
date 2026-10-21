// Reglas puras de «Mis entregas» del chofer: cambio, ventana de deshacer, desaparicion a los 2 min, destino del mapa y del telefono.
import { describe, expect, it } from "vitest";
import type { EntregaChofer } from "@atiende/domain-restaurantes/operacion";
import {
  VISIBLE_TRAS_ENTREGA_MS,
  cambioDe,
  enlaceTelefono,
  minutosEnCamino,
  registrarCerrados,
  segundosParaDeshacer,
  urlNavegar,
  visiblesEnPantalla,
} from "../src/verticals/restaurantes/lib/chofer-entregas.ts";

function entrega(parcial: Partial<EntregaChofer> = {}): EntregaChofer {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    numero: 145,
    estado: "en_camino",
    clienteNombre: "Ana R.",
    direccion: { texto: "Calle 60 #320", colonia: "Centro" },
    indicaciones: null,
    total: 708,
    pago: { forma: "efectivo", pagaCon: 1000 },
    resumenItems: "4 taquitos",
    totalPiezas: 4,
    salioAt: null,
    etaAt: null,
    minutos: 22,
    semaforo: "verde",
    ...parcial,
  };
}

describe("cambioDe", () => {
  it("calcula el cambio y redondea a centavos", () => {
    expect(cambioDe(708, 1000)).toBe(292);
    expect(cambioDe(99.9, 100)).toBe(0.1);
  });
  it("no inventa cambio si no paga con billete o no alcanza", () => {
    expect(cambioDe(708, null)).toBeNull();
    expect(cambioDe(708, 500)).toBeNull();
  });
});

describe("segundosParaDeshacer", () => {
  const ahora = Date.parse("2026-10-21T20:00:00.000Z");
  it("cuenta hacia atras y nunca pasa de 60 s ni baja de 0", () => {
    expect(segundosParaDeshacer("2026-10-21T20:00:42.000Z", ahora)).toBe(42);
    expect(segundosParaDeshacer("2026-10-21T20:05:00.000Z", ahora)).toBe(60);
    expect(segundosParaDeshacer("2026-10-21T19:59:00.000Z", ahora)).toBe(0);
  });
  it("sin limite del servidor devuelve null (no se ofrece deshacer a ciegas)", () => {
    expect(segundosParaDeshacer(null, ahora)).toBeNull();
    expect(segundosParaDeshacer("no-es-fecha", ahora)).toBeNull();
  });
});

describe("minutosEnCamino", () => {
  it("usa salioAt si existe y los minutos del servidor si no", () => {
    const ahora = Date.parse("2026-10-21T20:30:00.000Z");
    expect(minutosEnCamino({ salioAt: "2026-10-21T20:08:00.000Z", minutos: 3 }, ahora)).toBe(22);
    expect(minutosEnCamino({ salioAt: null, minutos: 17 }, ahora)).toBe(17);
  });
});

describe("desaparicion a los 2 min", () => {
  const t0 = 1_000_000;
  const activa = entrega({ id: "a" });
  const hecha = entrega({ id: "b", estado: "entregado" });

  it("estampa solo las cerradas, conserva la primera marca y descarta las que ya no vienen", () => {
    const m1 = registrarCerrados(new Map(), [activa, hecha], t0);
    expect([...m1.keys()]).toEqual(["b"]);
    const m2 = registrarCerrados(m1, [activa, hecha], t0 + 30_000);
    expect(m2.get("b")).toBe(t0);
    expect(registrarCerrados(m2, [activa], t0 + 40_000).size).toBe(0);
  });

  it("la entregada se ve hasta 2 min y despues se retira; la activa nunca", () => {
    const vistos = registrarCerrados(new Map(), [activa, hecha], t0);
    expect(visiblesEnPantalla([activa, hecha], vistos, t0 + VISIBLE_TRAS_ENTREGA_MS - 1).map((e) => e.id)).toEqual(["a", "b"]);
    expect(visiblesEnPantalla([activa, hecha], vistos, t0 + VISIBLE_TRAS_ENTREGA_MS).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("urlNavegar y enlaceTelefono", () => {
  it("arma la busqueda de mapa con texto y colonia, y rechaza una direccion vacia", () => {
    expect(urlNavegar({ texto: "Calle 60 #320", colonia: "Centro" })).toBe("https://www.google.com/maps/search/?api=1&query=Calle%2060%20%23320%2C%20Centro");
    expect(urlNavegar({ texto: "  ", colonia: null })).toBeNull();
  });
  it("solo acepta telefonos con digitos", () => {
    expect(enlaceTelefono("+52 999 123 4567")).toBe("tel:+529991234567");
    expect(enlaceTelefono("javascript:alert(1)")).toBeNull();
    expect(enlaceTelefono("123")).toBeNull();
  });
});
