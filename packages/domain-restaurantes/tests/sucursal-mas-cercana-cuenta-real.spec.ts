// import-orig-01 (revision de #507) -- el ESTADO REAL de la cuenta de PM (fixture leido con SELECT el 7-oct-2026): sucursales con sus coordenadas VIGENTES (Pensiones
// sin coordenada, las demas desviadas 1.9 a 4.4 km), 189 colonias sin coordenadas con su referencia del piloto y la cobertura que de verdad tiene la base.
//
// Hallazgos que fijan estas pruebas, con la bandera de pines APAGADA (lo que queda en produccion):
//  1. Con pin y tope duro de 8 km, el agente decia «fuera de nuestra zona habitual» a clientes que SI estan dentro (22 falsos).
//  2. Con pin Y colonia con cobertura explicita del dueño, manda la cobertura (main ya lo hacia; el PR lo habia perdido).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { assignBranch } from "../src/branch-assignment.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { normalizeZoneText } from "../src/nearest-branch.ts";
import { aplicarReglasDeSucursal } from "../src/reglas-pedido.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

interface Estado {
  sucursales: Array<{ slug: string; nombre: string; status: "active" | "inactive"; lat: number | null; lng: number | null; aceptaDomicilio: boolean }>;
  zonas: Array<{ nombre: string; lat: number | null; lng: number | null; fuente: string | null; asignacionFuente: string | null; ref: [string | null, number | null, string | null, number | null]; cubren: string[] }>;
}
const estado = JSON.parse(readFileSync(new URL("./fixtures/cuenta-real-pm-estado.json", import.meta.url), "utf8")) as Estado;
const { data } = loadSeedInputs();
const ORG = "00000000-0000-4000-8000-000000000001";

