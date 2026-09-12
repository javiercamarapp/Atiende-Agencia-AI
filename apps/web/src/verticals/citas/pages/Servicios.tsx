// Servicios del panel de citas (Fase 5) — lista + ficha, de solo lectura (mismo
// motivo que Proveedores.tsx: domain-citas no expone crear/editar un servicio
// todavía, ver services-client.ts).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchServiceDetail, fetchServices } from "../lib/services-client.ts";
import type { ServiceSummary } from "../lib/services-client.ts";
import { formatMoneyFromCents } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

export function ServiciosListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [services, setServices] = useState<readonly ServiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchServices(fetch, apiBaseUrl, token, propertyId)
      .then((list) => !cancelado && setServices(list))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los servicios."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Servicios</h1>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!services && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {services && services.length === 0 && <p style={{ color: "#6b7280" }}>Este negocio todavía no tiene servicios activos.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {services?.map((s) => (
          <Link key={s.id} to={`/citas/${orgSlug}/servicios/${s.id}`} style={{ display: "block", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, textDecoration: "none", color: "inherit" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{s.name}</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>
              {s.durationMinutes} min · {formatMoneyFromCents(s.priceCents)}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ServicioFichaPageProps extends CitasShellContext {
  readonly serviceId: string;
}

export function ServicioFichaPage({ apiBaseUrl, token, propertyId, orgSlug, serviceId }: ServicioFichaPageProps) {
  const [service, setService] = useState<ServiceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchServiceDetail(fetch, apiBaseUrl, token, propertyId, serviceId)
      .then((s) => !cancelado && setService(s))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el servicio."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, serviceId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }}>
      <Link to={`/citas/${orgSlug}/servicios`} style={{ fontSize: 13, color: "#6b7280" }}>
        ← Volver a servicios
      </Link>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!service && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {service && (
        <>
          <h1 style={{ fontSize: 20, margin: 0 }}>{service.name}</h1>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 8, columnGap: 12, fontSize: 14 }}>
            <dt style={{ color: "#6b7280" }}>Duración</dt>
            <dd style={{ margin: 0 }}>{service.durationMinutes} min</dd>
            <dt style={{ color: "#6b7280" }}>Colchón antes</dt>
            <dd style={{ margin: 0 }}>{service.bufferMinutesBefore} min</dd>
            <dt style={{ color: "#6b7280" }}>Colchón después</dt>
            <dd style={{ margin: 0 }}>{service.bufferMinutesAfter} min</dd>
            <dt style={{ color: "#6b7280" }}>Precio</dt>
            <dd style={{ margin: 0 }}>{formatMoneyFromCents(service.priceCents)}</dd>
            <dt style={{ color: "#6b7280" }}>Estado</dt>
            <dd style={{ margin: 0 }}>{service.isActive ? "Activo" : "Inactivo"}</dd>
          </dl>
          <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>Solo lectura — editar servicios todavía no está disponible desde el panel.</p>
        </>
      )}
    </div>
  );
}
