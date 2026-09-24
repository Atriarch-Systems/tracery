import { useEffect, useMemo } from 'react';
import { Journal } from '@atriarch-systems/tracery-core';
import { ActivityExplorer, useJournalSource } from '@atriarch-systems/tracery-react';
import { runScenario } from './scenario.js';

export function App() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  const source = useJournalSource(journal);

  useEffect(() => runScenario(journal), [journal]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #262a3a',
          background: '#181b26',
          color: '#e7e9f2',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
        }}
      >
        Tracery embedded example: no hub, no network
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ActivityExplorer source={source} ariaLabel="Tracery embedded example explorer" />
      </div>
    </div>
  );
}
