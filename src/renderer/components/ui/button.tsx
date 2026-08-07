/* eslint-disable react/jsx-props-no-spreading -- Standard shadcn pattern: forward remaining props to underlying elements */
import * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cn } from '@renderer/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white hover:bg-brand/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline:
          'border border-[var(--surface-border)] bg-surface text-foreground hover:bg-surface-hover',
        secondary: 'bg-surface-hover text-foreground hover:bg-surface-selected',
        ghost: 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        link: 'text-foreground underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

// eslint-disable-next-line react-refresh/only-export-components -- Standard shadcn export pattern
export { Button, buttonVariants };
/* eslint-enable react/jsx-props-no-spreading -- Re-enable after shadcn component */
