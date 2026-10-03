// Local subset fonts (assets/fonts, SIL OFL) with Google Fonts full sets as glyph fallback,
// so user-supplied lyrics still render in the same faces when online.
export const FONT = {
  dela: '"GT Dela", "Dela Gothic One", "Hiragino Sans", "Noto Sans JP", sans-serif',
  dot: '"GT Dot", "DotGothic16", "MS Gothic", monospace',
  zen: '"GT Zen", "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", sans-serif',
  orb: '"GT Orbitron", "Orbitron", "Arial Black", sans-serif',
  mono: '"GT Mono", "Share Tech Mono", "Consolas", monospace',
};

export async function loadFonts() {
  if (!document.fonts) return;
  const probes = [
    '400 64px "GT Dela"', '400 64px "GT Dot"', '900 64px "GT Zen"',
    '900 64px "GT Orbitron"', '400 64px "GT Mono"',
  ];
  await Promise.all(probes.map(p => document.fonts.load(p, '幽霊東京AZ09アイ').catch(() => null)));
  await document.fonts.ready;
}
