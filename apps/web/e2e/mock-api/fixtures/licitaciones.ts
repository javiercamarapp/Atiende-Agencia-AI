// Fixtures de licitaciones (Constructora Peninsular). Forma = apps/web/src/verticals/licitaciones/lib/*-client.ts.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("licitaciones");
const ORG = orgDe("licitaciones");
const L = "/licitaciones/:id";

const CONVOCATORIAS = [
  { id: "tnd-1", organizationId: ORG.id, title: "Rehabilitacion de la avenida Reforma, tramo norte", submissionDeadline: "2026-10-20T17:00:00.000Z", updatedAt: "2026-09-29T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E12-2026", contractingBody: "Secretaria de Obras Publicas de Yucatan", cpvCodes: ["45233120"], budgetAmount: 18500000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Licitacion publica nacional", status: "in_review" },
  { id: "tnd-2", organizationId: ORG.id, title: "Suministro de luminarias LED para alumbrado publico", submissionDeadline: "2026-10-27T17:00:00.000Z", updatedAt: "2026-09-30T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E15-2026", contractingBody: "Ayuntamiento de Merida", cpvCodes: ["34928500"], budgetAmount: 4200000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Invitacion a cuando menos tres personas", status: "discovered" },
];

interface AjustesWhatsapp {
  available: boolean;
  configured: boolean;
  contact: { phoneE164: string; status: string; notifyPlazos: boolean; notifyConvocatorias: boolean; notifyFallos: boolean; notifyDecisiones: boolean } | null;
  events: Array<{ id: string; event: string; detail: string | null; createdAt: string }>;
}

function ajustesSemilla(): AjustesWhatsapp {
  return {
    available: true,
    configured: true,
    contact: { phoneE164: "+529995550501", status: "activo", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: false },
    events: [{ id: "evt-1", event: "confirmado", detail: null, createdAt: "2026-09-25T16:00:00.000Z" }],
  };
}

export const rutasLicitaciones: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/licitaciones/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${L}/tenders`, manejador: () => ({ tenders: CONVOCATORIAS }) },
  { metodo: "GET", patron: `${L}/whatsapp/settings`, manejador: (p) => p.estado.obtener("lic.whatsapp", ajustesSemilla) },
  { metodo: "POST", patron: `${L}/whatsapp/opt-out`, manejador: (p) => {
      const a = p.estado.obtener("lic.whatsapp", ajustesSemilla);
      const cambio = a.contact !== null && a.contact.status !== "baja";
      if (a.contact) a.contact.status = "baja";
      return { ok: true, changed: cambio };
    } },
];

export const licitaciones = { orgSlug: ORG.slug, propertyId: PROP.id };
