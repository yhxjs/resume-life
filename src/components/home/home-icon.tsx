type HomeIconKind = "interview" | "materials" | "review" | "applications" | "calendar" | "check";

export function HomeIcon({ kind, className = "h-5 w-5" }: { kind: HomeIconKind; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {kind === "interview" && <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H9l-5 3v-6a7.5 7.5 0 1 1 16-4.5Z" /><path d="M8 10h8M8 14h5" /></>}
      {kind === "materials" && <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>}
      {kind === "review" && <><path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15" /><path d="M6 8h3M15 8h3M6 12h3M15 12h3" /></>}
      {kind === "applications" && <><rect x="3" y="6" width="18" height="15" rx="3" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M3 11c6 4 12 4 18 0M10 12v3h4v-3" /></>}
      {kind === "calendar" && <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2" /></>}
      {kind === "check" && <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>}
    </svg>
  );
}
