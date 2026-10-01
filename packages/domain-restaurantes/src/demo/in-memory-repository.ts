import type { DemoOrganizationInfo, DemoRepository } from "./types.ts";

/** Doble en memoria real (misma semantica que la tabla `restaurantes.demo_organization`): solo las organizaciones
 * marcadas explicitamente son demo. */
export class InMemoryDemoRepository implements DemoRepository {
  private readonly marks = new Map<string, DemoOrganizationInfo>();

  markDemo(organizationId: string, options: { readonly seedVersion?: string; readonly activo?: boolean } = {}): void {
    this.marks.set(organizationId, { organizationId, seedVersion: options.seedVersion ?? "test", activo: options.activo ?? true });
  }

  async findDemoOrganization(organizationId: string): Promise<DemoOrganizationInfo | null> {
    return this.marks.get(organizationId) ?? null;
  }
}
