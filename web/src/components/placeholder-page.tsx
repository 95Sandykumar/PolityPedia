import { DEFAULT_MODE, labels, type LangMode, type MessageKey } from '@/lib/i18n';

export function PlaceholderPage({
  titleKey,
  mode = DEFAULT_MODE,
}: {
  titleKey: MessageKey;
  mode?: LangMode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 font-bold">
        {labels(titleKey, mode).map((s) => (
          <span key={s} className="block">
            {s}
          </span>
        ))}
      </h1>
      <p className="text-muted-foreground">
        {labels('placeholder.soon', mode).join(' / ')}
      </p>
    </section>
  );
}
