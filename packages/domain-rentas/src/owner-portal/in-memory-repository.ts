// InMemoryRentasOwnerPortalRepository -- implementación real (no un mock) de
// `RentasOwnerPortalRepository`, DELIBERADAMENTE autocontenida: no comparte estado con
// `InMemoryRentasRepository`/`InMemoryRentasCalendarStore` (Fase 1/2). Mismo criterio
// que `InMemoryRentasTenancyEngine::SeedTenancyProperty` (solo `{id, organizationId}`,
// sin join a `core`): cada adaptador en memoria modela SU PROPIO recorte de tablas,
// denormalizado lo que haga falta para no depender de otro paquete/fixture.
//
// Esto es lo que hace posible escribir el test de aislamiento del diseño Fase 3 §0
// ("un owner NUNCA puede ver datos de una organización donde no tiene presencia real")
// como una prueba real de la LÓGICA de filtrado (por `ownerId`), no una prueba que
// confía en que un mock devuelva lo que se le pida.
import type {
  ConsumePortalInviteInput,
  FiltroOwnerPortalStatements,
  NewPortalInviteInput,
  OwnerCredentialForLogin,
  OwnerPortalOrganizacion,
  OwnerPortalProfileBase,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  RevokeOwnerRefreshTokenInput,
  UnidadPropietarioRecord,
} from "./types.ts";
import type { RentasOwnerPortalRepository } from "./repository.ts";

interface SeedOwnerInput {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

interface SeedOrganizationInput {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

interface SeedUnidadInput {
  readonly id: string;
  readonly name: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly ownerId: string;
}

interface SeedOwnerStatementInput {
  readonly id: string;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly periodo: { inicio: string; fin: string };
  readonly version: number;
  readonly moneda: string;
  readonly totales: OwnerPortalStatementDetalle["totales"];
  readonly lineas: OwnerPortalStatementDetalle["lineas"];
  readonly motivoVersion: string | null;
  readonly generadoEn: string;
}

interface StoredCredential {
  ownerId: string;
  email: string;
  passwordHash: string | null;
}

interface StoredInvite {
  ownerId: string;
  expiresAt: string;
}

export class InMemoryRentasOwnerPortalRepository implements RentasOwnerPortalRepository {
  private readonly owners = new Map<string, SeedOwnerInput>();
  private readonly organizations = new Map<string, SeedOrganizationInput>();
  private readonly ownerOrganizaciones = new Map<string, Set<string>>(); // ownerId -> Set<organizationId>
  private readonly unidades = new Map<string, SeedUnidadInput>();
  private readonly ownerStatements: SeedOwnerStatementInput[] = [];
  private readonly credentialsByOwnerId = new Map<string, StoredCredential>();
  private readonly invitesByTokenHash = new Map<string, StoredInvite>();
  private readonly revokedRefreshJtis = new Set<string>();

  // ---- seeding ----

  seedOwner(owner: SeedOwnerInput): void {
    this.owners.set(owner.id, owner);
  }

  seedOrganization(org: SeedOrganizationInput): void {
    this.organizations.set(org.id, org);
  }

  /** Vínculo N:M owner<->organización gestora (espejo de `rentas.owner_organization`,
   *  ya real desde Fase 1). Necesario para GET /me -- `listUnidadesPropietario`/
   *  `listOwnerStatementsPropietario` derivan su propio alcance de `unidades`/
   *  `ownerStatements` directamente (igual que la RLS real: `owner_id = auth.uid()`,
   *  sin pasar por esta tabla), así que un owner puede tener una unidad seedeada sin
   *  necesitar este vínculo para que `GET /unidades` la muestre -- este vínculo solo
   *  alimenta el "bono de UX" de §2 (organizaciones informativas de `/me`). */
  seedOwnerOrganizacion(ownerId: string, organizationId: string): void {
    const set = this.ownerOrganizaciones.get(ownerId) ?? new Set<string>();
    set.add(organizationId);
    this.ownerOrganizaciones.set(ownerId, set);
  }

  seedUnidad(unidad: SeedUnidadInput): void {
    this.unidades.set(unidad.id, unidad);
  }

  seedOwnerStatement(statement: SeedOwnerStatementInput): void {
    this.ownerStatements.push(statement);
  }

  seedCredential(ownerId: string, email: string, passwordHash: string | null = null): void {
    this.credentialsByOwnerId.set(ownerId, { ownerId, email, passwordHash });
  }

  /** Solo para tests que quieran inspeccionar el token plano generado por
   *  `createPortalInvite` sin pasar por la capa HTTP -- `createPortalInvite` en sí
   *  nunca expone el texto plano (solo recibe/guarda el hash, igual que un password). */
  peekInviteOwnerId(tokenHash: string): string | undefined {
    return this.invitesByTokenHash.get(tokenHash)?.ownerId;
  }

  // ---- RentasOwnerPortalRepository ----

  async findOwnerCredentialByEmail(email: string): Promise<OwnerCredentialForLogin | null> {
    const normalized = email.trim().toLowerCase();
    for (const cred of this.credentialsByOwnerId.values()) {
      if (cred.email.trim().toLowerCase() === normalized && cred.passwordHash) {
        return { ownerId: cred.ownerId, email: cred.email, passwordHash: cred.passwordHash };
      }
    }
    return null;
  }

  async findOwnerProfile(ownerId: string): Promise<OwnerPortalProfileBase | null> {
    const owner = this.owners.get(ownerId);
    return owner ? { id: owner.id, name: owner.name, email: owner.email } : null;
  }

