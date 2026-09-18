import { useEffect, useState } from 'react';
import { fetchHubInfo } from './info.js';

const KO_FI_URL = 'https://ko-fi.com/demonslyr';
// `atriarch-systems/tracery` is this repo's intended future GitHub
// location (see README.md "Quick start: Claude Code plugin"); update here
// alongside that once it actually lives there.
const DOCS_URL = 'https://github.com/atriarch-systems/tracery';

/**
 * Static, non-dismissible footer for the hosted UI. Checks `GET /v1/info`
 * once on mount (task: "local mode" -- `edition` there is the same
 * "is an extensions module reporting a license" check `HubContext.isLicensed()`
 * makes, but a single call the rest of the hosted UI already needs for the
 * auth-mode check in `App.tsx`): the community edition gets a low-key Ko-fi
 * tip-jar link next to a Docs link; a licensed deployment (Tracery Cloud, or
 * a self-hosted extensions module reporting `isLicensed()`) gets a
 * white-label footer with just the product name (no tip-jar link) -- see
 * `docs/CLOUD.md`.
 */
export function Footer() {
  const [licensed, setLicensed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchHubInfo().then((info) => {
      if (!cancelled) setLicensed(info?.edition === 'licensed');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer
      data-testid="hub-footer"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        flex: '0 0 auto',
        padding: '6px 12px',
        borderTop: '1px solid #262a3a',
        background: 'var(--tracery-bg, #12141c)',
        color: 'var(--tracery-muted, #8892a6)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 11,
      }}
    >
      <span>Tracery by Atriarch Systems</span>
      {!licensed && (
        <a
          data-testid="hub-footer-kofi"
          href={KO_FI_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--tracery-accent, #7c9cff)' }}
        >
          ☕ Buy me a coffee
        </a>
      )}
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--tracery-accent, #7c9cff)' }}>
        Docs
      </a>
    </footer>
  );
}
