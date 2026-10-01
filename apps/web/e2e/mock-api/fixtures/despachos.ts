// Fixtures de despachos. Forma de cada respuesta = tipos de apps/web/src/verticals/despachos/lib.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("despachos");
const ORG = orgDe("despachos");

export const rutasDespachos: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/despachos/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
];

export const despachos = { orgSlug: ORG.slug, propertyId: PROP.id };
