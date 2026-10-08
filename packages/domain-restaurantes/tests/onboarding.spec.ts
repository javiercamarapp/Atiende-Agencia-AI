// R-33 -- checklist de onboarding calculado con datos REALES de la organizacion (no un estado guardado): cada punto sale del
// repositorio; lo que no se puede comprobar queda pendiente/externo con su responsable. Sin SQL nuevo: reutiliza lecturas ya
// protegidas con SAVEPOINT contra la base sin migrar.
import { describe, expect, it } from "vitest";
import { buildOnboardingChecklist, cargarOnboarding, evaluarGateOnboarding, type OnboardingBranchSnapshot, type OnboardingSnapshot } from "../src/onboarding.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { InMemoryVozRepository } from "../src/voz/in-memory-voz-repository.ts";
import { InMemoryPrivacidadRepository } from "../src/privacidad/in-memory-repository.ts";
import { PRIVACY_CONFIG_POR_DEFECTO } from "../src/privacidad/aviso.ts";
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
  voz: "habilitada",
  ...over,
});
const COMPLETO: OnboardingSnapshot = { sucursales: [rama()], whatsappGeneral: true, agenteConfigurado: true, nombreDelAsistente: true, pedidos: 5, vozProveedorListo: true, privacidadDisponible: true, avisoPublicado: true };
const item = (c: ReturnType<typeof buildOnboardingChecklist>, id: string) => c.items.find((i) => i.id === id)!;

