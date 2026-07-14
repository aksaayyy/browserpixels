import { useEffect, useState } from 'react';

/**
 * Theme toggle for the Private Image Converter.
 *
 * The initial `.dark` class is applied by the inline no-FOUC script in
 * Layout.astro before paint, so this component only needs to:
 *   - read the current theme from <html>'s classList,
 *   - flip it, persist to localStorage, update `colorScheme`,
 *   - stay in sync with other tabs (storage event) and OS changes (matchMedia).
 */
export default function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Sync local state with whatever the bootstrap script decided at first paint.
  useEffect(() => {
    const root = document.documentElement;
    setIsDark(root.classList.contains('dark'));
    setMounted(true);

    const onChange = () => setIsDark(root.classList.contains('dark'));

    // Other tabs write to localStorage → cross-tab sync.
    window.addEventListener('storage', (e) => {
      if (e.key !== 'theme') return;
      const theme = e.newValue;
      if (theme === 'dark') root.classList.add('dark');
      else root.classList.remove('dark');
      root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
      onChange();
    });

    // OS theme changing while no explicit choice is saved → follow the system.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = (e: MediaQueryListEvent) => {
      if (localStorage.getItem('theme')) return; // user has a saved choice
      if (e.matches) root.classList.add('dark');
      else root.classList.remove('dark');
      root.style.colorScheme = e.matches ? 'dark' : 'light';
      onChange();
    };
    mq.addEventListener('change', onSys);

    return () => {
      window.removeEventListener('storage', onChange);
      mq.removeEventListener('change', onSys);
    };
  }, []);

  const toggle = () => {
    const root = document.documentElement;
    const next = !root.classList.contains('dark');
    root.classList.toggle('dark', next);
    root.style.colorScheme = next ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* private mode / storage disabled — ignore */
    }
    setIsDark(next);
  };

  // Avoid a hydration mismatch: render a stable placeholder until mounted,
  // then swap in the real icon matching the resolved theme.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="group inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-600 transition-colors duration-300 hover:bg-neutral-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
    >
      {/* Both icons always mounted; crossfade via opacity + rotate so the
          transition is smooth rather than a hard swap. */}
      <span className="relative h-5 w-5">
        <svg
          className={[
            'absolute inset-0 h-5 w-5 transition-all duration-300',
            mounted && isDark
              ? 'rotate-90 scale-0 opacity-0'
              : 'rotate-0 scale-100 opacity-100',
          ].join(' ')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
        <svg
          className={[
            'absolute inset-0 h-5 w-5 transition-all duration-300',
            mounted && isDark
              ? 'rotate-0 scale-100 opacity-100'
              : '-rotate-90 scale-0 opacity-0',
          ].join(' ')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </span>
    </button>
  );
}
