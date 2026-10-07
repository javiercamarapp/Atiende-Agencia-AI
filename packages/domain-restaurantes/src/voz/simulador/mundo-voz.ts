// Mundo del simulador de llamadas: un restaurante tipo "Los Taquitos de PM" sembrado en el repositorio en memoria,
// con el MOTOR REAL de pedidos (el registro unico de tools, la maquina cotizado -> confirmado -> creado, minimo de $200,
// alcohol a domicilio, tortilla, packs de N). Los datos son de prueba (menu e importes inventados para el arnes); no se
// usan en ningun entorno real.
import { randomUUID } from "node:crypto";
import { InMemoryRestaurantesRepository } from "../../in-memory-repository.ts";
import type { CallbackRequest, CallbackRequestInput, Order } from "../../types.ts";

export const TELEFONO_LLAMANTE = "9991234567";
export const SIP_FROM_LLAMANTE = `"Cliente" <sip:+52${"1"}${TELEFONO_LLAMANTE}@trunk.sim.invalid;user=phone>;tag=sim`;
export const BRANCH_SLUG_PRINCIPAL = "fco-montejo";
export const BRANCH_SLUG_ALTABRISA = "altabrisa";

export interface ProductoSembrado {
  readonly id: string;
  readonly nombre: string;
  readonly precio: number;
}

export interface MundoVoz {
  readonly repo: InMemoryRestaurantesRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly productos: Readonly<Record<"bistec" | "pastor" | "gringa" | "horchata" | "cola" | "cerveza" | "nachos", ProductoSembrado>>;
  /** Callbacks (escaladas y avisos) que quedaron registrados, en orden. */
  readonly callbacks: CallbackRequestInput[];
  pedidos(): Promise<readonly Order[]>;
}

export function crearMundoVoz(): MundoVoz {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const propertyAltabrisa = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({ propertyId, organizationId, name: "Francisco de Montejo", slug: BRANCH_SLUG_PRINCIPAL, status: "active", phone: "+529991110001", address: "Calle 1 #100, Mérida", lat: 21.0186, lng: -89.6708 });
  repo.seedBranch({ propertyId: propertyAltabrisa, organizationId, name: "Altabrisa", slug: BRANCH_SLUG_ALTABRISA, status: "active", phone: "+529991110002", address: "Calle 2 #200, Mérida", lat: 21.0, lng: -89.57 });
  const zonaCentro = randomUUID();
  const zonaAltabrisa = randomUUID();
  repo.seedKnownZone({ id: zonaCentro, organizationId, name: "Centro", lat: 21.02, lng: -89.65 });
  repo.seedKnownZone({ id: zonaAltabrisa, organizationId, name: "Altabrisa", lat: 21.001, lng: -89.572 });
  // Cobertura de entrega cargada (como la cuenta real de PM): sin ella un domicilio de PM no se puede validar y el agente exige el pin.
  repo.seedBranchDeliveryZones(propertyId, [zonaCentro]);
  repo.seedBranchDeliveryZones(propertyAltabrisa, [zonaAltabrisa]);
  for (const p of [propertyId, propertyAltabrisa]) repo.seedBranchPolicy(p, { pedidoMinimoDomicilio: 200 });
  // Perfil del agente de PM (el mismo que siembra el seed real): activa las reglas duras del servidor propias de PM, como el pedido grande.
  // El repositorio en memoria guarda de forma sincrona, por eso no se espera la promesa.
  void repo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });

  const catTacos = randomUUID();
  const catBebidas = randomUUID();
  const catCervezas = randomUUID();
  const catAntojos = randomUUID();
  repo.seedCategory({ id: catTacos, organizationId, name: "Tacos" });
  repo.seedCategory({ id: catBebidas, organizationId, name: "Bebidas" });
  repo.seedCategory({ id: catCervezas, organizationId, name: "Cervezas" });
  repo.seedCategory({ id: catAntojos, organizationId, name: "Antojos" });

  const sembrar = (nombre: string, categoryId: string, precio: number, palabras: readonly string[]): ProductoSembrado => {
    const id = randomUUID();
    repo.seedProduct({ id, organizationId, categoryId, name: nombre, description: null, searchKeywords: palabras });
    for (const p of [propertyId, propertyAltabrisa]) repo.seedBranchProduct({ propertyId: p, productId: id, price: precio, isAvailable: true });
    return { id, nombre, precio };
  };
  const productos = {
    bistec: sembrar("Tacos de Bistec de Res (orden de 3)", catTacos, 164, ["bistec", "bistek", "bisteck", "carne asada"]),
    pastor: sembrar("Tacos al Pastor (orden de 3)", catTacos, 120, ["pastor", "al pastor"]),
    gringa: sembrar("Gringa de Pastor", catAntojos, 95, ["gringa", "gringas"]),
    horchata: sembrar("Agua de Horchata", catBebidas, 40, ["horchata", "agua fresca"]),
    cola: sembrar("Coca-Cola", catBebidas, 45, ["coca", "refresco", "cola"]),
    cerveza: sembrar("Cerveza Sol", catCervezas, 66, ["cerveza", "chela", "sol", "cheve"]),
    nachos: sembrar("Nachos de Pastor", catAntojos, 89, ["nachos"]),
  } as const;
  repo.seedNoDomicilio({ productIds: [productos.cerveza.id] });

  const callbacks: CallbackRequestInput[] = [];
  const original = repo.createCallbackRequest.bind(repo);
  repo.createCallbackRequest = async (input: CallbackRequestInput): Promise<CallbackRequest> => {
    callbacks.push(input);
    return original(input);
  };

  return {
    repo,
    organizationId,
    propertyId,
    productos,
    callbacks,
    async pedidos() {
      return (await repo.listOrders(organizationId, { propertyIds: null, limit: 100 })).orders;
    },
  };
}
