// Mapa de rutas del superadmin: ARCHIVO PLANO Y UNICO (equivalente a `admin/rutas.ts` de Likida).
// De aqui salen el sidebar, la hoja "Mas" del movil, el rail colapsado y el pie; cualquier consumidor
// futuro (paleta de comandos, rejilla "Orquestacion de agentes" del Resumen) debe leer `TODAS_LAS_RUTAS`
// o `SECCIONES` en vez de repetir una lista a mano.
//
// REGLA NO-MAQUETAS: aqui solo entra una ruta que tiene PAGINA REAL detras (ver App.tsx). Las paginas
// del menu objetivo de Likida que todavia no existen NO aparecen como entrada fantasma ni deshabilitada:
// se registran en `PENDIENTES` con el ticket que las cierra y el motivo, y entran a `SECCIONES` el dia
// que su pagina exista. El orden de las secciones y de las entradas sigue el de Likida
// (Agentes, Negocio, Plataforma, Control, Sistema); una seccion sin ninguna pagina real no se pinta.
//
// Sin JSX ni hooks a proposito: lo importan el shell (cliente) y las pruebas.
import {
  Activity,
  Bot,
  AlertOctagon,
  ArrowLeftRight,
  BellOff,
  Brain,
  Building2,
  Coins,
  Cpu,
  DollarSign,
  FileSearch,
  KeyRound,
  LayoutGrid,
  LineChart,
  ListChecks,
  Lock,
  MapPinned,
  MessageCircle,
  Newspaper,
  Plug,
  Power,
  Scale,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Tags,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Clave } from "@atiende/ui";

export interface RutaSuperadmin {
  readonly to: string;
  readonly label: string;
  /** Clave i18n de la etiqueta (el shell pinta `t(clave)`; `label` queda como el nombre canonico en espanol). */
  readonly clave: Clave;
  readonly icon: LucideIcon;
  /** Activa solo con coincidencia exacta (la raiz no debe quedar activa en todas las hijas). */
  readonly end?: boolean;
}

export interface SeccionSuperadmin {
  readonly title: string;
  readonly clave: Clave;
  readonly items: readonly RutaSuperadmin[];
}

/** "Resumen": arriba y fuera de las secciones (en Likida, `Inicio`). La pagina es el Resumen de la consola (UNI-RES-superadmin). */
export const RESUMEN: RutaSuperadmin = { to: "/superadmin", label: "Resumen", clave: "nav.resumen", icon: LayoutGrid, end: true };

/** "Copiloto" (CHAT-17): el chat con los datos de la plataforma para el superadmin CFO. Va JUSTO DEBAJO de Resumen, en la misma primera seccion (orden de Javier, 4-oct). */
export const COPILOTO: RutaSuperadmin = { to: "/superadmin/copiloto", label: "Copiloto", clave: "nav.copiloto", icon: Sparkles };

/**
 * Agentes: el Panel de agentes (SA-L-08), las tres fichas de agente (SA-L-09)
 * y Model Ops (SA-L-10). Los demas (Evals, Playground, QA) estan en `PENDIENTES`. Las palancas por agente viven en el Panel y tambien en Interruptores (Sistema).
 */
export const AGENTES: readonly RutaSuperadmin[] = [
  { to: "/superadmin/agentes", label: "Panel de agentes", clave: "nav.panelAgentes", icon: Bot },
  { to: "/superadmin/agente-extractor", label: "Agente extractor", clave: "nav.agenteExtractor", icon: FileSearch },
  { to: "/superadmin/agente-conciliacion", label: "Agente de conciliación", clave: "nav.agenteConciliacion", icon: Scale },
  { to: "/superadmin/agente-whatsapp", label: "Agente de WhatsApp y voz", clave: "nav.agenteWhatsappVoz", icon: MessageCircle },
  { to: "/superadmin/model-ops", label: "Model Ops", clave: "nav.modelOps", icon: Cpu },
];

export const NEGOCIO: readonly RutaSuperadmin[] = [
  { to: "/superadmin/acciones", label: "Acciones", clave: "nav.acciones", icon: ListChecks },
  { to: "/superadmin/cerebro", label: "Cerebro de ventas", clave: "nav.cerebroVentas", icon: Brain },
  // SA-L-42/43: el mundo virtual del Cerebro (mapa) y la ficha del prospecto, con el mismo nombre de ruta que Likida.
  { to: "/superadmin/mapa-prospectos", label: "Mapa de prospectos", clave: "nav.mapaProspectos", icon: MapPinned },
  { to: "/superadmin/organizaciones", label: "Organizaciones", clave: "nav.organizaciones", icon: Building2 },
  // SA-L-21/22/24: en Likida Costos & Facturacion, Consumo de IA y Ejecutivo / Board son UNA entrada cada uno. Las rutas viejas
  // (facturacion, costos-margen, pyl, contratos, gasto-api, cfo) siguen vivas como redireccion (REDIRECCIONES_SUPERADMIN).
  { to: "/superadmin/costos-facturacion", label: "Costos y facturación", clave: "nav.costosFacturacion", icon: Coins },
  { to: "/superadmin/consumo-ia", label: "Consumo de IA", clave: "nav.consumoIa", icon: DollarSign },
  { to: "/superadmin/ejecutivo", label: "Ejecutivo / Board", clave: "nav.ejecutivo", icon: LineChart },
];

