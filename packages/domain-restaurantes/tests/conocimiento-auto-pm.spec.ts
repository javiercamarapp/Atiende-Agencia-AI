// B07: con el mundo PM real (183 colonias + zonas-punto, minimo $200, propina, direcciones y telefonos) el prompt de voz debe llevar
// sucursales + colonias compacto + FAQ corta dentro del tope, en las variantes que mas pesan.
import { describe, expect, it } from "vitest";
import { TOPE_CARACTERES_PROMPT, bloqueConocimientoParaPrompt, cargarDatosConocimiento, generarConocimientoAuto } from "../src/index.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);

type Mundo = Awaited<ReturnType<typeof buildInMemoryPmWorld>>;
const REPARTEN = ["prol-montejo", "fco-montejo", "pensiones", "garcia-lavin", "altabrisa"];

async function activar(world: Mundo, slugs: readonly string[]): Promise<void> {
  const todas = await world.repo.listBranchesForOrganizationAdmin(world.organizationId);
  for (const b of todas) if (slugs.includes(b.slug)) world.repo.seedBranch({ ...b, status: "active" });
}

async function bloque(world: Mundo) {
  const k = generarConocimientoAuto(await cargarDatosConocimiento(world.repo, world.organizationId));
  return { k, b: bloqueConocimientoParaPrompt(k) };
}

describe("prompt de voz con el mundo PM real: sucursales + colonias compacto + FAQ corta caben en el tope", () => {
  const variantes: readonly { readonly nombre: string; readonly preparar: (w: Mundo) => Promise<void> }[] = [
    { nombre: "5 sucursales que reparten activas", preparar: async (w) => activar(w, REPARTEN) },
    {
      nombre: "dos turnos de horario y minimos de domicilio y recoger",
      preparar: async (w) => {
        await activar(w, REPARTEN);
        for (const slug of REPARTEN) {
          w.repo.seedBranchPolicy(w.propertyBySlug.get(slug)!, {
            horario: [{ dias: [1, 2, 3, 4, 5], abre: "09:00", cierra: "14:00" }, { dias: [0, 1, 2, 3, 4, 5, 6], abre: "17:00", cierra: "01:00" }] as never,
            pedidoMinimoDomicilio: 200,
            pedidoMinimoRecoger: 100,
            propinaPolitica: "solo_tarjeta",
          });
        }
      },
    },
    { nombre: "Playa activa en modo solo recoger", preparar: async (w) => activar(w, [...REPARTEN, "playa"]) },
  ];

  for (const v of variantes) {
    it(v.nombre, async () => {
      const world = await buildInMemoryPmWorld(plan, { deterministic: true });
      await v.preparar(world);
      const { k, b } = await bloque(world);
      expect(b.incluidos).toEqual(expect.arrayContaining(["sucursales_horarios", "colonias_sucursal", "faq"]));
      expect(b.omitidos.map((o) => o.tipo)).not.toContain("colonias_sucursal");
      expect(b.omitidos.map((o) => o.tipo)).not.toContain("faq");
      expect(b.texto.length).toBeLessThanOrEqual(TOPE_CARACTERES_PROMPT);
      // La FAQ del prompt es solo la respuesta de colonias, en conteos y sin nombres; el panel conserva la FAQ completa.
      const faq = k.documentos.find((d) => d.tipo === "faq")!;
      expect(faq.contenidoPrompt!.length).toBeLessThan(450);
      expect(faq.contenidoPrompt).toContain("no prometas la entrega");
      expect(faq.contenidoPrompt).not.toContain("algunas:");
      expect(faq.contenido.length).toBeGreaterThan(faq.contenidoPrompt!.length);
      expect(faq.contenido).toContain("¿A qué hora abren y cierran?");
      expect(b.texto).not.toContain("¿A qué hora abren y cierran?");
      if (v.nombre.startsWith("Playa")) expect(b.texto).not.toMatch(/^Chicxulub: /m);
    });
  }
});
