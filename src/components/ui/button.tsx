import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // The two Naboo buttons from the design system. They press rather than change
        // colour, and they take a navy focus outline rather than the browser's blue —
        // stated here once so no page has to re-derive it in a className.
        naboo:
          "border-0 bg-naboo font-semibold text-navy hover:bg-naboo-hover active:scale-[0.97] focus-visible:[outline:2px_solid_#101F34]! focus-visible:outline-offset-2 focus-visible:ring-0",
        "naboo-ghost":
          "border border-slate-300 bg-white font-medium text-navy shadow-[0_1px_2px_rgba(16,31,52,0.06)] hover:bg-slate-50 active:scale-[0.97] focus-visible:[outline:2px_solid_#101F34]! focus-visible:outline-offset-2 focus-visible:ring-0",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        /** The design system's own two heights: 32px, and 30px inside a queue card. */
        naboo: "h-8 gap-1.5 rounded-md px-3 text-[12px]",
        "naboo-sm": "h-[30px] gap-1.5 rounded-md px-3 text-[12px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
