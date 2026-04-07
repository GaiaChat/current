import type { PropsWithChildren } from 'react';

export function SectionCard({ children, title }: PropsWithChildren<{ title: string }>) {
  return (
    <section className="current-section-card">
      <header>{title}</header>
      <div>{children}</div>
    </section>
  );
}

export function Pill({ children }: PropsWithChildren) {
  return <span className="current-pill">{children}</span>;
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="current-stat">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