export const PLATAFORMA: readonly RutaSuperadmin[] = [{ to: "/superadmin/integraciones", label: "Integraciones", clave: "nav.integraciones", icon: Plug }];

export const CONTROL: readonly RutaSuperadmin[] = [
  { to: "/superadmin/seguridad", label: "Seguridad (MFA)", clave: "nav.seguridadMfa", icon: KeyRound },
  { to: "/superadmin/impersonacion", label: "Impersonación", clave: "nav.impersonacion", icon: ShieldAlert },
  { to: "/superadmin/break-glass", label: "Romper cristal", clave: "nav.romperCristal", icon: AlertOctagon },
  { to: "/superadmin/auditoria-denegaciones", label: "Auditoría de denegaciones", clave: "nav.auditoriaDenegaciones", icon: ShieldOff },
  { to: "/superadmin/privacidad", label: "Privacidad", clave: "nav.privacidad", icon: Lock },
  { to: "/superadmin/supresion", label: "Supresión de contactos", clave: "nav.supresion", icon: BellOff },
  { to: "/superadmin/zona-cfo", label: "Zona CFO segura", clave: "nav.zonaCfo", icon: ShieldCheck },
  { to: "/superadmin/planes", label: "Planes y precios", clave: "nav.planes", icon: Tags },
];

export const SISTEMA: readonly RutaSuperadmin[] = [
  { to: "/superadmin/interruptores", label: "Interruptores", clave: "nav.interruptores", icon: Power },
  { to: "/superadmin/salud", label: "Salud operativa", clave: "nav.saludOperativa", icon: Activity },
];

/** Las cinco secciones con el rotulo y el orden de Likida. Una seccion sin paginas reales no se pinta. */
export const SECCIONES: readonly SeccionSuperadmin[] = ([
  { title: "Agentes", clave: "nav.agentes", items: AGENTES },
  { title: "Negocio", clave: "nav.negocio", items: NEGOCIO },
  { title: "Plataforma", clave: "nav.plataforma", items: PLATAFORMA },
  { title: "Control", clave: "nav.control", items: CONTROL },
  { title: "Sistema", clave: "nav.sistema", items: SISTEMA },
] satisfies SeccionSuperadmin[]).filter((s) => s.items.length > 0);

/** Lista plana con Resumen y Copiloto primero (la usaran la paleta, el rail y la rejilla del Resumen). */
export const TODAS_LAS_RUTAS: readonly RutaSuperadmin[] = [RESUMEN, COPILOTO, ...SECCIONES.flatMap((s) => s.items)];

/**
 * Pie fijo del sidebar. Cada pildora lleva a una pagina real: "Costos de IA" abre Costos y facturacion
 * (gasto historico de IA y costo por operacion) y "Ver los otros paneles" el selector de paneles (`Paneles.tsx`).
 */
export const PIE_SUPERADMIN = [
  { label: "Costos de IA", clave: "nav.costosIa", to: "/superadmin/costos-facturacion" },
  { label: "Ver los otros paneles", clave: "nav.otrosPaneles", to: "/superadmin/paneles", icon: ArrowLeftRight },
] as const;

/** Barra inferior movil: destinos de uso diario; el 5.o lugar es "Mas" (lo agrega el shell). */
export const MOVIL_SUPERADMIN: readonly RutaSuperadmin[] = [
  { to: "/superadmin", label: "Resumen", clave: "nav.resumen", icon: Newspaper, end: true },
  { to: "/superadmin/organizaciones", label: "Orgs", clave: "nav.orgs", icon: Building2 },
  { to: "/superadmin/salud", label: "Salud", clave: "nav.salud", icon: Activity },
  { to: "/superadmin/acciones", label: "Acciones", clave: "nav.acciones", icon: ListChecks },
];

/** El parte diario (antes en la raiz) vive aqui, sin item de menu: se llega por "Ver parte diario" del Resumen. */
export const PARTE_DIARIO = "/superadmin/parte-diario";

/** Rutas con pagina real que NO tienen item de menu (se llega por un enlace). Cuentan como existentes para las pildoras. */
export const RUTAS_SIN_MENU: readonly string[] = [PARTE_DIARIO, "/superadmin/notificaciones", "/superadmin/cerebro/taxonomia"];

