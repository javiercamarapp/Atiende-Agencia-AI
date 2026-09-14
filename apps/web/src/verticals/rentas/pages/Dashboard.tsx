// Landing real del panel de rentas (Fase 12) — cierra el hallazgo "login de rentas
// redirige a /rentas/:slug, ruta que no existía en la SPA (pantalla en blanco tras
// autenticarse)": RentasShell.tsx ya resuelve sesión + properties reales antes de
// llegar aquí, esta página solo las muestra. Real, no un stub: organización,
// propiedades y rol del staff logueado vienen todos de datos reales (sesión
// persistida + GET /v1/rentas/:orgSlug/admin/propiedades), nada inventado.
//
// El calendario/cotizador/panel de finanzas visual completo sigue fuera de alcance
// (ver README de este vertical) — esta fase es específicamente "que el login deje de
// terminar en pantalla en blanco", no portar el resto del dashboard operativo.
import type { CSSProperties } from "react";
import type { RentasShellContext } from "../RentasShell.tsx";

const cardStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 16,
};

export function RentasDashboardPage({ orgSlug, properties, session }: RentasShellContext) {
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
          {properties.map((p) => (
            <li key={p.propertyId} style={{ padding: "8px 12px", borderRadius: 8, background: "#f9fafb" }}>
              {p.nombre}
            </li>
          ))}
        </ul>
      </div>

      <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
        El calendario, el cotizador y el panel de finanzas de rentas todavía no tienen UI en este panel — llega en una fase posterior.
      </p>
    </div>
  );
}