  async listOwnerOrganizaciones(ownerId: string): Promise<readonly OwnerPortalOrganizacion[]> {
    const ids = this.ownerOrganizaciones.get(ownerId) ?? new Set<string>();
    return [...ids]
      .map((id) => this.organizations.get(id))
      .filter((o): o is SeedOrganizationInput => o !== undefined)
      .map((o) => ({ organizationId: o.id, name: o.name, slug: o.slug }));
  }

  // Espejo EXACTO de la policy RLS real (migración 006): `owner_id = auth.uid()`, sin
  // ningún filtro adicional de organización/property -- el propietario ve TODAS sus
  // unidades, de TODAS las organizaciones gestoras donde tiene presencia, en una sola
  // respuesta (diseño §1.3-#5). Este es el método que hace la prueba de aislamiento del
  // diseño §0 verificable de verdad: una unidad de OTRO owner, en OTRA organización,
  // nunca aparece aquí sin importar cuántas se hayan seedeado.
  async listUnidadesPropietario(ownerId: string): Promise<readonly UnidadPropietarioRecord[]> {
    return [...this.unidades.values()]
      .filter((u) => u.ownerId === ownerId)
      .map((u) => ({
        id: u.id,
        name: u.name,
        propertyId: u.propertyId,
        organizationId: u.organizationId,
        organizationName: this.organizations.get(u.organizationId)?.name ?? "",
      }));
  }

  async listOwnerStatementsPropietario(ownerId: string, filtro: FiltroOwnerPortalStatements): Promise<readonly OwnerPortalStatementSummary[]> {
    return this.ownerStatements
      .filter((s) => s.ownerId === ownerId)
      .filter((s) => (filtro.propertyId ? s.propertyId === filtro.propertyId : true))
      .filter((s) => (filtro.desde ? s.periodo.inicio >= filtro.desde : true))
      .filter((s) => (filtro.hasta ? s.periodo.fin <= filtro.hasta : true))
      .sort((a, b) => (a.periodo.inicio < b.periodo.inicio ? 1 : a.periodo.inicio > b.periodo.inicio ? -1 : 0))
      .map((s) => this.toSummary(s));
  }

  async findOwnerStatementDetallePropietario(ownerId: string, statementId: string): Promise<OwnerPortalStatementDetalle | null> {
    // Mismo criterio que la policy RLS real: el WHERE es owner_id = auth.uid() (nunca
    // property_id) -- un id de statement que pertenece a OTRO owner nunca resuelve
    // aquí, sin importar que el statementId en sí sea válido para algún otro owner.
    const s = this.ownerStatements.find((x) => x.id === statementId && x.ownerId === ownerId);
    if (!s) return null;
    return { ...this.toSummary(s), totales: s.totales, lineas: s.lineas, motivoVersion: s.motivoVersion };
  }

  async createPortalInvite(input: NewPortalInviteInput): Promise<void> {
    // Un ownerId solo puede tener UNA invitación pendiente -- generar una nueva
    // invalida cualquier token previo sin consumir (se sobrescribe, nunca se acumula).
    for (const [hash, invite] of this.invitesByTokenHash.entries()) {
      if (invite.ownerId === input.ownerId) this.invitesByTokenHash.delete(hash);
    }
    this.invitesByTokenHash.set(input.tokenHash, { ownerId: input.ownerId, expiresAt: input.expiresAt });
    if (!this.credentialsByOwnerId.has(input.ownerId)) {
      const owner = this.owners.get(input.ownerId);
      this.credentialsByOwnerId.set(input.ownerId, { ownerId: input.ownerId, email: owner?.email ?? "", passwordHash: null });
    }
  }

  async consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> {
    const invite = this.invitesByTokenHash.get(input.tokenHash);
    if (!invite) return null;
    if (invite.expiresAt <= input.now) {
      this.invitesByTokenHash.delete(input.tokenHash); // expirado -- de un solo uso también en el caso fallido
      return null;
    }
    this.invitesByTokenHash.delete(input.tokenHash); // de un solo uso
    const existing = this.credentialsByOwnerId.get(invite.ownerId);
    const owner = this.owners.get(invite.ownerId);
    this.credentialsByOwnerId.set(invite.ownerId, {
      ownerId: invite.ownerId,
      email: existing?.email ?? owner?.email ?? "",
      passwordHash: input.passwordHash,
    });
    return { ownerId: invite.ownerId };
  }

  // ---- Hallazgo de auditoría (severidad ALTA, "el portal de propietario no tiene
  // logout/revocación real de sesión") ----

  async revokeOwnerRefreshToken(input: RevokeOwnerRefreshTokenInput): Promise<void> {
    this.revokedRefreshJtis.add(input.jti);
  }

  async isOwnerRefreshTokenRevoked(jti: string): Promise<boolean> {
    return this.revokedRefreshJtis.has(jti);
  }

  private toSummary(s: SeedOwnerStatementInput): OwnerPortalStatementSummary {
    return {
      id: s.id,
      propertyId: s.propertyId,
      organizationId: s.organizationId,
      organizationName: this.organizations.get(s.organizationId)?.name ?? "",
      periodo: s.periodo,
      version: s.version,
      moneda: s.moneda,
      netoCentavos: s.totales.netoCentavos,
      generadoEn: s.generadoEn,
    };
  }
}
