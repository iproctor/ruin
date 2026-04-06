import nodemailer from 'nodemailer';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import type { SentMessageInfo } from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

function createTransport(): nodemailer.Transporter<SentMessageInfo> {
  if (process.env['NODE_ENV'] === 'production') {
    const sesClient = new SESClient({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    });

    return nodemailer.createTransport({
      SES: { ses: sesClient, aws: { SendRawEmailCommand } },
    });
  }

  // Dev: ethereal/console fallback — just log
  return nodemailer.createTransport({
    jsonTransport: true,
  });
}

export async function sendEmail({ to, subject, html }: EmailOptions): Promise<void> {
  const from = process.env['EMAIL_FROM'] ?? 'noreply@ruin.game';

  if (process.env['NODE_ENV'] !== 'production') {
    console.log('[email] would send:', { to, subject, from });
    console.log('[email] html preview:', html.slice(0, 200));
    return;
  }

  const transport = createTransport();
  await transport.sendMail({ from, to, subject, html });
}
