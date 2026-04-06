import type { GameState, Power } from '@ruin/engine';

const POWER_LABELS: Record<Power, string> = {
  xarm:   'Xarm',
  gormen: 'Gormen',
  tenzen: 'Tenzen',
  lasha:  'Lasha',
};

interface PowerPanelProps {
  power: Power;
  state: GameState;
  isMe: boolean;
}

export default function PowerPanel({ power, state, isMe }: PowerPanelProps) {
  const ps = state.powers[power];
  if (!ps) return null;

  const isWaiting =
    state.pendingAction !== null && state.pendingAction.waitingFor === power;

  const reserveCount = ps.followers.filter((f) => f.regionId === null).length;
  const boardCount = ps.followers.filter((f) => f.regionId !== null).length;
  const handSize = ps.hand.length;

  return (
    <div
      style={{
        background: '#16213e',
        border: `2px solid`,
        borderColor: isWaiting ? '#facc15' : isMe ? '#818cf8' : '#2d2d5e',
        borderRadius: 6,
        padding: '0.5rem 0.6rem',
        fontSize: '0.8rem',
      }}
      className={`power-border-${power}`}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.3rem',
        }}
      >
        <span className={`power-${power}`} style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          {POWER_LABELS[power]}
          {isMe && <span style={{ color: '#818cf8', marginLeft: '0.4rem', fontWeight: 400 }}>(you)</span>}
        </span>
        {isWaiting && (
          <span style={{ color: '#facc15', fontSize: '0.75rem', fontWeight: 600 }}>ACTING</span>
        )}
        {ps.passedSummoning && !isWaiting && (
          <span style={{ color: '#555', fontSize: '0.75rem' }}>passed</span>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.2rem 0.75rem',
          color: '#ccc',
        }}
      >
        <div><span style={{ color: '#888' }}>VP:</span> {ps.victoryPoints}</div>
        <div><span style={{ color: '#888' }}>PP:</span> {ps.powerPoints}/{ps.basePowerPoints}</div>
        <div><span style={{ color: '#888' }}>Threat:</span> {ps.threatValue}</div>
        <div><span style={{ color: '#888' }}>Dial:</span> {ps.dialPosition}</div>
        <div><span style={{ color: '#888' }}>Board:</span> {boardCount}</div>
        <div><span style={{ color: '#888' }}>Reserve:</span> {reserveCount}</div>
        <div><span style={{ color: '#888' }}>Hand:</span> {handSize}</div>
        <div><span style={{ color: '#888' }}>Disc:</span> {ps.discardIds.length}</div>
      </div>

      {ps.upgradesInPlay.length > 0 && (
        <div style={{ marginTop: '0.3rem', fontSize: '0.73rem', color: '#818cf8' }}>
          Upgrades: {ps.upgradesInPlay.map((u) => u.replace(/_/g, ' ')).join(', ')}
        </div>
      )}
    </div>
  );
}
