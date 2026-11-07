// Copy por vertical del inicio de sesion ds3 (identico al de Rovaq AI): el kicker y el titular (H2) del panel oscuro y
// su bajada, en espanol e ingles, mas el ingles del H1 y su bajada. Es lo UNICO que cambia entre verticales; la pantalla, el
// orden de los metodos y los textos comunes viven en VerticalLoginDs3.tsx. El espanol del panel es el de LOGIN_STORIES
// (la misma historia que ya cuenta el login actual).
import { LOGIN_STORIES } from "./LoginArtwork.tsx";

export interface TextoBilingue {
  readonly es: string;
  readonly en: string;
}

export interface CopiaLoginDs3 {
  /** Kicker en mono del panel oscuro (equivale a «Rovaq · Intelligence»). */
  readonly kicker: TextoBilingue;
  /** Titular serif del panel (H2). */
  readonly titulo: TextoBilingue;
  readonly descripcion: TextoBilingue;
  /** En ingles, nombre de la vertical en el H1 y bajada del H1 (en espanol salen de las props `nombre` y `descripcion` de la pagina). */
  readonly nombreEn: string;
  readonly introEn: string;
}

const historia = (vertical: string) => LOGIN_STORIES[vertical] ?? LOGIN_STORIES.restaurantes!;

export const COPIA_LOGIN_DS3: Readonly<Record<string, CopiaLoginDs3>> = {
  restaurantes: {
    kicker: { es: "Atiende · Restaurantes", en: "Atiende · Restaurants" },
    titulo: { es: historia("restaurantes").title, en: "Every order. Your whole operation." },
    descripcion: { es: historia("restaurantes").description, en: "Conversations, orders and customers in one place. Your team has the context to carry every service through to completion." },
    nombreEn: "restaurants",
    introEn: "Your restaurant’s operations, in one place.",
  },
  hoteles: {
    kicker: { es: "Atiende · Hoteles", en: "Atiende · Hotels" },
    titulo: { es: historia("hoteles").title, en: "A coordinated stay, from start to finish." },
    descripcion: { es: historia("hoteles").description, en: "Reservations, reception and service connected. Every request reaches the right team, with each guest’s history at hand." },
    nombreEn: "hotels",
    introEn: "Your hotel’s reservations, guests and daily operations.",
  },
  rentas: {
    kicker: { es: "Atiende · Rentas", en: "Atiende · Vacation rentals" },
    titulo: { es: historia("rentas").title, en: "Your properties. One connected operation." },
    descripcion: { es: historia("rentas").description, en: "Calendars, guests and maintenance share the same context. Follow every stay with visibility across your portfolio." },
    nombreEn: "vacation rentals",
    introEn: "Your properties, stays and teams, connected.",
  },
  despachos: {
    kicker: { es: "Atiende · Despachos", en: "Atiende · Accounting firms" },
    titulo: { es: historia("despachos").title, en: "Fewer loose ends. More clarity for your firm." },
    descripcion: { es: historia("despachos").description, en: "Documents, reconciliations and closing in one workflow. Your team reviews exceptions and stays in control of every client." },
    nombreEn: "accounting firms",
    introEn: "Your clients, documents and accounting workflows.",
  },
  licitaciones: {
    kicker: { es: "Atiende · Licitaciones", en: "Atiende · Tenders" },
    titulo: { es: historia("licitaciones").title, en: "From opportunity to the next step." },
    descripcion: { es: historia("licitaciones").description, en: "Requirements, documents and dates with clear owners. Follow every tender with the information your team needs to decide." },
    nombreEn: "tenders",
    introEn: "Your opportunities, requirements and deadlines.",
  },
  citas: {
    kicker: { es: "Atiende · Citas", en: "Atiende · Appointments" },
    titulo: { es: historia("citas").title, en: "Your schedule, organized. Your customers, cared for." },
    descripcion: { es: historia("citas").description, en: "Availability, appointments and follow-up connected. Coordinate your team and keep the context of every visit." },
    nombreEn: "appointments",
    introEn: "Your availability, bookings and customer follow-up.",
  },
};

/** Copy de la vertical; una vertical sin entrada (nueva) usa lo que la pagina le pasa en props, igual en los dos idiomas. */
export function copiaLoginDs3(vertical: string, respaldo: { readonly nombre: string; readonly descripcion: string; readonly kicker: string; readonly texto: string }): CopiaLoginDs3 {
  const copia = COPIA_LOGIN_DS3[vertical];
  if (copia) return copia;
  const igual = (t: string): TextoBilingue => ({ es: t, en: t });
  return { kicker: igual(`Atiende · ${respaldo.nombre}`), titulo: igual(respaldo.kicker), descripcion: igual(respaldo.texto), nombreEn: respaldo.nombre, introEn: respaldo.descripcion };
}
