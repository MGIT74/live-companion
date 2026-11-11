import type { ReactNode } from 'react';

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const Icon = {
  home: () => <I><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></I>,
  live: () => <I><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></I>,
  bag: () => <I><path d="M6 7h12l-1 13H7L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></I>,
  users: () => <I><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5" /></I>,
  box: () => <I><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></I>,
  logout: () => <I><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  search: () => <I><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>,
  close: () => <I><path d="M6 6l12 12M18 6 6 18" /></I>,
  next: () => <I><path d="M5 5v14l9-7-9-7Z" /><path d="M19 5v14" /></I>,
  copy: () => <I><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></I>,
  chevron: () => <I size={16}><path d="m9 6 6 6-6 6" /></I>,
  back: () => <I><path d="m15 6-6 6 6 6" /></I>,
  logo: () => <I size={18}><circle cx="12" cy="12" r="3" /><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></I>,
};
