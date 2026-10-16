// R12 romper (ronda 2) -- categoria F (cierre de huecos): FORMATOS y TIPOS que el modelo o el cliente pueden mandar mal. Horas en formatos raros, plazos extremos, campos con el tipo
// equivocado, listas con otra forma, busquedas con caracteres especiales, sucursal que no reparte hoy o de otra organizacion. Herramientas y repositorio reales (en memoria).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRestaurantFixture, flujo, itemsCoca, ordenes, seedSecondTenant } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const err = (out: { result: unknown }) => JSON.stringify(out.result).match(/"error":"([^"]*)"/)?.[1];

async function horario(f: Fixture) {
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
}

describe("R12-F1 horas en formatos raros (hora_recogida / programado_para)", () => {
  const raras = [
    "13:30", "1:30 pm", "2026-10-06", "2026-10-06T13:30", "20261006T1330-0600", "1790000000", "1790000000000", "mañana a las 3", "ahorita", "2026-10-06T13:30:00 ; drop table",
    "2026-10-06T13:30:00+25:00", "2026-10-06T25:00:00-06:00", "2026-13-06T13:30:00-06:00", "２０２６-10-06T13:30:00-06:00", "0001-01-01T00:00:00Z", "+275760-09-13T00:00:00.000Z",
    "2026-10-06T13:30:00-06:00\u0000", "2026-10-06T13:30:00-06:00 (hora de la sucursal)", "2026-10-06T13:30 PM-06:00",
  ];
  it.each(raras)("hora_recogida «%s»: se rechaza (o se interpreta sin ambiguedad dentro de hoy) y nunca crea una hora absurda", async (valor) => {
    const f = buildRestaurantFixture();
    await horario(f);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(2, { hora_recogida: valor }));
    if (err(out)) return; // rechazada: correcto
    // Si se acepto, la hora cotizada tiene que estar dentro de la ventana de hoy (no una hora de otro dia ni del pasado).
    const hora = Date.parse(String(valor).replace(/\s*\(.*\)$/, ""));
    expect(Number.isNaN(hora) ? 0 : Math.abs(hora - Date.now()), valor).toBeLessThan(13 * 3_600_000);
  });

  it.each(raras.filter((v) => !/^2026-10-06T13:30:00-06:00/.test(v)))("programado_para «%s»: se rechaza (exige ISO 8601 con zona)", async (valor) => {
    const f = buildRestaurantFixture();
    await horario(f);
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: valor }))), valor).toBeTruthy();
  });

  it("(control) la misma hora bien formada, con 'Z' o con offset sin dos puntos, se acepta y es el mismo instante", async () => {
    const f = buildRestaurantFixture();
    await horario(f);
    const s = flujo(f);
    for (const iso of ["2026-10-07T20:00:00Z", "2026-10-07T14:00:00-0600", "2026-10-07T14:00:00-06:00", "2026-10-07T14:00:00.000-06:00"]) {
      expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: iso }))), iso).toBeUndefined();
    }
  });
});

describe("R12-F2 plazos extremos (minutos_para_recoger)", () => {
  it.each([[-5], [-1e9], [0], [1e9], [Number.NaN], [Number.POSITIVE_INFINITY], ["40"], ["abc"], [40.7], [true], [{}], [[]]])("minutos_para_recoger %j: no lanza y nunca deja una hora fuera de la ventana de hoy", async (minutos) => {
    const f = buildRestaurantFixture();
    await horario(f);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", s.base(2, { minutos_para_recoger: minutos }));
    expect(out).toBeDefined();
    if (!err(out)) {
      const hora = (out.result as { quote?: { hora_recogida?: string } }).quote?.hora_recogida;
      if (hora) expect(Math.abs(Date.parse(hora) - Date.now())).toBeLessThan(13 * 3_600_000);
    }
    expect(await ordenes(f)).toHaveLength(0);
  });
});

