/**
 * The only door an email could leave through - and it is shut.
 *
 * Nothing in this codebase sends. The email stage calls `send` only when
 * `sendEmails` is true, settings refuse `SEND_EMAILS=true`, and the one
 * transport that exists throws. Tests inject a spy here to prove the gate
 * holds: with sending off, the spy is never called.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export const NO_TRANSPORT: Mailer = {
  async send() {
    throw new Error('no mail transport exists - this pipeline writes drafts only');
  },
};
