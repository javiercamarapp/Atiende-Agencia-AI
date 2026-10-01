// R-33 -- checklist de onboarding calculado con datos REALES de la organizacion (no un estado guardado): cada punto sale del
// repositorio; lo que no se puede comprobar queda pendiente/externo con su responsable. Sin SQL nuevo: reutiliza lecturas ya
// protegidas con SAVEPOINT contra la base sin migrar.
import { describe, expect, it } from "vitest";
import { buildOnboardingChecklist, cargarOnboarding, type OnboardingBranchSnapshot, type OnboardingSnapshot } from "../src/onboarding.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();

const rama = (over: Partial<OnboardingBranchSnapshot> = {}): OnboardingBranchSnapshot => ({
  nombre: "Sucursal A",
  activa: true,
  conCoordenadas: true,
  productosDisponibles: 10,
  conHorario: true,
  dobleTurno: true,
  conPedidoMinimo: true,
  zonasDeEntrega: 3,
  conWhatsappPropio: true,
  ...over,
});
const COMPLETO: OnboardingSnapshot = { sucursales: [rama()], whatsappGeneral: true, agenteConfigurado: true, nombreDelAsistente: true, pedidos: 5 };
const item = (c: ReturnType<typeof buildOnboardingChecklist>, id: string) => c.items.find((i) => i.id === id)!;

describe("buildOnboardingChecklist (funcion pura)", () => {
  it("todo configurado: todos los puntos verificables en 'hecho', solo el catalogo del POS queda externo; listo para operar", () => {
    const c = buildOnboardingChecklist(COMPLETO);
    expect(c.items.filter((i) => i.estado !== "hecho").map((i) => i.id)).toEqual(["catalogo_pos"]);
    expect(item(c, "catalogo_pos")).toMatchObject({ estado: "externo", responsable: "distribuidor_pos" });
    expect(c.listoParaOperar).toBe(true);
    expect(c.resumen).toEqual({ hechos: c.items.length - 1, total: c.items.length, obligatoriosPendientes: 0 });
  });

  it("organizacion vacia: nada se da por hecho y el gate bloquea (sucursales, menu, horarios y agente son obligatorios)", () => {
    const c = buildOnboardingChecklist({ sucursales: [], whatsappGeneral: false, agenteConfigurado: false, nombreDelAsistente: false, pedidos: 0 });
    expect(c.listoParaOperar).toBe(false);
    for (const id of ["sucursales", "menu", "horarios", "agente_whatsapp"]) expect(item(c, id)).toMatchObject({ obligatorio: true, estado: "pendiente" });
    expect(c.items.filter((i) => i.estado === "hecho")).toHaveLength(0);
  });

  it("estado parcial y faltantes con nombre: una sucursal sin coordenadas, sin cobertura y sin numero propio", () => {
    const c = buildOnboardingChecklist({
      ...COMPLETO,
      sucursales: [rama({ nombre: "Altabrisa" }), rama({ nombre: "Pensiones", conCoordenadas: false, zonasDeEntrega: 0, conWhatsappPropio: false, dobleTurno: false })],
    });
    expect(item(c, "coordenadas")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"] });
    expect(item(c, "coordenadas").detalle).toContain("Pensiones");
    expect(item(c, "zonas_de_entrega")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"] });
    expect(item(c, "whatsapp")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"], responsable: "meta" });
    expect(item(c, "cambio_de_turno")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"], responsable: "dueno" });
    // Estos puntos NO bloquean la operacion (no son obligatorios): se muestran como pendientes visibles.
    expect(c.listoParaOperar).toBe(true);
  });

  it("whatsapp: sin ningun numero queda pendiente y avisa que la demo del widget no lo necesita; con numero general es parcial", () => {
    const sin = buildOnboardingChecklist({ ...COMPLETO, whatsappGeneral: false, sucursales: [rama({ conWhatsappPropio: false })] });
    expect(item(sin, "whatsapp").estado).toBe("pendiente");
    expect(item(sin, "whatsapp").detalle).toContain("widget");
    const general = buildOnboardingChecklist({ ...COMPLETO, whatsappGeneral: true, sucursales: [rama({ conWhatsappPropio: false })] });
    expect(item(general, "whatsapp").estado).toBe("parcial");
  });

  it("las sucursales inactivas no cuentan para el gate (T4 registrada pero inactiva)", () => {
    const c = buildOnboardingChecklist({ ...COMPLETO, sucursales: [rama(), rama({ nombre: "T4", activa: false, productosDisponibles: 0, conHorario: false, conCoordenadas: false })] });
    expect(item(c, "menu").estado).toBe("hecho");
    expect(item(c, "sucursales")).toMatchObject({ estado: "hecho", faltantes: ["T4"] });
    expect(c.listoParaOperar).toBe(true);
  });

  it("el nombre del asistente y el pedido de prueba salen de los datos", () => {
    const c = buildOnboardingChecklist({ ...COMPLETO, nombreDelAsistente: false, pedidos: 0 });
    expect(item(c, "nombre_del_asistente").estado).toBe("pendiente");
    expect(item(c, "pedido_de_prueba").estado).toBe("pendiente");
  });
});

describe("cargarOnboarding sobre el seed de PM (datos reales del repositorio)", () => {
  it("la cuenta recien sembrada muestra los pendientes del dueño: coordenadas de T3, cobertura, WhatsApp, cambio de turno y nombre del asistente", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent, { demo: true }));
    const c = await cargarOnboarding(world.repo, world.organizationId);
    expect(item(c, "sucursales")).toMatchObject({ estado: "hecho", faltantes: ["T4 (pendiente de datos)"] });
    expect(item(c, "menu").estado).toBe("hecho");
    expect(item(c, "horarios").estado).toBe("hecho");
    expect(item(c, "pedido_minimo").estado).toBe("hecho");
    // Pendientes reales del dueño (no se inventan).
    expect(item(c, "coordenadas")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"] });
    expect(item(c, "zonas_de_entrega").estado).toBe("pendiente");
    expect(item(c, "whatsapp").estado).toBe("pendiente");
    expect(item(c, "cambio_de_turno").estado).toBe("pendiente");
    expect(item(c, "catalogo_pos").estado).toBe("externo");
    expect(item(c, "pedido_de_prueba").estado).toBe("pendiente");
    // El seed deja el perfil del agente configurado, pero SIN nombre (el dueño no lo define).
    expect(item(c, "agente_whatsapp").estado).toBe("hecho");
    expect(item(c, "nombre_del_asistente").estado).toBe("pendiente");
  });

  it("al ponerle nombre al asistente y conectar WhatsApp en cada sucursal, los puntos cambian a hecho", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent, { demo: true }));
    await world.repo.upsertWhatsAppAgentConfig(world.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    world.repo.seedWhatsAppChannel(world.organizationId, "pn-general");
    for (const [slug, propertyId] of world.propertyBySlug) if (slug !== "t4-pendiente") await world.repo.upsertWhatsappBranchChannel(world.organizationId, propertyId, `pn-${slug}`);
    const c = await cargarOnboarding(world.repo, world.organizationId);
    expect(item(c, "agente_whatsapp").estado).toBe("hecho");
    expect(item(c, "nombre_del_asistente").estado).toBe("hecho");
    expect(item(c, "whatsapp").estado).toBe("hecho");
    expect(c.listoParaOperar).toBe(true);
  });
});
