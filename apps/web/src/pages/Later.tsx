// Placeholder for the optional steps that land in later milestones (18+ in M6, Key Ring in M7).
export function Later({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