/** Rutas web que cambiaron de lugar: la vieja redirige a la nueva (sin 404). */
export const REDIRECCIONES_SUPERADMIN: Readonly<Record<string, string>> = {
  "/superadmin/resumen": "/superadmin",
  // SA-L-21: las cuatro paginas de costos son pestanas de una sola (la pestana activa va en `?tab=`).
  "/superadmin/facturacion": "/superadmin/costos-facturacion?tab=facturacion",
  "/superadmin/costos-margen": "/superadmin/costos-facturacion?tab=costos",
  "/superadmin/pyl": "/superadmin/costos-facturacion?tab=pyl",
  "/superadmin/contratos": "/superadmin/costos-facturacion?tab=contratos",
  // SA-L-22 y SA-L-24: renombradas como en Likida.
  "/superadmin/gasto-api": "/superadmin/consumo-ia",
  "/superadmin/cfo": "/superadmin/ejecutivo",
  // SA-L-20: la gestion de organizaciones es la pestana "Gestion" de Organizaciones (sin 404 en enlaces y notificaciones viejas).
  "/superadmin/gestion-organizaciones": "/superadmin/organizaciones?tab=gestion",
  // Prospectos pasa a "Cerebro de ventas" (SA-L-37): la ruta vieja redirige a la nueva.
  "/superadmin/prospectos": "/superadmin/cerebro",
};

export interface PendienteSuperadmin {
  readonly seccion: "Agentes" | "Negocio" | "Plataforma" | "Control" | "Sistema";
  readonly label: string;
  /** Ruta propuesta por la paridad con Likida; NO existe todavia como pagina. */
  readonly ruta: string;
  /** Ticket del tablero que la cierra (o el motivo si depende de credenciales). */
  readonly ticket: string;
}

/**
 * Paginas del menu objetivo de Likida que aun NO existen. Honestas: ninguna se pinta en el menu ni se
 * maqueta. Cuando una pagina se construye, se mueve de aqui a su seccion de `SECCIONES`.
 */
export const PENDIENTES: readonly PendienteSuperadmin[] = [
  { seccion: "Agentes", label: "Evals", ruta: "/superadmin/evals", ticket: "paridad2 §4" },
  { seccion: "Agentes", label: "Playground", ruta: "/superadmin/playground", ticket: "paridad2 §4" },
  { seccion: "Agentes", label: "QA autónomo", ruta: "/superadmin/qa", ticket: "paridad2 §4" },
  { seccion: "Negocio", label: "Tu turno", ruta: "/superadmin/tu-turno", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Escalaciones", ruta: "/superadmin/escalaciones", ticket: "SA-16" },
  { seccion: "Negocio", label: "Aprobaciones", ruta: "/superadmin/aprobaciones", ticket: "paridad2 §6" },
  { seccion: "Negocio", label: "Vendedores", ruta: "/superadmin/vendedores", ticket: "paridad2 §2.3 (no existe el rol vendedor)" },
  { seccion: "Negocio", label: "Conversaciones", ruta: "/superadmin/conversaciones", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Analítica & Stats", ruta: "/superadmin/analitica", ticket: "paridad2 §2.3 (usa el kit de gráficas SA-L-03)" },
  { seccion: "Negocio", label: "Cobranza", ruta: "/superadmin/cobranza", ticket: "SA-09" },
  { seccion: "Negocio", label: "Crecimiento", ruta: "/superadmin/crecimiento", ticket: "SA-25 / SA-08" },
  { seccion: "Negocio", label: "Estudio de marketing", ruta: "/superadmin/marketing", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Nuevo usuario", ruta: "/superadmin/usuarios/nuevo", ticket: "paridad2 §2.3" },
  { seccion: "Plataforma", label: "WhatsApp Infra", ruta: "/superadmin/whatsapp-infra", ticket: "paridad2 §2.4" },
  { seccion: "Plataforma", label: "Conocimiento / RAG", ruta: "/superadmin/conocimiento", ticket: "PL-26" },
  { seccion: "Plataforma", label: "Comunicación", ruta: "/superadmin/comunicacion", ticket: "PL-34" },
  { seccion: "Control", label: "Equipo", ruta: "/superadmin/equipo", ticket: "SA-23" },
  { seccion: "Sistema", label: "Relojes", ruta: "/superadmin/relojes", ticket: "paridad2 §2.6" },
  { seccion: "Sistema", label: "Calidad & Evals", ruta: "/superadmin/calidad", ticket: "paridad2 §4" },
  { seccion: "Sistema", label: "Actividad de código", ruta: "/superadmin/actividad-codigo", ticket: "requiere GITHUB_TOKEN" },
  { seccion: "Sistema", label: "Soporte", ruta: "/superadmin/soporte", ticket: "SA-16" },
  { seccion: "Sistema", label: "Capacidad & Forecast", ruta: "/superadmin/capacidad", ticket: "SA-25" },
];
