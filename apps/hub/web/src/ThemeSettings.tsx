import { useState } from 'react';
import { PRESET_NAMES } from '@atriarch-systems/tracery-react';
import { resolveActivityTheme, type ThemeChoice } from './theme-storage.js';

export interface ThemeSettingsProps {
  readonly choice: ThemeChoice;
  readonly onChange: (choice: ThemeChoice) => void;
}

const buttonStyle = { background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' } as const;

/**
 * Gear-icon button + popover panel (this app's no-framework inline-style
 * convention, see `Footer.tsx`): a preset picker plus a handful of
 * highest-impact color overrides, matching `docs/PLAN.md` workstream's
 * settings-UI ask. Only touches `App.tsx`'s own explorer header -- never
 * `SharePage.tsx`/`Viewer.tsx` (a share/export view should look like what
 * the sharer intended, not what the viewer's browser happens to have saved).
 */
export function ThemeSettings({ choice, onChange }: ThemeSettingsProps) {
  const [open, setOpen] = useState(false);
  const resolved = resolveActivityTheme(choice);

  const setOverride = (field: keyof NonNullable<ThemeChoice['overrides']>, value: string): void => {
    onChange({ preset: choice.preset, overrides: { ...choice.overrides, [field]: value } });
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="theme-settings-button"
        aria-label="Theme settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={buttonStyle}
      >
        ⚙
      </button>
      {open && (
        <div
          data-testid="theme-settings-panel"
          role="dialog"
          aria-label="Theme settings"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: 220,
            padding: 12,
            background: '#181b26',
            color: '#e7e9f2',
            border: '1px solid #262a3a',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            fontSize: 12,
            zIndex: 20,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            Preset
            <select
              data-testid="theme-preset-select"
              value={choice.preset}
              onChange={(e) => onChange({ preset: e.target.value })}
              style={{ background: '#12141c', color: 'inherit', border: '1px solid #262a3a', borderRadius: 4, padding: '4px 6px' }}
            >
              {PRESET_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ColorField label="Accent" testId="theme-color-accent" value={resolved.accent ?? '#7c9cff'} onChange={(v) => setOverride('accent', v)} />
            <ColorField label="Error" testId="theme-color-error" value={resolved.error ?? '#ff6b6b'} onChange={(v) => setOverride('error', v)} />
            <ColorField
              label="Node highlight"
              testId="theme-color-node-highlight"
              value={resolved.graph?.nodeFillActive ?? '#17251d'}
              onChange={(v) => setOverride('graphNodeFillActive', v)}
            />
            <ColorField
              label="Edge / graph accent"
              testId="theme-color-edge-accent"
              value={resolved.graph?.edgeAccentFallback ?? '#8bb971'}
              onChange={(v) => setOverride('graphEdgeAccentFallback', v)}
            />
          </div>

          <button type="button" data-testid="theme-reset" onClick={() => onChange({ preset: choice.preset })} style={buttonStyle}>
            Reset to preset
          </button>
        </div>
      )}
    </div>
  );
}

function ColorField({ label, testId, value, onChange }: { readonly label: string; readonly testId: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span>{label}</span>
      <input data-testid={testId} type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 32, height: 22, padding: 0, border: '1px solid #262a3a', borderRadius: 4, background: 'transparent' }} />
    </label>
  );
}
