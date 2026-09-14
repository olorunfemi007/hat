export default function Loading() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-8">
      <span className="sr-only">Loading&hellip;</span>
      <div aria-hidden="true" className="space-y-3">
        <div className="loading-skeleton h-9 w-48" />
        <div className="loading-skeleton h-4 w-64 max-w-full" />
      </div>
      <div aria-hidden="true" className="overview-grid">
        {[0, 1, 2, 3].map((i) => <div key={i} className="surface h-44 p-6"><div className="loading-skeleton h-full" /></div>)}
      </div>
      <div aria-hidden="true" className="surface h-64 p-6"><div className="loading-skeleton h-full" /></div>
    </div>
  );
}
