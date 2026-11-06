import { Clock } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/student-ui';
import { DEFAULT_MODE, plain, type LangMode, type MessageKey } from '@/lib/i18n';

export function PlaceholderPage({
  titleKey,
  mode = DEFAULT_MODE,
}: {
  titleKey: MessageKey;
  mode?: LangMode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <PageHeader titleKey={titleKey} mode={mode} />
      <EmptyState Icon={Clock} text={plain('placeholder.soon', mode)} />
    </section>
  );
}
