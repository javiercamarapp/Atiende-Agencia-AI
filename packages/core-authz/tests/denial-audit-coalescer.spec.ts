// No-bloqueante 7 de la re-revisión del PR #177: InMemoryDenialAuditCoalescer
// no tenía spec propio -- en particular, el desalojo por `maxKeys`
// (`evictOldest`) no tenía ningún test. Mismo patrón que
// rate-limiter.spec.ts (reloj inyectado, determinista, sin temporizadores
// reales).
import { describe, expect, it } from "vitest";
import { InMemoryDenialAuditCoalescer } from "../src/index.ts";

describe("InMemoryDenialAuditCoalescer", () => {
  it("la PRIMERA denegación de una llave nueva siempre se persiste, sin nada suprimido", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000);
    const d = c.shouldPersistRateLimited("actor-a:/ruta", 0);
    expect(d.persist).toBe(true);
    expect(d.suppressedSincePersist).toBe(0);
  });

  it("dentro de la MISMA ventana, la SIGUIENTE denegación de la misma llave se suprime (persist:false) e incrementa el contador", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000);
    c.shouldPersistRateLimited("actor-a:/ruta", 0);
    const d1 = c.shouldPersistRateLimited("actor-a:/ruta", 1_000);
    expect(d1.persist).toBe(false);
    expect(d1.suppressedSincePersist).toBe(1);
    const d2 = c.shouldPersistRateLimited("actor-a:/ruta", 2_000);
    expect(d2.persist).toBe(false);
    expect(d2.suppressedSincePersist).toBe(2);
  });

  it("cada llave tiene su propia ventana -- suprimir una nunca afecta a otra", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000);
    c.shouldPersistRateLimited("actor-a:/ruta", 0);
    c.shouldPersistRateLimited("actor-a:/ruta", 1_000); // suprimida
    const otra = c.shouldPersistRateLimited("actor-b:/ruta", 1_000); // llave distinta, ventana nueva
    expect(otra.persist).toBe(true);
    expect(otra.suppressedSincePersist).toBe(0);
  });

  it("al cerrar la ventana con una denegación NUEVA de la MISMA llave, se persiste con el conteo suprimido de la ventana ANTERIOR, y abre una ventana nueva en 0", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000);
    c.shouldPersistRateLimited("actor-a:/ruta", 0);
    c.shouldPersistRateLimited("actor-a:/ruta", 1_000); // suprimida (1)
    c.shouldPersistRateLimited("actor-a:/ruta", 2_000); // suprimida (2)
    const cierraVentana = c.shouldPersistRateLimited("actor-a:/ruta", 61_000); // fuera de la ventana de 60s
    expect(cierraVentana.persist).toBe(true);
    expect(cierraVentana.suppressedSincePersist).toBe(2); // lo acumulado en la ventana anterior
    const siguiente = c.shouldPersistRateLimited("actor-a:/ruta", 61_500);
    expect(siguiente.persist).toBe(false);
    expect(siguiente.suppressedSincePersist).toBe(1); // la ventana nueva arrancó en 0
  });

  it("hueco conocido (documentado, no bloqueante): si la llave nunca vuelve a verse, el conteo suprimido de esa ventana se pierde para siempre -- nada lo vuelca", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000);
    c.shouldPersistRateLimited("actor-a:/ruta", 0);
    c.shouldPersistRateLimited("actor-a:/ruta", 1_000); // suprimida, nunca llega otra fila para "a" que lo vuelque
    // Otra llave, aunque su propia ventana también cierre, NUNCA ve ni
    // vuelca el conteo pendiente de "actor-a:/ruta" -- el coalescer no
    // tiene ningún mecanismo de expiración/flush entre llaves distintas.
    const otra = c.shouldPersistRateLimited("actor-b:/ruta", 100_000);
    expect(otra.persist).toBe(true);
    expect(otra.suppressedSincePersist).toBe(0);
  });

  it("desalojo por maxKeys (evictOldest): al superar el techo de llaves simultáneas, descarta la ventana MÁS VIEJA (por windowStartMs) en vez de crecer sin límite", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000, 2);
    c.shouldPersistRateLimited("vieja:/ruta", 0); // windowStartMs = 0
    c.shouldPersistRateLimited("reciente:/ruta", 10); // windowStartMs = 10
    // Tercera llave nueva, con el mapa ya lleno (maxKeys=2) -- fuerza evict
    // de la ventana más vieja ("vieja:/ruta", windowStartMs=0), no de
    // "reciente:/ruta".
    c.shouldPersistRateLimited("nueva:/ruta", 20);

    // "reciente:/ruta" SOBREVIVIÓ al desalojo -- sigue en su ventana
    // original (todavía dentro de los 60s desde windowStartMs=10), así que
    // una denegación suya se suprime (persist:false), no abre ventana nueva.
    // OJO orden: se comprueba ANTES que "vieja" a propósito -- comprobar
    // "vieja" es en sí misma una llave NUEVA (map ya lleno de nuevo con
    // reciente+nueva), así que dispara OTRO desalojo (el de "reciente")
    // antes de que este test pueda verificarla.
    const reciente = c.shouldPersistRateLimited("reciente:/ruta", 21);
    expect(reciente.persist).toBe(false);

    // "vieja:/ruta" se recicló -- una denegación suya ahora abre ventana
    // NUEVA (persist:true, suprimido:0), como si nunca hubiera existido.
    const vieja = c.shouldPersistRateLimited("vieja:/ruta", 30);
    expect(vieja.persist).toBe(true);
    expect(vieja.suppressedSincePersist).toBe(0);
  });

  it("hueco conocido (documentado, no bloqueante): el desalojo por maxKeys puede tirar el conteo pendiente de una llave AJENA que todavía estaba dentro de su ventana", () => {
    const c = new InMemoryDenialAuditCoalescer(60_000, 1);
    c.shouldPersistRateLimited("victima:/ruta", 0);
    c.shouldPersistRateLimited("victima:/ruta", 1); // suprimida (1) -- pendiente de volcarse
    // Con maxKeys=1 ya lleno, una llave nueva cualquiera desaloja
    // "victima:/ruta" SIN volcar su conteo suprimido a ningún lado.
    c.shouldPersistRateLimited("atacante:/ruta", 2);
    // "victima:/ruta" se recicló -- su siguiente denegación abre ventana
    // nueva desde cero, el "1" suprimido de antes ya no existe en ningún
    // lado (ni se persistió, ni se puede recuperar).
    const victimaTrasDesalojo = c.shouldPersistRateLimited("victima:/ruta", 3);
    expect(victimaTrasDesalojo.persist).toBe(true);
    expect(victimaTrasDesalojo.suppressedSincePersist).toBe(0);
  });
});
