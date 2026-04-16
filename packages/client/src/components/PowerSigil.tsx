import type { Power } from '@ruin/engine';

export function PowerSigil({ power, size = 44 }: { power: Power; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
  switch (power) {
    case 'xarm':
      return (
        <svg {...common}>
          <path
            d="M 16 3 C 16 3, 6.5 14, 6.5 20 C 6.5 24.7, 10.5 28, 16 28 C 21.5 28, 25.5 24.7, 25.5 20 C 25.5 14, 16 3, 16 3 Z"
            stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.2"
          />
          <path
            d="M 16 13 C 16 13, 11.8 17.5, 11.8 20.8 C 11.8 23, 13.6 24.3, 16 24.3 C 18.4 24.3, 20.2 23, 20.2 20.8 C 20.2 17.5, 16 13, 16 13 Z"
            fill="currentColor"
            opacity="0.55"
          />
        </svg>
      );
    case 'gormen':
      return (
        <svg {...common}>
          <circle cx="16" cy="10" r="5" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.12" />
          <circle cx="22" cy="16" r="5" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.12" />
          <circle cx="16" cy="22" r="5" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.12" />
          <circle cx="10" cy="16" r="5" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.12" />
          <circle cx="16" cy="10" r="1.1" fill="currentColor" />
          <circle cx="22" cy="16" r="1.1" fill="currentColor" />
          <circle cx="16" cy="22" r="1.1" fill="currentColor" />
          <circle cx="10" cy="16" r="1.1" fill="currentColor" />
        </svg>
      );
    case 'tenzen':
      return (
        <svg {...common}>
          {Array.from({ length: 9 }).map((_, i) => {
            const a = (i / 9) * Math.PI * 2 - Math.PI / 2;
            const x = 16 + Math.cos(a) * 12;
            const y = 16 + Math.sin(a) * 12;
            return <line key={i} x1="16" y1="16" x2={x} y2={y} stroke="currentColor" strokeWidth="1.1" />;
          })}
          <circle cx="16" cy="16" r="3.4" fill="currentColor" opacity="0.18" />
          <circle cx="16" cy="16" r="3.4" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="16" cy="16" r="1.1" fill="currentColor" />
        </svg>
      );
    case 'lasha':
      return (
        <svg {...common}>
          <circle cx="16" cy="9" r="2.6" stroke="currentColor" strokeWidth="1.3" fill="currentColor" fillOpacity="0.18" />
          <circle cx="16" cy="9" r="0.8" fill="currentColor" />
          <path d="M 10.5 13 Q 16 18.5 21.5 13" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <line x1="16" y1="15.8" x2="16" y2="26" stroke="currentColor" strokeWidth="1.3" />
          <line x1="11" y1="22" x2="21" y2="22" stroke="currentColor" strokeWidth="1.3" />
          <line x1="11" y1="22" x2="10" y2="23" stroke="currentColor" strokeWidth="1" />
          <line x1="21" y1="22" x2="22" y2="23" stroke="currentColor" strokeWidth="1" />
        </svg>
      );
  }
}
