import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

interface SectionProps {
  index: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function Section({ index, title, subtitle, children, defaultOpen = true }: SectionProps) {
  return (
    <details className="settings-section" open={defaultOpen}>
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
