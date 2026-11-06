/**
 * One teacher's avatar (issue 06-portfolio-follow).
 *
 * PRIVACY: the only inputs are `avatarPath` and `displayName`, both already
 * alias-safe, because they come from the `teachers_public` view. In alias mode
 * the view returns `alias_avatar`, so the real photo is not even fetchable
 * from here.
 *
 * No photo means a letter tile, not a broken image. The letter comes from the
 * display name, so an alias teacher gets the alias letter.
 *
 * A plain `<img>` with width and height set, not `next/image`: DESIGN.md
 * section 10 (4G budget, no optimiser round trip).
 */
import { cn } from '@/lib/utils';

export function TeacherAvatar({
  displayName,
  avatarPath,
  size = 56,
  decorative = false,
}: {
  displayName: string;
  avatarPath: string | null;
  size?: number;
  /**
   * True inside a link or a row that already spells the name out. The photo
   * then gets `alt=""`, so a screen reader reads the name once, not twice.
   */
  decorative?: boolean;
}) {
  const shared = 'shrink-0 rounded-full border border-border bg-background object-cover';

  if (avatarPath) {
    return (
      <img
        src={avatarPath}
        alt={decorative ? '' : displayName}
        width={size}
        height={size}
        loading="lazy"
        className={shared}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        shared,
        // A soft primary tint, so the initial reads as a face and not a blank disc.
        'flex items-center justify-center border-primary/20 bg-primary/10 font-bold text-primary',
      )}
      style={{ width: size, height: size, fontSize: Math.round(size / 2.5) }}
    >
      {[...displayName][0] ?? '?'}
    </span>
  );
}
