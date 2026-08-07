/* eslint-disable react/jsx-props-no-spreading -- Standard shadcn pattern: forward remaining props to underlying elements */
import * as React from 'react';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@renderer/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-h-[min(80vh,24rem)] min-h-0 w-72 overflow-y-auto overflow-x-hidden rounded-lg border border-[var(--surface-border)] bg-surface-raised p-4 text-foreground shadow-floating outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
/* eslint-enable react/jsx-props-no-spreading -- Re-enable after shadcn component */
