/** The original's version separates replacements; the thumbnail revision separates rebuilds. */
export function avatarThumbnailName(source: string, revision: number): string {
  const match = source.match(/^\/avatars\/((?:character|persona)-\d+)\.(?:png|jpg|webp)\?v=(\d+)$/);
  if (!match) throw new Error(`Avatar has no numeric file version: ${source}`);
  return `thumb-${match[1]}-${match[2]}-${revision}.jpg`;
}
