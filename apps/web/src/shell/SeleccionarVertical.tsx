// Página raíz de app.useatiende.ai — antes de esta pieza, "/" redirigía
// incondicionalmente a /restaurantes/login (residuo de cuando este monorepo
// tenía una sola vertical real, ver el comentario de cabecera de App.tsx). Con
// las 6 verticales ya con login/shell reales, la raíz necesita un selector
// real: quien llega sin sesión (o sin saber a qué vertical pertenece su
// cuenta) elige aquí, en vez de aterrizar siempre en restaurantes. Ninguna
// vertical arbitrariamente "primero" -- las 6 en igualdad, orden alfabético.
//
// Rejilla de fotos (pedido real: "imagenes representativas minimalistas
// elegantes... cuando pases el cursor una mini descripcion") -- reutiliza las
// MISMAS fotos reales (Higgsfield) ya usadas en la lámina de login de cada
// vertical, en vez de generar un set nuevo: misma marca, un solo lugar donde
// cambiarlas si hace falta. La descripción vive siempre en el DOM (accesible a
// lector de pantalla / teclado vía :focus-within) y se revela con opacidad +
// max-height en hover/focus -- sin JS, solo CSS.
//
// Deliberadamente SIN lógica de sesión propia: si el visitante ya tiene una
// sesión persistida de alguna vertical, su propio Shell (via `AppDeps`/rutas
// protegidas) lo redirige de cualquier forma al entrar a esa vertical -- esta
// página es solo el punto de entrada para quien todavía no eligió ninguna.
import { Link } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";
import "../pages/login.css";

interface VerticalEntry {
  readonly slug: string;
  readonly nombre: string;
  readonly descripcion: string;
}

const VERTICALES: readonly VerticalEntry[] = [
  { slug: "despachos", nombre: "Despachos", descripcion: "CFDI, nómina, conciliación y cierres mensuales para tu despacho contable." },
  { slug: "citas", nombre: "Citas", descripcion: "Reservas y turnos sincronizados con Google Calendar, por WhatsApp." },
  { slug: "hoteles", nombre: "Hoteles", descripcion: "Reservas y operación de tu hotel boutique, por WhatsApp." },
  { slug: "licitaciones", nombre: "Licitaciones", descripcion: "Convocatorias públicas rastreadas, evaluadas y respondidas a tiempo." },
  { slug: "rentas", nombre: "Rentas vacacionales", descripcion: "Calendarios multi-unidad, sincronía con Booking, Airbnb y Vrbo." },
  { slug: "restaurantes", nombre: "Restaurantes", descripcion: "Tus meseros y tu agente de IA, tomando el mismo pedido." },
];

export function SeleccionarVerticalPage() {
  return (
    <main className="login min-h-screen flex flex-col items-center px-6 py-6 sm:py-8">
      <header className="login-entra mb-4">
        <AtiendeWordmark className="scale-90 origin-center" />
      </header>

      <div className="login-entra w-full max-w-4xl text-center" style={{ animationDelay: "60ms" }}>
        <p className="login-kicker">Bienvenido a atiende.ai</p>
        <h1 className="login-serif mt-2 text-[22px] sm:text-[28px] text-foreground">¿A qué negocio quieres entrar?</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Elige tu vertical para ir a su panel de acceso.
        </p>
      </div>

      {/* Tarjetas 4:3 (antes 3:4, casi el doble de alto que de ancho) --
          pedido explícito: que la página quepa completa en un viewport de
          ~900px de alto sin scroll. Más corta = 6 tarjetas + header + título +
          footer caben sin recortar la descripción en hover. */}
      <div className="login-entra grid w-full max-w-4xl grid-cols-2 gap-2.5 mt-5 sm:grid-cols-3" style={{ animationDelay: "120ms" }}>
        {VERTICALES.map(({ slug, nombre, descripcion }) => (
          <Link
            key={slug}
            to={`/${slug}/login`}
            className="group relative block aspect-[4/3] overflow-hidden rounded-2xl border border-border/60 no-underline shadow-[0_10px_30px_-8px_rgb(0,0,0,0.12)]"
          >
            <img
              src={`${import.meta.env.BASE_URL}images/login-hero-${slug}.jpg`}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105 group-focus-visible:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-3 sm:p-3.5">
              <span className="block text-[13px] sm:text-[14px] font-semibold text-white">{nombre}</span>
              <span className="mt-0 grid grid-rows-[0fr] text-[11px] leading-snug text-white/80 opacity-0 transition-all duration-300 ease-out group-hover:mt-1 group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-visible:mt-1 group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100">
                <span className="overflow-hidden">{descripcion}</span>
              </span>
            </div>
          </Link>
        ))}
      </div>

      <p className="login-entra mt-6 text-pretty text-center text-[11px] leading-relaxed text-muted-foreground" style={{ animationDelay: "180ms" }}>
        Al continuar, aceptas los{" "}
        <Link to="/terminos" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
          Términos de Servicio
        </Link>{" "}
        y el{" "}
        <Link to="/privacidad" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
          Aviso de Privacidad
        </Link>{" "}
        de atiende.ai.
      </p>
    </main>
  );
}
