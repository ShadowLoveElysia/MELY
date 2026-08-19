import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

interface SectionProps {
  index: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Section({
  index,
  title,
  subtitle,
  children,
  defaultOpen = true,
  open,
  onOpenChange,
}: SectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const resolvedOpen = open ?? internalOpen;

  return (
    <details
      className="settings-section"
      open={resolvedOpen}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (open === undefined) setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <summary>
        <span className="section-index">{index}</span>
        <span className="section-heading">
          <strong>{title}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
        <ChevronDown aria-hidden="true" size={15} />
      </summary>
      <div className="section-content">{children}</div>
    </details>
  );
}
