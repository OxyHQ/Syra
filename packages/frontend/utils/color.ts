export function colorWithAlpha(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;

  const normalized = color.trim();
  const shortHex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(normalized);
  if (shortHex) {
    const [, r, g, b] = shortHex;
    return `rgba(${parseInt(r + r, 16)}, ${parseInt(g + g, 16)}, ${parseInt(b + b, 16)}, ${alpha})`;
  }

  const fullHex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
  if (!fullHex) return undefined;

  const [, r, g, b] = fullHex;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}