describe("buildOnboardingChecklist (funcion pura)", () => {
  // QA-restaurantes-R1-viaje-13: el texto de cada punto debe coincidir con su estado.
  it("whatsapp parcial con una sucursal conectada y sin numero general: NO dice 'Ningun numero conectado'", () => {
    const c = buildOnboardingChecklist({ ...COMPLETO, whatsappGeneral: false, sucursales: [rama({ nombre: "T7", conWhatsappPropio: true }), rama({ nombre: "T8", conWhatsappPropio: false })] });
    const w = item(c, "whatsapp");
    expect(w.estado).toBe("parcial");
    expect(w.detalle).not.toContain("Ningún número");
    expect(w.detalle).toContain("1 de 2");
    expect(w.detalle).toContain("T8");
  });

  it("sucursales en 'hecho' menciona las inactivas en el detalle", () => {
    const c = buildOnboardingChecklist({ ...COMPLETO, sucursales: [rama({ nombre: "T7" }), rama({ nombre: "Vieja", activa: false })] });
    const i = item(c, "sucursales");
    expect(i.estado).toBe("hecho");
    expect(i.detalle).toContain("inactivas: Vieja");
  });

  it("todo configurado: todos los puntos verificables en 'hecho', solo el catalogo del POS queda externo; listo para operar", () => {
    const c = buildOnboardingChecklist(COMPLETO);
    expect(c.items.filter((i) => i.estado !== "hecho").map((i) => i.id)).toEqual(["catalogo_pos"]);
    expect(item(c, "catalogo_pos")).toMatchObject({ estado: "externo", responsable: "distribuidor_pos" });
    expect(c.listoParaOperar).toBe(true);
    expect(c.resumen).toEqual({ hechos: c.items.length - 1, total: c.items.length, obligatoriosPendientes: 0 });
  });

  it("organizacion vacia: nada se da por hecho y el gate bloquea (sucursales, menu, horarios y agente son obligatorios)", () => {
    const c = buildOnboardingChecklist({ sucursales: [], whatsappGeneral: false, agenteConfigurado: false, nombreDelAsistente: false, pedidos: 0, vozProveedorListo: false, privacidadDisponible: true, avisoPublicado: false });
    expect(c.listoParaOperar).toBe(false);
    for (const id of ["sucursales", "menu", "horarios", "agente_whatsapp"]) expect(item(c, id)).toMatchObject({ obligatorio: true, estado: "pendiente" });
    expect(c.items.filter((i) => i.estado === "hecho")).toHaveLength(0);
  });

  it("voz: deshabilitada EXPLICITAMENTE = hecho; sin decision = pendiente; habilitada sin credenciales del proveedor = externo (plataforma)", () => {
    const deshabilitada = buildOnboardingChecklist({ ...COMPLETO, vozProveedorListo: false, sucursales: [rama({ voz: "deshabilitada" })] });
    expect(item(deshabilitada, "voz")).toMatchObject({ estado: "hecho", pantalla: "agente-voz", obligatorio: false });
    const sinDecision = buildOnboardingChecklist({ ...COMPLETO, sucursales: [rama({ nombre: "A", voz: "sin_configurar" }), rama({ nombre: "B", voz: "deshabilitada" })] });
    expect(item(sinDecision, "voz")).toMatchObject({ estado: "parcial", faltantes: ["A"], responsable: "dueno" });
    expect(item(buildOnboardingChecklist({ ...COMPLETO, sucursales: [rama({ voz: "sin_configurar" })] }), "voz").estado).toBe("pendiente");
    const sinCredenciales = buildOnboardingChecklist({ ...COMPLETO, vozProveedorListo: false, sucursales: [rama({ voz: "habilitada" })] });
    expect(item(sinCredenciales, "voz")).toMatchObject({ estado: "externo", responsable: "plataforma" });
    expect(item(buildOnboardingChecklist(COMPLETO), "voz").estado).toBe("hecho");
    // La voz nunca bloquea el gate (un restaurante sin voz opera por WhatsApp y storefront).
    expect(sinDecision.listoParaOperar).toBe(true);
  });

  it("aviso de privacidad: ausente = pendiente OBLIGATORIO que bloquea; publicado = hecho; sin repositorio de privacidad = externo que no bloquea", () => {
    const ausente = buildOnboardingChecklist({ ...COMPLETO, avisoPublicado: false });
    expect(item(ausente, "aviso_privacidad")).toMatchObject({ estado: "pendiente", obligatorio: true, pantalla: "privacidad", responsable: "dueno" });
    expect(ausente.listoParaOperar).toBe(false);
    expect(item(buildOnboardingChecklist(COMPLETO), "aviso_privacidad").estado).toBe("hecho");
    const sinRepo = buildOnboardingChecklist({ ...COMPLETO, privacidadDisponible: false, avisoPublicado: false });
    expect(item(sinRepo, "aviso_privacidad")).toMatchObject({ estado: "externo", obligatorio: false, responsable: "plataforma" });
    expect(sinRepo.listoParaOperar).toBe(true);
  });

  it("org con todo listo (voz y aviso incluidos) = listoParaOperar y el gate no bloquea", () => {
    const c = buildOnboardingChecklist(COMPLETO);
    expect(c.listoParaOperar).toBe(true);
    expect(c.gate).toEqual({ bloquea: false, obligatoriosPendientes: 0, operaConPedidos: true });
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

describe("evaluarGateOnboarding (regla del gate)", () => {
  it("bloquea solo con obligatorios pendientes Y sin pedidos; una organizacion que ya opera con pedidos nunca se desvia", () => {
    expect(evaluarGateOnboarding(2, 0)).toEqual({ bloquea: true, obligatoriosPendientes: 2, operaConPedidos: false });
    expect(evaluarGateOnboarding(2, 7)).toEqual({ bloquea: false, obligatoriosPendientes: 2, operaConPedidos: true });
    expect(evaluarGateOnboarding(0, 0).bloquea).toBe(false);
  });

  it("organizacion nueva sin aviso ni agente: bloquea; la misma con pedidos reales: no", () => {
    const nueva = buildOnboardingChecklist({ ...COMPLETO, agenteConfigurado: false, avisoPublicado: false, pedidos: 0 });
    expect(nueva.gate.bloquea).toBe(true);
    expect(buildOnboardingChecklist({ ...COMPLETO, agenteConfigurado: false, avisoPublicado: false, pedidos: 3 }).gate.bloquea).toBe(false);
  });
});

describe("cargarOnboarding sobre el seed de PM (datos reales del repositorio)", () => {
  it("la cuenta recien sembrada muestra los pendientes del dueño: coordenadas de T3, cobertura, WhatsApp, cambio de turno y nombre del asistente", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent, { demo: true }));
    const c = await cargarOnboarding(world.repo, world.organizationId);
    // En la carga DEMO T2 y T8 (catalogo provisional) se crean activas para probar sus colonias; en una carga normal quedan inactivas. T4 Galerias no recibe pedidos; T5 Playa esta fuera de temporada.
    expect(item(c, "sucursales")).toMatchObject({ estado: "hecho", faltantes: ["Galerías", "Playa (Chicxulub)"] });
    expect(item(c, "menu").estado).toBe("hecho");
    expect(item(c, "horarios").estado).toBe("hecho");
    expect(item(c, "pedido_minimo").estado).toBe("hecho");
    // Pendientes reales del dueño (no se inventan).
    expect(item(c, "coordenadas")).toMatchObject({ estado: "parcial", faltantes: ["Pensiones"] });
    // Las colonias del piloto original dan cobertura a T1, T3 y T7 (propuesta; el mapa de zonas del dueño sigue pendiente, ver pendientes_dueno).
    expect(item(c, "zonas_de_entrega").estado).toBe("hecho");
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

  it("voz y privacidad salen de sus repositorios: base sin migrar = sin configurar / aviso pendiente, nunca hecho ni error", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent, { demo: true }));
    const voz = new InMemoryVozRepository();
    const privacidad = new InMemoryPrivacidadRepository();
    for (const [, propertyId] of world.propertyBySlug) voz.seedProperty(propertyId, world.organizationId);
    // Sin migrar (voz 025 y privacidad 030 ausentes).
    voz.migrada = false;
    privacidad.migrada = false;
    const sinMigrar = await cargarOnboarding(world.repo, world.organizationId, { voz, privacidad, vozProveedorListo: async () => true });
    expect(item(sinMigrar, "voz").estado).toBe("pendiente");
    expect(item(sinMigrar, "aviso_privacidad")).toMatchObject({ estado: "pendiente", obligatorio: true });
    // Migrada: el dueño deshabilita la voz a proposito en cada sucursal activa y publica su aviso.
    voz.migrada = true;
    privacidad.migrada = true;
    for (const [, propertyId] of world.propertyBySlug) await voz.upsertConfig(world.organizationId, propertyId, { habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "", mensajeInicial: "" });
    privacidad.configs.set(world.organizationId, { ...PRIVACY_CONFIG_POR_DEFECTO, configurada: true, noticeUrl: "https://ejemplo.mx/aviso" });
    const listo = await cargarOnboarding(world.repo, world.organizationId, { voz, privacidad, vozProveedorListo: async () => false });
    expect(item(listo, "voz").estado).toBe("hecho");
    expect(item(listo, "aviso_privacidad").estado).toBe("hecho");
  });
});
