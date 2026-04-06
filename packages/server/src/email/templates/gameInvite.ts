const POWER_NAMES: Record<string, string> = {
  xarm: 'The Xarm Horde',
  gormen: 'The Gormen Plague',
  tenzen: 'The Tenzen Sorcerers',
  lasha: 'The Lasha Seductresses',
};

export function gameInviteEmail(token: string, power: string): string {
  const appUrl = process.env['APP_URL'] ?? 'http://localhost:5173';
  const link = `${appUrl}/join/${token}`;
  const powerName = POWER_NAMES[power] ?? power;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You have been invited to play Ruin</title>
  <style>
    body { font-family: sans-serif; background: #0f0f0f; color: #e8dcc8; margin: 0; padding: 40px 20px; }
    .card { max-width: 480px; margin: 0 auto; background: #1a1410; border: 1px solid #4a3728; border-radius: 8px; padding: 32px; }
    h1 { font-size: 1.5rem; margin-top: 0; color: #c8a96e; }
    .power { display: inline-block; padding: 4px 12px; background: #2e1a0e; border: 1px solid #7c2d12; border-radius: 4px; color: #e8a060; font-weight: bold; font-size: 1rem; margin: 8px 0 16px; }
    p { line-height: 1.6; color: #c4b49a; }
    .btn { display: inline-block; margin: 24px 0; padding: 14px 28px; background: #7c2d12; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold; letter-spacing: 0.05em; }
    .btn:hover { background: #9a3412; }
    .link { word-break: break-all; color: #c8a96e; font-size: 0.85rem; }
    .footer { margin-top: 32px; font-size: 0.8rem; color: #6b5c4c; border-top: 1px solid #2e2018; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You Have Been Called to the Ruin</h1>
    <p>A game of Ruin awaits you. You have been assigned the power:</p>
    <div class="power">${powerName}</div>
    <p>Click the link below to join the game. This invitation expires in 24 hours.</p>
    <a href="${link}" class="btn">Join the Game</a>
    <p>Or copy and paste this URL into your browser:</p>
    <p class="link">${link}</p>
    <div class="footer">
      If you were not expecting this invitation, you can safely ignore this email.
    </div>
  </div>
</body>
</html>
  `.trim();
}
