/**
 * One YouTube thumbnail (issue 08-videos-tile).
 *
 * DESIGN.md section 10 (B4): a PLAIN `<img loading="lazy">` with width and
 * height set. Not `next/image`: these files live on `i.ytimg.com`, they are
 * already the right size, and the optimiser would add a hop and a cost for
 * nothing. Width and height are what stop the list jumping while a thumbnail
 * loads on 4G.
 *
 * 480 x 360 is the real pixel size of `hqdefault.jpg`, so the browser reserves
 * the right box. CSS makes it fluid; the attributes only set the ratio.
 *
 * `alt=""` on purpose: the title sits next to the image as real text, so a
 * screen reader would otherwise read the same words twice.
 */

/** The real pixel size of `hqdefault.jpg`. */
export const THUMB_WIDTH = 480;
export const THUMB_HEIGHT = 360;

export function VideoThumb({ src }: { src: string | null }) {
  if (!src) {
    // No stored thumbnail: hold the same box, so the row keeps its shape.
    return (
      <div
        aria-hidden="true"
        className="aspect-video w-full rounded-[10px] border border-border bg-muted"
      />
    );
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      width={THUMB_WIDTH}
      height={THUMB_HEIGHT}
      className="aspect-video w-full rounded-[10px] border border-border bg-muted object-cover"
    />
  );
}
