/** Cache depth lighting once; the animation only blits sprites, never blurs each glyph. */
export function createGlyphAtlas(alphabet: string, colors: readonly string[]) {
  const characters = [...new Set(alphabet)];
  const cell = 72;
  const atlas = document.createElement("canvas");
  atlas.width = cell * characters.length;
  atlas.height = cell * colors.length;
  const context = atlas.getContext("2d");
  if (!context) return null;
  context.font = '36px "IBM Plex Mono", monospace';
  context.textAlign = "center";
  context.textBaseline = "middle";
  colors.forEach((color, tier) => {
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = tier === 0 ? 5 : 0;
    characters.forEach((glyph, column) => {
      context.globalAlpha = tier === 0 ? 0.45 : 1;
      context.fillText(glyph, (column + 0.5) * cell, (tier + 0.5) * cell);
      if (tier === 0) {
        context.globalAlpha = 1;
        context.shadowBlur = 0;
        context.fillText(glyph, (column + 0.5) * cell, (tier + 0.5) * cell);
        context.shadowBlur = 5;
      }
    });
  });
  const indices = new Map(characters.map((glyph, index) => [glyph, index]));
  return {
    draw(ctx: CanvasRenderingContext2D, glyph: string, x: number, y: number, size: number, tier: number) {
      const width = size * 2;
      ctx.drawImage(atlas, (indices.get(glyph) ?? 0) * cell, tier * cell, cell, cell, x - width / 2, y - width / 2, width, width);
    },
  };
}
