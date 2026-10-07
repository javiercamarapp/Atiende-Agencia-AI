// Destino del boton «Mapa» de la vista del repartidor. Si el cliente compartio su pin de WhatsApp o un link de Maps, el
// servidor lo dejo en las notas del pedido (domain-restaurantes/src/whatsapp/location.ts, `formatUbicacionEntregaNota`) y se
// usa como destino exacto; si no, se busca por la direccion escrita (comportamiento anterior). Se redeclara la lectura aqui
// (apps/web no depende de @atiende/domain-restaurantes) y solo se aceptan coordenadas validas o un enlace corto de Maps.

const NOTA_COORD_RE = /^Ubicación de entrega \((?:pin de WhatsApp|enlace de Maps)\): lat=(-?\d{1,2}(?:\.\d+)?) lng=(-?\d{1,3}(?:\.\d+)?)\.$/m;
const NOTA_CORTO_RE = /^Ubicación de entrega \(enlace corto de Maps\): (https:\/\/(?:maps\.app\.goo\.gl\/|goo\.gl\/maps)[^\s]*)/m;

export function urlDestinoMapa(notes: string | null | undefined, direccion: string | null | undefined): string | null {
  const coord = notes ? NOTA_COORD_RE.exec(notes) : null;
  if (coord) {
    const lat = Number(coord[1]);
    const lng = Number(coord[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    }
  }
  const corto = notes ? NOTA_CORTO_RE.exec(notes) : null;
  if (corto) return corto[1]!.replace(/[.,;]+$/, "");
  const dir = (direccion ?? "").trim();
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : null;
}

/** true cuando el destino sale del pin o link del cliente y no de la direccion escrita. */
export function destinoEsPin(notes: string | null | undefined): boolean {
  return Boolean(notes && (NOTA_COORD_RE.test(notes) || NOTA_CORTO_RE.test(notes)));
}
