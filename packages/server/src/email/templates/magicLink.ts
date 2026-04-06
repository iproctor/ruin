export function magicLinkEmail(token: string): string {
  const appUrl = process.env['APP_URL'] ?? 'http://localhost:5173';
  const link = `${appUrl}/join/${token}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Ruin sign-in link</title>
  <style>
    body { font-family: sans-serif; background: #0f0f0f; color: #e8dcc8; margin: 0; padding: 40px 20px; }
    .card { max-width: 480px; margin: 0 auto; background: #1a1410; border: 1px solid #4a3728; border-radius: 8px; padding: 32px; }
    h1 { font-size: 1.5rem; margin-top: 0; color: #c8a96e; }
    p { line-height: 1.6; color: #c4b49a; }
    .btn { display: inline-block; margin: 24px 0; padding: 14px 28px; background: #7c2d12; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold; letter-spacing: 0.05em; }
    .btn:hover { background: #9a3412; }
    .link { word-break: break-all; color: #c8a96e; font-size: 0.85rem; }
    .footer { margin-top: 32px; font-size: 0.8rem; color: #6b5c4c; border-top: 1px solid #2e2018; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Enter the Ruin</h1>
    <p>Click the link below to sign in. This link expires in 24 hours and can only be used once.</p>
    <a href="${link}" class="btn">Sign In to Ruin</a>
    <p>Or copy and paste this URL into your browser:</p>
    <p class="link">${link}</p>
    <div class="footer">
      If you did not request this link, you can safely ignore this email.
    </div>
  </div>
</body>
</html>
  `.trim();
}
