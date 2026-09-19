import { useMemo, useRef, useState } from 'react';
import { Journal } from '@atriarch/tracery-core';
import type { ActivityEvent } from '@atriarch/tracery-core';
import { ActivityExplorer, useJournalSource } from '@atriarch/tracery-react';
import { SCENARIOS, runSchedule, rootFlowId, type Scenario } from './scenarios.js';
import { sendToHub } from './sendToHub.js';

const inputStyle: React.CSSProperties = { padding: '4px 6px', borderRadius: 4, border: '1px solid #262a3a', background: '#12141c', color: '#e7e9f2', fontSize: 12 };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#8892a6' };

export function App() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  const source = useJournalSource(journal);

  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0]!.id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) as Scenario;

  const [sendToHubEnabled, setSendToHubEnabled] = useState(false);
  const [hubUrl, setHubUrl] = useState('http://127.0.0.1:8971');
  const [apiKey, setApiKey] = useState('');
  const [workspace, setWorkspace] = useState('default');

  const [running, setRunning] = useState(false);
  const [hubStatus, setHubStatus] = useState<string | null>(null);
  const [openLink, setOpenLink] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  function generate() {
    stopRef.current?.();
    setHubStatus(null);
    setOpenLink(null);
    setRunning(true);

    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const schedule = scenario.build(runId);
    let sentAny = false;

    const stop = runSchedule(schedule, (events: readonly ActivityEvent[]) => {
      journal.append(events);
      if (sendToHubEnabled && hubUrl.trim()) {
        sendToHub(hubUrl, apiKey, workspace, events).then((result) => {
          if (!result.ok) {
            setHubStatus(`hub: ${result.detail}`);
            return;
          }
          sentAny = true;
          setHubStatus(`hub: ${result.detail}`);
          setOpenLink(`${hubUrl.replace(/\/+$/, '')}/ui/flows/${encodeURIComponent(rootFlowId(scenario.id, runId))}`);
        });
      }
    });
    stopRef.current = stop;

    setTimeout(() => {
      setRunning(false);
      if (sendToHubEnabled && !sentAny) setHubStatus((s) => s ?? 'hub: no events were sent -- check "Also send to a hub" is on and the hub URL is correct');
    }, scenario.durationMs + 300);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'system-ui, sans-serif', color: '#e7e9f2' }}>
      <header style={{ padding: '10px 16px', borderBottom: '1px solid #262a3a', background: '#181b26' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tracery event generator</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <label style={labelStyle}>
            Sample flow
            <select data-testid="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={inputStyle}>
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          <button data-testid="generate-button" type="button" onClick={generate} style={{ ...inputStyle, cursor: 'pointer', padding: '6px 14px', background: '#2a3550', border: '1px solid #3b4a72' }}>
            {running ? 'Generating…' : 'Generate'}
          </button>
          <span style={{ fontSize: 11, color: '#5c6479', maxWidth: 360 }}>{scenario.description}</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid #1c2030' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8892a6' }}>
            <input data-testid="send-to-hub-checkbox" type="checkbox" checked={sendToHubEnabled} onChange={(e) => setSendToHubEnabled(e.target.checked)} />
            Also send to a hub
          </label>
          <label style={labelStyle}>
            Hub URL
            <input data-testid="hub-url-input" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} disabled={!sendToHubEnabled} style={{ ...inputStyle, width: 220 }} />
          </label>
          <label style={labelStyle}>
            API key (optional -- only against a hub with TRACERY_API_KEYS set)
            <input data-testid="hub-key-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={!sendToHubEnabled} style={{ ...inputStyle, width: 180 }} />
          </label>
          <label style={labelStyle}>
            Workspace
            <input data-testid="hub-workspace-input" value={workspace} onChange={(e) => setWorkspace(e.target.value)} disabled={!sendToHubEnabled} style={{ ...inputStyle, width: 100 }} />
          </label>
          {hubStatus && (
            <span data-testid="hub-status" style={{ fontSize: 11, color: hubStatus.includes('accepted') ? '#7dd88a' : '#e0a45c' }}>
              {hubStatus}
            </span>
          )}
          {openLink && (
            <a data-testid="open-in-hub-link" href={openLink} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#7ea6ff' }}>
              Open in hub ↗
            </a>
          )}
        </div>
      </header>

      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ActivityExplorer source={source} ariaLabel="Tracery event generator explorer" />
      </div>
    </div>
  );
}
