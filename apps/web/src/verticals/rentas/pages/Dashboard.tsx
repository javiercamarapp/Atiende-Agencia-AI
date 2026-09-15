// Landing real del panel de rentas (Fase 12) — cierra el hallazgo "login de rentas
// redirige a /rentas/:slug, ruta que no existía en la SPA (pantalla en blanco tras
// autenticarse)": RentasShell.tsx ya resuelve sesión + properties reales antes de
// llegar aquí, esta página solo las muestra. Real, no un stub: organización,
// propiedades y rol del staff logueado vienen todos de datos reales (sesión
// persistida + GET /v1/rentas/:orgSlug/admin/propiedades), nada inventado.
//
// Esta fase era específicamente "que el login deje de terminar en pantalla en
// blanco", no portar el resto del dashboard operativo -- el resto de páginas se
// fue agregando fase a fase (ver comentarios de cabecera de RentasShell.tsx). El
// calendario de reservas y bloqueos tiene UI real desde la Fase 13
// (pages/Calendario.tsx, link "Calendario"), el cotizador + configuración de
// pricing desde la Fase 14 (pages/Precios.tsx, link "Precios"), la bandeja de
// aprobación de mensajería desde la Fase 15 (pages/Aprobaciones.tsx, link
// "Aprobaciones"), y movimiento por reserva + owner statements + payouts desde la
// Fase 16 (pages/Finanzas.tsx, link "Finanzas").
//
// Fase 18 -- cierra la mitad del hallazgo de auditoría "en rentas, una empresa
// gestora con varias propiedades solo puede operar la primera" que le tocaba a esta
// página: hasta esta fase la lista de properties de abajo era solo informativa (un
// <li> sin ningún onClick). Ahora cada property es un botón real que cambia la
// property activa del Shell (RentasShellContext.setPropertyId, ver el selector real
// del nav en RentasShell.tsx -- esta lista es un segundo punto de entrada al mismo
// estado, no un selector paralelo) y la property activa queda resaltada.
import type { CSSProperties } from "react";
import type { RentasShellContext } from "../RentasShell.tsx";

const cardStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 16,
};

const propertyButtonBaseStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer",
  border: "1px solid transparent",
};

export function RentasDashboardPage({ orgSlug, properties, propertyId, setPropertyId, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>{org?.nombre ?? orgSlug}</h1>
        <p style={{ color: "#6b7280", margin: 0 }}>
          Sesión iniciada como <strong>{session.email}</strong>
          {org ? (
            <>
              {" "}
              · rol <strong>{org.rol}</strong>
            </>
          ) : null}
        </p>
      </div>

      <div style={cardStyle}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", margin: "0 0 12px" }}>
          Propiedades ({properties.length})
        </h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {properties.map((p) => {
            const activa = p.propertyId === propertyId;
            return (
              <li key={p.propertyId}>
                <button
                  type="button"
                  onClick={() => setPropertyId(p.propertyId)}
                  aria-pressed={activa}
                  style={{
                    ...propertyButtonBaseStyle,
                    background: activa ? "#111827" : "#f9fafb",
                    color: activa ? "#fff" : "#111827",
                    borderColor: activa ? "#111827" : "transparent",
                    fontWeight: activa ? 600 : 400,
                  }}
                >
                  {p.nombre}
                  {activa ? " · activa" : ""}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
        Elige una propiedad arriba (o desde el selector del panel lateral) para que Calendario, Precios, Aprobaciones, Finanzas y Mis tareas operen sobre ella. El calendario de reservas y bloqueos está disponible en "Calendario", y el cotizador con la configuración de pricing en "Precios".
      </p>
    </div>
  );
}
