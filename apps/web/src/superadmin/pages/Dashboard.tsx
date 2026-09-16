// Dashboard real del back office de plataforma — GET /superadmin/organizations
// (autorización real en la función SQL, ver `apps/api/src/routes/superadmin.ts`).
// Alcance de este pase: solo lectura (lista + resumen), ver el comentario de
// cabecera de esa ruta para por qué no hay acciones de escritura todavía.
import { useEffect, useState } from "react";
import { Building2, Users } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";

interface SuperadminOrganization {
  readonly id: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "trial" | "active" | "suspended";
  readonly createdAt: string;
  readonly staffCount: number;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

function badgeDeEstado(status: SuperadminOrganization["status"]) {
  if (status === "active") return <Badge>Activa</Badge>;
  if (status === "suspended") return <Badge variant="destructive">Suspendida</Badge>;
  return <Badge variant="secondary">Prueba</Badge>;
}

export function SuperAdminDashboardPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [organizations, setOrganizations] = useState<readonly SuperadminOrganization[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    setOrganizations(null);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/superadmin/organizations`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("no se pudo cargar");
      const body = (await res.json()) as { organizations: SuperadminOrganization[] };
      setOrganizations(body.organizations);
    } catch {
      setError("No se pudieron cargar las organizaciones.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  if (error) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!organizations) return <EstadoCargando etiqueta="Cargando organizaciones…" />;

  const totalStaff = organizations.reduce((acc, o) => acc + o.staffCount, 0);
  const porVertical = new Map<string, number>();
  for (const o of organizations) porVertical.set(o.vertical, (porVertical.get(o.vertical) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Organizaciones</h1>
        <p className="text-sm text-muted-foreground mt-1">Todas las organizaciones de las 6 verticales de atiende.ai.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard label="Organizaciones" value={String(organizations.length)} icon={Building2} />
        <StatCard label="Staff total" value={String(totalStaff)} icon={Users} />
        {[...porVertical.entries()].map(([vertical, count]) => (
          <StatCard key={vertical} label={NOMBRE_VERTICAL[vertical] ?? vertical} value={String(count)} icon={Building2} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Todas las organizaciones</CardTitle>
        </CardHeader>
        <CardContent>
          {organizations.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay organizaciones dadas de alta en ninguna vertical." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organización</TableHead>
                  <TableHead>Vertical</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Staff</TableHead>
                  <TableHead>Creada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <span className="font-medium text-foreground">{o.name}</span>
                      <span className="block text-xs text-muted-foreground">{o.slug}</span>
                    </TableCell>
                    <TableCell>{NOMBRE_VERTICAL[o.vertical] ?? o.vertical}</TableCell>
                    <TableCell>{badgeDeEstado(o.status)}</TableCell>
                    <TableCell>{o.staffCount}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(o.createdAt).toLocaleDateString("es-MX")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
