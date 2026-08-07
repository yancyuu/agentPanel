/**
 * SourceBadge — displays the source of a catalog item.
 */

import { Badge } from '@renderer/components/ui/badge';

interface SourceBadgeProps {
  source: 'official' | 'glama' | string;
}

export const SourceBadge = ({ source }: SourceBadgeProps): React.JSX.Element => {
  if (source === 'official') {
    return (
      <Badge className="border-indigo-500/30 bg-indigo-500/10 text-indigo-400" variant="outline">
        Official
      </Badge>
    );
  }
  if (source === 'glama') {
    return (
      <Badge className="border-zinc-500/30 bg-zinc-500/10 text-zinc-400" variant="outline">
        Glama
      </Badge>
    );
  }
  return (
    <Badge className="border-orange-500/30 bg-orange-500/10 text-orange-400" variant="outline">
      Community
    </Badge>
  );
};