describe("R12-F3 campos con el tipo equivocado en crear_pedido", () => {
  async function creaCon(extra: Record<string, unknown>) {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo", ...extra });
    return { out, orden: (await ordenes(f))[0] };
  }

  it.each([[12345], [null], [[]], [""], ["   "], ["Cliente"], ["<script>alert(1)</script>"], ["Ana'; DROP TABLE orders;--"]])("customer_name %j: no se guarda como nombre del cliente", async (nombre) => {
    const { orden } = await creaCon({ customer_name: nombre });
    expect(orden, JSON.stringify(nombre)).toBeUndefined();
  });

  // R12-16 (P2): un objeto / arreglo / booleano no es un nombre; `String(...)` los guardaba como «[object Object]», «Ana,Beto» o «true» en la comanda.
  for (const [etiqueta, nombre] of [["objeto", { a: 1 }], ["arreglo", ["Ana", "Beto"]], ["booleano", true]] as const) {
    it(`R12-16 [P2, corregido] customer_name ${etiqueta}: no se guarda como nombre del cliente`, async () => {
      const { orden } = await creaCon({ customer_name: nombre });
      expect(orden).toBeUndefined();
    });
  }

  it("(control) un nombre normal, con acentos y apostrofe, si se guarda", async () => {
    const { orden } = await creaCon({ customer_name: "José O'Brien Núñez" });
    expect(orden?.customerName).toBe("José O'Brien Núñez");
  });

  it.each([[{ a: 1 }], [["fco-montejo"]], [true], [12345], [null], [""], ["  FCO-MONTEJO  "], ["fco‑montejo"]])("branch_slug %j: o se resuelve a la sucursal correcta o se rechaza; nunca crea el pedido en otra", async (slug) => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { branch_slug: slug, canal: "recoger", items: itemsCoca(f, 2) });
    expect(out).toBeDefined();
    if (!err(out)) expect(JSON.stringify(out.result)).toMatch(/"total":90/);
  });

  it.each([["items como texto", "dos coca"], ["items como objeto", { 0: itemsCoca(buildRestaurantFixture(), 1)[0] }], ["items null", null], ["items arreglo de nulls", [null, null]], ["items arreglo de numeros", [1, 2, 3]], ["items vacio", []]])(
    "%s: error accionable, cero pedidos",
    async (_n, items) => {
      const f = buildRestaurantFixture();
      const s = flujo(f);
      const out = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items });
      expect(err(out)).toBeTruthy();
      expect(await ordenes(f)).toHaveLength(0);
    },
  );
});

describe("R12-F4 busquedas con caracteres especiales", () => {
  it.each(["(((", "[a-", "\\", ".*", "(?<=x)", "a{1,", "tacos\u0000", "%", "_", "'; select 1;--", "<img src=x>", "𝕥𝕒𝕔𝕠𝕤", "🌮".repeat(500), "a ".repeat(3000)])(
    "buscar_producto con «%s»: no lanza, es rapido y devuelve una lista (posiblemente vacia)",
    async (consulta) => {
      const f = buildRestaurantFixture();
      const s = flujo(f);
      const t0 = Date.now();
      const out = await s.seguro("buscar_producto", { query: consulta, branch_slug: "fco-montejo" });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(JSON.stringify(out.result)).not.toMatch(/Error interno/);
    },
  );
});

describe("R12-F5 sucursal que no reparte hoy, inactiva o de otra organizacion", () => {
  it("una sucursal que NO acepta domicilio rechaza el domicilio y ofrece recoger; recoger si pasa", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { aceptaDomicilio: false });
    const s = flujo(f);
    const dom = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Centro", items: itemsCoca(f, 2) });
    expect(err(dom)).toMatch(/domicilio|recoger/i);
    expect(err(await s.seguro("cotizar_pedido", s.base(2)))).toBeUndefined();
  });

  it("una sucursal que reparte solo ciertos dias (hoy martes no) rechaza el domicilio de hoy y nombra los dias", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { diasDomicilio: [4, 5, 6] });
    const s = flujo(f);
    const dom = await s.seguro("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Centro", items: itemsCoca(f, 2) });
    expect(err(dom)).toMatch(/jueves|viernes|d[ií]as|domicilio/i);
  });

  it("una sucursal INACTIVA no cotiza ni crea", async () => {
    const f = buildRestaurantFixture();
    const rama = (await f.repo.listBranchesForOrganizationAdmin(f.organizationId)).find((b) => b.propertyId === f.propertyId)!;
    f.repo.seedBranch({ ...rama, status: "inactive" });
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(2)))).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("la sucursal de OTRA organizacion (slug valido en la base) no se puede usar desde esta", async () => {
    const f = buildRestaurantFixture();
    seedSecondTenant(f.repo);
    const s = flujo(f);
    const out = await s.seguro("cotizar_pedido", { branch_slug: "ajena", canal: "recoger", items: itemsCoca(f, 2) });
    expect(err(out)).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("el pedido minimo por canal se respeta: por debajo se rechaza con el faltante; justo en el minimo pasa", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoRecoger: 90 });
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(1)))).toMatch(/m[ií]nimo/i);
    expect(err(await s.seguro("cotizar_pedido", s.base(2)))).toBeUndefined();
  });
});
