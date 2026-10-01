import * as React from "react";

import { cn } from "../../lib/utils";
import { campoBase } from "./field-styles";

export type TextareaProps = React.ComponentProps<"textarea">;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(campoBase, "flex min-h-20 resize-y py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export { Textarea };