async function cuentaReal(opts: { perfil?: "taqueria_pm" | "generico"; coordenadasColonia?: Map<string, { lat: number; lng: number }>; galeriasActiva?: boolean } = {}) {
  const repo = new InMemoryRestaurantesRepository();
  repo.seedOrganization({ id: ORG, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const props = new Map<string, string>();
  const nombres = new Map<string, string>();
  estado.sucursales.forEach((s, i) => {
    const propertyId = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`;
    props.set(s.slug, propertyId);
    nombres.set(s.slug, s.nombre);
    repo.seedBranch({ propertyId, organizationId: ORG, name: s.nombre, slug: s.slug, status: opts.galeriasActiva && s.slug === "galerias" ? "active" : s.status, phone: null, address: null, lat: s.lat, lng: s.lng });
    repo.seedBranchPolicy(propertyId, { aceptaDomicilio: s.aceptaDomicilio });
  });
  const cobertura = new Map<string, string[]>();
  const zonaId = new Map<string, string>();
  estado.zonas.forEach((z, i) => {
    const id = `00000000-0000-4000-8000-0000000002${String(i).padStart(3, "0")}`;
    zonaId.set(z.nombre, id);
    const c = opts.coordenadasColonia?.get(z.nombre);
    repo.seedKnownZone({ id, organizationId: ORG, name: z.nombre, lat: c ? c.lat : z.lat, lng: c ? c.lng : z.lng, fuente: z.fuente, asignacionFuente: z.asignacionFuente, refSucursalSlug: z.ref[0], refKm: z.ref[1], ref2SucursalSlug: z.ref[2], ref2Km: z.ref[3] });
    for (const slug of z.cubren) cobertura.set(slug, [...(cobertura.get(slug) ?? []), id]);
  });
  for (const [slug, ids] of cobertura) repo.seedBranchDeliveryZones(props.get(slug)!, ids);
  await repo.upsertWhatsAppAgentConfig(ORG, null, { perfil: opts.perfil ?? "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
  return { repo, props, nombres, zonaId };
}

/** Pin de cada colonia = su coordenada de Google en colonias-v3 (seed), emparejada con la zona REAL por nombre normalizado. */
const norm = normalizeZoneText;
const zonaPorNombre = new Map(estado.zonas.map((z) => [norm(z.nombre), z]));
const colonias = (data.colonias ?? []).flatMap((c) => {
  const zona = zonaPorNombre.get(norm(c.nombre));
  return zona && c.coordenada ? [{ nombre: zona.nombre, pin: { lat: c.coordenada.lat, lng: c.coordenada.lng }, cubren: zona.cubren, fueraV3: c.mas_cercana?.fuera_de_8km === true, v3: c }] : [];
});
const ctx = (flag: boolean) => ({ organizationId: ORG, channel: "whatsapp" as const, phone: "9991234567", usarCoordenadasPropuestas: flag });
const tool = async (repo: InMemoryRestaurantesRepository, flag: boolean, args: Record<string, unknown>) => (await invokeAgentTool(repo, ctx(flag), "buscar_sucursal_cercana", args)).result as Record<string, unknown>;

describe("estado real de la cuenta (fixture)", () => {
  it("es lo que vio el SELECT: Pensiones sin coordenada, 189 zonas sin coordenada propia (salvo 4), Galerias y Playa con acepta_domicilio=true pero inactivas", () => {
    const t3 = estado.sucursales.find((s) => s.slug === "pensiones")!;
    expect([t3.lat, t3.lng]).toEqual([null, null]);
    expect(estado.zonas.length).toBe(189);
    expect(estado.zonas.filter((z) => z.lat !== null).length).toBe(4);
    for (const slug of ["galerias", "playa"]) expect(estado.sucursales.find((s) => s.slug === slug)).toMatchObject({ status: "inactive", aceptaDomicilio: true });
    expect(colonias.length).toBeGreaterThan(150);
  });
});

describe("1. sin FALSOS «fuera de zona» con pin cuando las coordenadas vigentes no son confiables (bandera de pines apagada)", () => {
  it("colonia + pin de WhatsApp desde la propia colonia: 0 falsos `fuera_de_zona` (el PR sin esta correccion daba 22 falsos: 35 contra 13 de la verdad de colonias-v3)", async () => {
    const { repo } = await cuentaReal();
    // Falso = «fuera de zona» para una colonia cubierta por el dueño o que colonias-v3 pone a <= 8 km. Quedan los fuera de verdad (Chicxulub, Progreso... a > 20 km).
    const falsos: string[] = [];
    for (const c of colonias) {
      const r = await tool(repo, false, { colonia: c.nombre, ...c.pin });
      if (r.estado === "fuera_de_zona" && (c.cubren.length > 0 || !c.fueraV3)) falsos.push(c.nombre);
    }
    expect(falsos).toEqual([]);
  });

  it("las colonias cubiertas por el dueño (Caucel, Ciudad Caucel, Obrera, Gran Santa Fe II, Mulchechen... ) se atienden en la sucursal que las cubre, con pin o sin el", async () => {
    const { repo } = await cuentaReal();
    const cubiertas = colonias.filter((c) => c.cubren.length > 0);
    expect(cubiertas.length).toBeGreaterThan(100);
    for (const c of cubiertas) {
      const conPin = await tool(repo, false, { colonia: c.nombre, ...c.pin });
      const sinPin = await tool(repo, false, { colonia: c.nombre });
      for (const r of [conPin, sinPin]) {
        expect(r.estado, c.nombre).toBe("asignada");
        expect(c.cubren, `${c.nombre} -> ${String(r.branch_slug)}`).toContain(r.branch_slug);
        expect(r.origen_asignacion, c.nombre).toBe("cobertura_dueno");
      }
    }
  });

  it("Ciudad Caucel (cubierta por Pensiones, a 5 km segun v3) con el pin compartido de WhatsApp: Pensiones, y el servidor acepta domicilio ahi", async () => {
    const { repo, props } = await cuentaReal();
    const c = colonias.find((x) => norm(x.nombre) === norm("Ciudad Caucel"))!;
    expect(c.cubren).toEqual(["pensiones"]);
    const r = (await invokeAgentTool(repo, { ...ctx(false), sharedLocation: c.pin }, "buscar_sucursal_cercana", {})).result as Record<string, unknown>;
    // Solo el pin (sin colonia): sin medicion confiable se asigna como antes, SIN decir distancias ni «la mas cercana» ni «fuera de zona».
    expect(r.estado).toBe("asignada");
    expect(r.estado).not.toBe("fuera_de_zona");
    expect(r.medicion_aproximada).toBe(true);
    expect(r.distancia_texto).toBeNull();
    const pens = (await repo.listBranchesForOrganizationAdmin(ORG)).find((b) => b.slug === "pensiones")!;
    expect(props.get("pensiones")).toBe(pens.propertyId);
    await expect(aplicarReglasDeSucursal(repo, { branch: pens, canal: "domicilio", subtotal: 500, colonia: "Ciudad Caucel", source: "whatsapp" } as never)).resolves.toBeDefined();
  });

  it("las colonias `sugerida` (sin cobertura) con pin: «no la tengo ubicada con certeza», ni asignada ni fuera de zona, sin nombrar una «mas cercana»", async () => {
    const { repo } = await cuentaReal();
    const seis = ["Juan Pablo II", "México Poniente", "Opichén", "Santa María de Guadalupe", "Susula", "Sitpach"];
    for (const nombre of seis) {
      const c = colonias.find((x) => norm(x.nombre) === norm(nombre));
      if (!c) continue; // el fixture solo trae las que existen en la cuenta
      expect(c.cubren, nombre).toEqual([]);
      const r = await tool(repo, false, { colonia: nombre, ...c.pin });
      expect(r.estado, nombre).toBe("sugerida");
      expect(r.ubicacion_recibida, nombre).toBe(true);
      expect(String(r.mensaje), nombre).toMatch(/No la tengo ubicada con certeza: ¿me confirma su colonia y dirección\?/);
      expect(String(r.mensaje), nombre).not.toMatch(/más cercana|\d+ ?km/);
    }
  });

  it("un pin SOLO (sin colonia) con la medicion incompleta no corta por 8 km (tope laxo de siempre: 20 km) y no nombra «la mas cercana»; mas alla de 20 km si dice fuera de zona", async () => {
    const { repo } = await cuentaReal();
    const komchen = colonias.find((x) => norm(x.nombre) === norm("Komchen"))!;
    const r = await tool(repo, false, { ...komchen.pin });
    expect(r).toMatchObject({ encontrada: true, estado: "asignada", medicion_aproximada: true });
    const progreso = await tool(repo, false, { lat: 21.2817, lng: -89.665 });
    expect(progreso).toMatchObject({ encontrada: false, estado: "fuera_de_zona", medicion_aproximada: true });
    expect(progreso.sucursal_despacho_mas_cercana).toBeUndefined();
    expect(String(progreso.mensaje)).not.toMatch(/más cercana es/);
  });

  it("CON los pines de Google (bandera encendida) el corte de 8 km vuelve a ser duro y nombra la mas cercana: fuera de zona = solo las NO cubiertas de colonias-v3 que estan a > 8 km", async () => {
    const { repo } = await cuentaReal();
    const esperadas = colonias.filter((c) => c.cubren.length === 0 && c.fueraV3).map((c) => c.nombre).sort();
    const fuera: string[] = [];
    for (const c of colonias) {
      const r = await tool(repo, true, { colonia: c.nombre, ...c.pin });
      if (r.estado === "fuera_de_zona") {
        fuera.push(c.nombre);
        expect(r.sucursal_despacho_mas_cercana, c.nombre).toBeDefined();
        expect(String(r.mensaje), c.nombre).not.toMatch(/no reconozco/i);
      }
    }
    expect(fuera.sort()).toEqual(esperadas);
    expect(esperadas.length).toBeGreaterThanOrEqual(8);
  });
});

describe("2. cobertura explicita del dueño con pin + colonia (las 12 + 32 de Pensiones)", () => {
  // main respetaba la cobertura con pin en estas 12; el PR no.
  const DOCE = ["Azcorra", "Miraflores", "Morelos Oriente", "Real San José", "San José Vergel", "Vergel", "Vergel II", "Ceiba II", "Quinta Real", "Gran Santa Fe II", "Mulchechén", "Santa María Chí"];

  it.each(DOCE)("%s con pin y colonia: la sucursal que la cubre en la base real, con o sin los pines de Google", async (nombre) => {
    const { repo } = await cuentaReal();
    const z = estado.zonas.find((x) => norm(x.nombre) === norm(nombre));
    const c = colonias.find((x) => norm(x.nombre) === norm(nombre));
    expect(z && c, `${nombre} existe en la cuenta real y en colonias-v3`).toBeTruthy();
    expect(z!.cubren.length, nombre).toBeGreaterThan(0);
    for (const flag of [false, true]) {
      const r = await tool(repo, flag, { colonia: nombre, ...c!.pin });
      expect(r.estado, `${nombre} bandera=${flag}`).toBe("asignada");
      expect(z!.cubren, `${nombre} -> ${String(r.branch_slug)}`).toContain(r.branch_slug);
    }
  });

  it("las colonias de Pensiones (32+) con pin: Pensiones, no Garcia Lavin ni otra", async () => {
    const { repo } = await cuentaReal();
    const dePensiones = colonias.filter((c) => c.cubren.length === 1 && c.cubren[0] === "pensiones");
    expect(dePensiones.length).toBeGreaterThanOrEqual(32);
    for (const c of dePensiones) {
      for (const flag of [false, true]) expect(await tool(repo, flag, { colonia: c.nombre, ...c.pin }), `${c.nombre} bandera=${flag}`).toMatchObject({ estado: "asignada", branch_slug: "pensiones" });
    }
  });

  it("con override a mas de 8 km (Mulchechen T1 8.4, Salvador Alvarado Sur, Santa Maria Chi T8 9.4) escribir la colonia y dar el pin dan LA MISMA respuesta", async () => {
    const { repo } = await cuentaReal();
    for (const nombre of ["Mulchechén", "Santa María Chí", "Salvador Alvarado Sur"]) {
      const z = estado.zonas.find((x) => norm(x.nombre) === norm(nombre));
      const c = colonias.find((x) => norm(x.nombre) === norm(nombre));
      if (!z || !c || z.cubren.length === 0) continue;
      const escrita = await tool(repo, true, { colonia: nombre });
      const conPin = await tool(repo, true, { colonia: nombre, ...c.pin });
      expect(conPin.estado, nombre).toBe(escrita.estado);
      expect(conPin.branch_slug, nombre).toBe(escrita.branch_slug);
    }
  });

  it("la sucursal asignada es la que cubre la colonia: cotizar a domicilio ahi pasa para TODAS las cubiertas", async () => {
    const { repo } = await cuentaReal();
    const sucursales = await repo.listBranchesForOrganizationAdmin(ORG);
    for (const c of colonias.filter((x) => x.cubren.length > 0)) {
      const r = await tool(repo, false, { colonia: c.nombre, ...c.pin });
      const branch = sucursales.find((b) => b.slug === r.branch_slug)!;
      await expect(aplicarReglasDeSucursal(repo, { branch, canal: "domicilio", subtotal: 500, colonia: c.nombre, source: "whatsapp" } as never), c.nombre).resolves.toBeDefined();
    }
  });

  it("un pin que claramente NO esta en la colonia (otra sucursal dentro del radio fiable) gana sobre la cobertura: solo con los pines de Google", async () => {
    const { repo } = await cuentaReal();
    const cholul = colonias.find((x) => norm(x.nombre) === norm("Cholul"))!;
    // Una colonia cubierta SOLO por Francisco de Montejo, dicha junto a un pin en Cholul (9.6 km de T2, 2.4 km de Altabrisa).
    const deT2 = colonias.find((x) => x.cubren.length === 1 && x.cubren[0] === "fco-montejo")!;
    const r = await tool(repo, true, { colonia: deT2.nombre, ...cholul.pin });
    expect(r).toMatchObject({ estado: "asignada", branch_slug: "altabrisa", origen_asignacion: "pin" });
    // Con medicion incompleta no se puede afirmar: manda la cobertura del dueño.
    const sinPines = await tool(repo, false, { colonia: deT2.nombre, ...cholul.pin });
    expect(sinPines).toMatchObject({ estado: "asignada", branch_slug: "fco-montejo", origen_asignacion: "cobertura_dueno" });
  });
});

describe("colonia SIN cobertura nunca se dice «asignada» si el servidor la rechazara", () => {
  it("con coordenadas de colonia y pines propuestos: una colonia no cubierta en una sucursal con zonas cargadas es `sugerida` (antes `asignada` y luego rechazada al cotizar)", async () => {
    const coordenadas = new Map(colonias.map((c) => [c.nombre, c.pin]));
    const { repo } = await cuentaReal({ coordenadasColonia: coordenadas });
    const noCubiertas = colonias.filter((c) => c.cubren.length === 0 && !c.fueraV3);
    expect(noCubiertas.length).toBeGreaterThan(5);
    for (const c of noCubiertas) {
      const r = await tool(repo, true, { colonia: c.nombre });
      expect(r.estado, c.nombre).toBe("sugerida");
    }
  });
});

describe("Galerias y Playa no son sucursales de despacho aunque se reactiven", () => {
  it("con Galerias ACTIVA y acepta_domicilio=true (como esta en la base), el perfil PM no la asigna ni la nombra como despacho", async () => {
    const { repo } = await cuentaReal({ galeriasActiva: true });
    const galerias = (await repo.listBranchesForOrganizationAdmin(ORG)).find((b) => b.slug === "galerias")!;
    expect(galerias.status).toBe("active");
    // Galerias no tiene coordenadas vigentes: se prueba con sus filas de referencia del piloto. Una colonia cuya referencia la nombra primero NO la sugiere.
    const conGalerias = estado.zonas.filter((z) => z.ref[0] === "galerias" && z.cubren.length === 0);
    expect(conGalerias.length).toBeGreaterThan(0);
    for (const z of conGalerias) {
      const r = await assignBranch(repo, { organizationId: ORG, colonia: z.nombre, radioMaximoKm: 8, sucursalesQueNoReparten: ["galerias", "playa"] });
      const dicho = JSON.stringify(r);
      expect(dicho, z.nombre).not.toMatch(/"slug":"galerias"|"branchSlug":"galerias"/);
    }
    const r = await tool(repo, false, { colonia: conGalerias[0]!.nombre });
    expect(JSON.stringify(r)).not.toMatch(/galerias|Galer/i);
  });
});
